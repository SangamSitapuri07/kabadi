#!/usr/bin/env python3
"""
Kabadiwala Connect — Trained-vs-Untrained Verification Harness
==============================================================
Proves that `ml/train_all.py` genuinely LEARNED weights (rather than shipping
hand-written or randomly initialised coefficients).

Method
------
For every exported model we generate a FRESH held-out batch that was never seen
during training (new RNG seed, new augmentations), then evaluate twice:
  1. the trained `.onnx` weights on disk
  2. an identical-architecture CONTROL where every float initializer is
     replaced with random Gaussian noise (same shapes, same graph)

If learning really happened, the trained model must clearly beat the random
control and the theoretical chance level. Run: python3 ml/verify_training.py
"""

from __future__ import annotations

import json
import math
import tempfile
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import numpy_helper

import train_all as T

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "apps" / "api" / "models"
VERIFY_RNG = np.random.default_rng(987654321)


def randomize_and_save(src: Path, dst: Path, scale: float = 0.05) -> None:
    """Copy graph, replace every float initializer with N(0, scale) noise."""
    model = onnx.load(str(src))
    new_inits = []
    for init in model.graph.initializer:
        arr = numpy_helper.to_array(init)
        if arr.dtype == np.float32:
            noise = (VERIFY_RNG.standard_normal(arr.shape) * scale).astype(np.float32)
            new_inits.append(numpy_helper.from_array(noise, init.name))
        else:
            new_inits.append(init)
    del model.graph.initializer[:]
    model.graph.initializer.extend(new_inits)
    onnx.save(model, str(dst))


def accuracy(session, input_name, outputs, x, y) -> float:
    preds = session.run(outputs, {input_name: x})[0]
    return float((preds.argmax(axis=1) == y).mean())


