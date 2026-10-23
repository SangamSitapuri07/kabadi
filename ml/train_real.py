#!/usr/bin/env python3
"""
Kabadiwala Connect — REAL-DATA Training & Honest Benchmark
==========================================================
Trains a 2D CNN on **2,527 genuine photographs** from the TrashNet dataset
(`ml/download_real_dataset.py`) and exports `apps/api/models/real_trashnet_cnn_v1.onnx`.

Unlike the synthetic pretraining in `ml/train_all.py`, every sample here is a real
camera photo. Accuracy is reported on a **held-out 20% split of real photos** and is
additionally compared against an identical-architecture random-weight control, so
the number reflects genuine generalisation rather than memorised textures.

Class order (fixed, consumed by `apps/api/src/modules/ai/onnx.engine.ts`):
    0 cardboard · 1 glass · 2 metal · 3 paper · 4 plastic · 5 trash

Run:
    python3 ml/download_real_dataset.py
    python3 ml/train_real.py
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import tempfile
import time
from typing import Dict, List, Tuple

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper
from PIL import Image

import train_all as T

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODELS = ROOT / "apps" / "api" / "models"
DATA = ROOT / "ml" / "datasets" / "real" / "trashnet"

CLASSES = ["cardboard", "glass", "metal", "paper", "plastic", "trash"]
RESIZE = 72     # pre-resize edge for random 64×64 crops
SIDE = 64
RNG = np.random.default_rng(424242)
EPOCHS = 24
BATCH = 48
LR = 3.0e-3


# ─────────────────────────────────────────────────────────────────────────────
# Data loading & real-photo augmentation
# ─────────────────────────────────────────────────────────────────────────────
def load_real_photos() -> Tuple[np.ndarray, np.ndarray]:
    xs: List[np.ndarray] = []
    ys: List[int] = []
    for idx, cls in enumerate(CLASSES):
        cls_dir = DATA / cls
        if not cls_dir.exists():
            raise SystemExit(
                f"Missing {cls_dir}. Run `python3 ml/download_real_dataset.py` first."
            )
        files = sorted(list(cls_dir.glob("*.jpg")) + list(cls_dir.glob("*.png")))
        for p in files:
            try:
                im = Image.open(p).convert("RGB").resize((RESIZE, RESIZE), Image.Resampling.BILINEAR)
                xs.append(np.asarray(im, dtype=np.uint8))
                ys.append(idx)
            except Exception:
                continue
    X = np.stack(xs)  # (N, 72, 72, 3) uint8
    Y = np.array(ys, dtype=np.int64)
    return X, Y


def augment_batch(X: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Random 64×64 crop + horizontal flip + brightness/contrast jitter (NCHW float32)."""
    n = X.shape[0]
    offs_y = rng.integers(0, RESIZE - SIDE + 1, size=n)
    offs_x = rng.integers(0, RESIZE - SIDE + 1, size=n)
    out = np.empty((n, 3, SIDE, SIDE), dtype=np.float32)
    for i in range(n):
        crop = X[i, offs_y[i] : offs_y[i] + SIDE, offs_x[i] : offs_x[i] + SIDE, :].astype(np.float32)
        if rng.random() < 0.5:
            crop = crop[:, ::-1, :]
        contrast = 1.0 + float(rng.uniform(-0.25, 0.25))
        brightness = float(rng.uniform(-26, 26))
        crop = np.clip((crop - 128.0) * contrast + 128.0 + brightness, 0.0, 255.0)
        arr = crop / 255.0
        if rng.random() < 0.25:
            arr = np.clip(arr + rng.normal(0.0, 0.02, arr.shape).astype(np.float32), 0.0, 1.0)
        out[i] = arr.transpose(2, 0, 1)
    return out


def eval_batch(X: np.ndarray) -> np.ndarray:
    """Centre crop for deterministic evaluation (NCHW float32)."""
    off = (RESIZE - SIDE) // 2
    n = X.shape[0]
    out = np.empty((n, 3, SIDE, SIDE), dtype=np.float32)
    for i in range(n):
        crop = X[i, off : off + SIDE, off : off + SIDE, :].astype(np.float32)
        out[i] = (crop / 255.0).transpose(2, 0, 1)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Training
# ─────────────────────────────────────────────────────────────────────────────
def train() -> Dict[str, object]:
    X, Y = load_real_photos()
    print(f"Loaded {len(Y)} REAL photographs across {len(CLASSES)} classes: "
          f"{ {c: int((Y == i).sum()) for i, c in enumerate(CLASSES)} }")

    # Stratified 80/20 split per class
    tr_idx: List[int] = []
    va_idx: List[int] = []
    for c in range(len(CLASSES)):
        ids = np.where(Y == c)[0]
        RNG.shuffle(ids)
        cut = max(1, int(round(len(ids) * 0.80)))
        tr_idx.extend(ids[:cut].tolist())
        va_idx.extend(ids[cut:].tolist())
    RNG.shuffle(tr_idx)
    RNG.shuffle(va_idx)

    X_tr, Y_tr = X[tr_idx], Y[tr_idx]
    X_va, Y_va = X[va_idx], Y[va_idx]
    print(f"Train {len(Y_tr)} real photos · Held-out test {len(Y_va)} real photos")

    conv1 = T.Conv3x3Pad1(3, 16, RNG)
    relu1, pool1 = T.Relu(), T.MaxPool2x2()
    conv2 = T.Conv3x3Pad1(16, 32, RNG)
    relu2, pool2 = T.Relu(), T.MaxPool2x2()
    conv3 = T.Conv3x3Pad1(32, 48, RNG)
    relu3, pool3 = T.Relu(), T.MaxPool2x2()
    fc1 = T.Dense(48, 64, RNG)
    relu4 = T.Relu()
    fc2 = T.Dense(64, len(CLASSES), RNG)
    opt = T.AdamOptimizer(lr=LR)

    t0 = time.time()
    for epoch in range(EPOCHS):
        p = RNG.permutation(len(Y_tr))
        epoch_loss, correct, seen = 0.0, 0, 0
        for i in range(0, len(Y_tr), BATCH):
            ids = p[i : i + BATCH]
            xb = augment_batch(X_tr[ids], RNG)
            yb = Y_tr[ids]
            h1 = pool1.forward(relu1.forward(conv1.forward(xb)))     # (B,16,32,32)
            h2 = pool2.forward(relu2.forward(conv2.forward(h1)))     # (B,32,16,16)
            h3 = pool3.forward(relu3.forward(conv3.forward(h2)))     # (B,48,8,8)
            gap = h3.mean(axis=(2, 3))                               # (B,48)
            h4 = relu4.forward(fc1.forward(gap))
            logits = fc2.forward(h4)
            loss, dlogits, probs = T.softmax_ce_loss(logits, yb)
            epoch_loss += loss * len(ids)
            correct += int((probs.argmax(axis=1) == yb).sum())
            seen += len(ids)

            dh4 = fc2.backward(dlogits)
            dgap = fc1.backward(relu4.backward(dh4))
            dh3 = np.broadcast_to(dgap[:, :, None, None] / 64.0, h3.shape).astype(np.float32)
            dh2 = conv3.backward(relu3.backward(pool3.backward(dh3)))
            dh1 = conv2.backward(relu2.backward(pool2.backward(dh2)))
            conv1.backward(relu1.backward(pool1.backward(dh1)))
            opt.step(
                conv1.params_and_grads() + conv2.params_and_grads() + conv3.params_and_grads()
                + fc1.params_and_grads() + fc2.params_and_grads()
            )

        if epoch == int(EPOCHS * 0.66):
            opt.lr *= 0.4
        if epoch == int(EPOCHS * 0.85):
            opt.lr *= 0.4

        # Held-out REAL-photo accuracy each epoch
        va_logits = run_inference_numpy(conv1, relu1, pool1, conv2, relu2, pool2, conv3, relu3, pool3, fc1, relu4, fc2, X_va, Y_va)
        acc = float((va_logits.argmax(axis=1) == Y_va).mean())
        print(f"[epoch {epoch + 1:02d}/{EPOCHS}] train_loss={epoch_loss / max(1, seen):.4f} "
              f"train_acc={correct / max(1, seen):.4f} REAL_heldout_acc={acc:.4f} "
              f"({time.time() - t0:.0f}s)")

    graph = helper.make_graph(
        nodes=[
            helper.make_node("Conv", ["input_rgb", "c1w", "c1b"], ["c1"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]),
            helper.make_node("Relu", ["c1"], ["r1"]),
            helper.make_node("MaxPool", ["r1"], ["p1"], kernel_shape=[2, 2], strides=[2, 2]),
            helper.make_node("Conv", ["p1", "c2w", "c2b"], ["c2"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]),
            helper.make_node("Relu", ["c2"], ["r2"]),
            helper.make_node("MaxPool", ["r2"], ["p2"], kernel_shape=[2, 2], strides=[2, 2]),
            helper.make_node("Conv", ["p2", "c3w", "c3b"], ["c3"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]),
            helper.make_node("Relu", ["c3"], ["r3"]),
            helper.make_node("MaxPool", ["r3"], ["p3"], kernel_shape=[2, 2], strides=[2, 2]),
            helper.make_node("GlobalAveragePool", ["p3"], ["gap"]),
            helper.make_node("Flatten", ["gap"], ["flat"], axis=1),
            helper.make_node("Gemm", ["flat", "f1w", "f1b"], ["g1"]),
            helper.make_node("Relu", ["g1"], ["rg1"]),
            helper.make_node("Gemm", ["rg1", "f2w", "f2b"], ["logits"]),
            helper.make_node("Softmax", ["logits"], ["probabilities"], axis=1),
        ],
        name="KabadiwalaRealTrashnetCNNv1",
        inputs=[helper.make_tensor_value_info("input_rgb", TensorProto.FLOAT, ["batch", 3, SIDE, SIDE])],
        outputs=[helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, ["batch", len(CLASSES)])],
        initializer=[
            numpy_helper.from_array(conv1.W, "c1w"), numpy_helper.from_array(conv1.b, "c1b"),
            numpy_helper.from_array(conv2.W, "c2w"), numpy_helper.from_array(conv2.b, "c2b"),
            numpy_helper.from_array(conv3.W, "c3w"), numpy_helper.from_array(conv3.b, "c3b"),
            numpy_helper.from_array(fc1.W, "f1w"), numpy_helper.from_array(fc1.b, "f1b"),
            numpy_helper.from_array(fc2.W, "f2w"), numpy_helper.from_array(fc2.b, "f2b"),
        ],
    )
    model = helper.make_model(graph, producer_name="kabadiwala-real-data-suite",
                              opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    out_path = MODELS / "real_trashnet_cnn_v1.onnx"
    onnx.save(model, str(out_path))

    # ── Honest real-photo evaluation ─────────────────────────────────────────
    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    va_x = eval_batch(X_va)
    probs = sess.run(["probabilities"], {"input_rgb": va_x})[0]
    pred = probs.argmax(axis=1)
    heldout_acc = float((pred == Y_va).mean())

    per_class = {}
    for c, cls in enumerate(CLASSES):
        mask = Y_va == c
        if mask.sum() == 0:
            continue
        per_class[cls] = {
            "support": int(mask.sum()),
            "recall": round(float((pred[mask] == c).mean()), 4),
            "precision": round(float((Y_va[pred == c] == c).mean()) if (pred == c).sum() else 0.0, 4),
        }
    confusion = np.zeros((len(CLASSES), len(CLASSES)), dtype=int)
    for t, p_ in zip(Y_va, pred):
        confusion[int(t), int(p_)] += 1

    # Random-weight control (same graph, noise weights)
    with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as tmp:
        rand_path = pathlib.Path(tmp.name)
    ctrl = onnx.load(str(out_path))
    originals = list(ctrl.graph.initializer)
    del ctrl.graph.initializer[:]
    for init in originals:
        arr = numpy_helper.to_array(init)
        ctrl.graph.initializer.append(
            numpy_helper.from_array(
                (RNG.standard_normal(arr.shape) * 0.05).astype(np.float32), init.name
            )
        )
    onnx.save(ctrl, str(rand_path))
    rnd = ort.InferenceSession(str(rand_path), providers=["CPUExecutionProvider"])
    rand_acc = float((rnd.run(["probabilities"], {"input_rgb": va_x})[0].argmax(axis=1) == Y_va).mean())
    rand_path.unlink(missing_ok=True)

    raw = out_path.read_bytes()
    benchmark = {
        "model": out_path.name,
        "trainedOn": "REAL_PHOTOS",
        "dataset": "TrashNet (garythung/trashnet, MIT) — 2,527 real 512x384 photographs",
        "classes": CLASSES,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "totalRealPhotos": int(len(Y)),
        "trainPhotos": int(len(Y_tr)),
        "heldoutRealPhotos": int(len(Y_va)),
        "heldoutAccuracy": round(heldout_acc, 4),
        "randomWeightsHeldoutAccuracy": round(rand_acc, 4),
        "liftOverRandomPts": round((heldout_acc - rand_acc) * 100, 2),
        "perClass": per_class,
        "confusionMatrix": confusion.tolist(),
        "trainingSeconds": round(time.time() - t0, 1),
        "honestNote": (
            "Accuracy is measured on real photographs withheld from training. "
            "TrashNet objects sit on a plain white background, so glass/plastic separation "
            "remains the hardest pair; field accuracy on cluttered scrap-yard photos will be lower."
        ),
    }
    (MODELS / "real_data_benchmark.json").write_text(json.dumps(benchmark, indent=2))

    manifest_path = MODELS / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest.setdefault("realDataModels", {})["realTrashnetCnn"] = benchmark
    manifest_path.write_text(json.dumps(manifest, indent=2))

    print(json.dumps({k: benchmark[k] for k in (
        "model", "heldoutRealPhotos", "heldoutAccuracy", "randomWeightsHeldoutAccuracy",
        "liftOverRandomPts", "sha256", "trainingSeconds")}, indent=2))
    print("Per-class (real held-out):", json.dumps(per_class, indent=2))
    return benchmark


def run_inference_numpy(conv1, relu1, pool1, conv2, relu2, pool2, conv3, relu3, pool3,
                        fc1, relu4, fc2, X_va: np.ndarray, Y_va: np.ndarray) -> np.ndarray:
    """Epoch-end validation without an ORT round-trip (uses eval-mode centre crops)."""
    logits_all = []
    for i in range(0, len(Y_va), 96):
        xb = eval_batch(X_va[i : i + 96])
        h1 = pool1.forward(relu1.forward(conv1.forward(xb)))
        h2 = pool2.forward(relu2.forward(conv2.forward(h1)))
        h3 = pool3.forward(relu3.forward(conv3.forward(h2)))
        gap = h3.mean(axis=(2, 3))
        logits_all.append(fc2.forward(relu4.forward(fc1.forward(gap))))
    return np.concatenate(logits_all, axis=0)


if __name__ == "__main__":
    train()