def head_to_head(name: str, model_file: str, x, y, classes: int, scale: float) -> dict:
    src = MODELS / model_file
    sess = ort.InferenceSession(str(src), providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name

    with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as tmp:
        rand_path = Path(tmp.name)
    randomize_and_save(src, rand_path, scale)
    rnd = ort.InferenceSession(str(rand_path), providers=["CPUExecutionProvider"])

    trained_acc = accuracy(sess, in_name, [out_name], x, y)
    random_acc = accuracy(rnd, in_name, [out_name], x, y)
    rand_path.unlink(missing_ok=True)

    return {
        "model": name,
        "file": model_file,
        "samples": int(len(y)),
        "chancePct": round(100.0 / classes, 2),
        "randomWeightsAccPct": round(random_acc * 100, 2),
        "trainedAccPct": round(trained_acc * 100, 2),
        "liftOverRandomPct": round((trained_acc - random_acc) * 100, 2),
    }


def main() -> None:
    rows = []

    # ── 1. Scrap Vision 2D CNN ───────────────────────────────────────────────
    xs, ys = [], []
    for c in range(len(T.SCRAP_CLASSES)):
        for _ in range(40):
            xs.append(T.render_scrap_patch_64(c, VERIFY_RNG))
            ys.append(c)
    rows.append(
        head_to_head(
            "scrap_vision_cnn_v2",
            "scrap_vision_cnn_v2.onnx",
            np.stack(xs),
            np.array(ys, dtype=np.int64),
            len(T.SCRAP_CLASSES),
            0.05,
        )
    )

    # ── 2. Multi-task Device X-Ray CNN (device + coil heads) ─────────────────
    xs, yd, yc = [], [], []
    for d in range(len(T.XRAY_CLASSES)):
        for _ in range(40):
            cond = int(VERIFY_RNG.integers(0, 4))
            im, coil = T.render_appliance_xray_photo_64(d, cond, VERIFY_RNG)
            xs.append(im)
            yd.append(d)
            yc.append(coil)
    X = np.stack(xs)
    src = MODELS / "device_xray_cnn_v2.onnx"
    sess = ort.InferenceSession(str(src), providers=["CPUExecutionProvider"])
    dev_t = accuracy(sess, "input_rgb", ["device_probs"], X, np.array(yd))
    coil_t = accuracy(sess, "input_rgb", ["coil_probs"], X, np.array(yc))
    with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as tmp:
        rand_path = Path(tmp.name)
    randomize_and_save(src, rand_path, 0.05)
    rnd = ort.InferenceSession(str(rand_path), providers=["CPUExecutionProvider"])
    dev_r = accuracy(rnd, "input_rgb", ["device_probs"], X, np.array(yd))
    coil_r = accuracy(rnd, "input_rgb", ["coil_probs"], X, np.array(yc))
    rand_path.unlink(missing_ok=True)
    rows.append(
        {
            "model": "device_xray_cnn_v2 — device head",
            "file": src.name,
            "samples": int(len(yd)),
            "chancePct": round(100.0 / len(T.XRAY_CLASSES), 2),
            "randomWeightsAccPct": round(dev_r * 100, 2),
            "trainedAccPct": round(dev_t * 100, 2),
            "liftOverRandomPct": round((dev_t - dev_r) * 100, 2),
        }
    )
    rows.append(
        {
            "model": "device_xray_cnn_v2 — COPPER vs ALUMINUM coil head",
            "file": src.name,
            "samples": int(len(yc)),
            "chancePct": 50.0,
            "randomWeightsAccPct": round(coil_r * 100, 2),
            "trainedAccPct": round(coil_t * 100, 2),
            "liftOverRandomPct": round((coil_t - coil_r) * 100, 2),
        }
    )

    # ── 3. Scale Digit OCR 2D CNN ────────────────────────────────────────────
    xs, ys = [], []
    for d in range(10):
        for _ in range(24):
            xs.append(T.render_scale_digit_32x20(d, VERIFY_RNG))
            ys.append(d)
    rows.append(
        head_to_head(
            "scale_crnn_ocr_v2",
            "scale_crnn_ocr_v2.onnx",
            np.stack(xs),
            np.array(ys, dtype=np.int64),
            10,
            0.05,
        )
    )

    # ── 4. Vernacular NLU (fresh augmentation variants) ──────────────────────
    extras = ["", " bhai jaldi", " please", " 12 kg", " Gill Road", " Ludhiana"]
    xs, ys = [], []
    for intent_idx, phrases in T.MULTILINGUAL_CORPUS.items():
        for ph in phrases:
            ex = extras[int(VERIFY_RNG.integers(0, len(extras)))]
            xs.append(T.vectorize_multilingual_text_512(ph + ex))
            ys.append(intent_idx)
    rows.append(
        head_to_head(
            "vernacular_intent_nlu_v2",
            "vernacular_intent_nlu_v2.onnx",
            np.stack(xs),
            np.array(ys, dtype=np.int64),
            len(T.INTENT_CLASSES),
            0.20,
        )
    )

    # ── 5. Mandi Forecaster (regression → compare MAE) ───────────────────────
    n = 300
    r1 = VERIFY_RNG.normal(0.008, 0.03, n)
    r2 = VERIFY_RNG.normal(0.006, 0.03, n)
    r3 = VERIFY_RNG.normal(0.005, 0.03, n)
    r4 = VERIFY_RNG.normal(0.004, 0.03, n)
    slope = 0.45 * r4 + 0.30 * r3 + 0.15 * r2 + 0.10 * r1
    vol = np.abs(VERIFY_RNG.normal(0.035, 0.02, n))
    spread = np.clip(VERIFY_RNG.normal(0.22, 0.07, n), 0.05, 0.55)
    z = VERIFY_RNG.normal(0.0, 1.0, n)
    Xf = np.stack([r1, r2, r3, r4, slope, vol, spread, z], axis=1).astype(np.float32)
    y7 = 100.0 * (0.58 * slope + 0.06 * (spread - 0.20) - 0.008 * z)
    src = MODELS / "mandi_price_forecaster_v2.onnx"
    sess = ort.InferenceSession(str(src), providers=["CPUExecutionProvider"])
    pred_t = sess.run(["forecast_out"], {"series_features": Xf})[0]
    with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as tmp:
        rand_path = Path(tmp.name)
    randomize_and_save(src, rand_path, 0.20)
    rnd = ort.InferenceSession(str(rand_path), providers=["CPUExecutionProvider"])
    pred_r = rnd.run(["forecast_out"], {"series_features": Xf})[0]
    rand_path.unlink(missing_ok=True)
    mae_t = float(np.abs(pred_t[:, 0] - y7).mean())
    mae_r = float(np.abs(pred_r[:, 0] - y7).mean())
    rows.append(
        {
            "model": "mandi_price_forecaster_v2 — 7-day return MAE (lower is better)",
            "file": src.name,
            "samples": n,
            "chancePct": None,
            "randomWeightsAccPct": round(mae_r, 3),
            "trainedAccPct": round(mae_t, 3),
            "liftOverRandomPct": round(mae_r - mae_t, 3),
            "metric": "MAE percentage-points",
        }
    )

    print(json.dumps({"verificationRunAt": T.time.strftime("%Y-%m-%dT%H:%M:%SZ", T.time.gmtime()),
                      "headToHead": rows}, indent=2))


if __name__ == "__main__":
    main()
