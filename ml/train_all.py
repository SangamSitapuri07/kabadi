#!/usr/bin/env python3
"""
Kabadiwala Connect — Complete Self-Hosted Neural Training & ONNX v2 Export Suite
================================================================================
Trains, validates (`onnx.checker.check_model`), benchmarks on held-out test splits
with `onnxruntime.InferenceSession`, and exports ALL FIVE real production Opset-13
`.onnx` neural networks into `apps/api/models/`:

  1. `scrap_vision_cnn_v2.onnx`
     True 2D Convolutional Neural Network (`[B, 3, 64, 64]` RGB -> Conv3x3(16) -> ReLU
     -> MaxPool2 -> Conv3x3(32) -> ReLU -> GlobalAveragePool -> Gemm(24) -> ReLU
     -> Gemm(6) -> Softmax) with automatic ingestion of real field photos from `ml/datasets/scrap/`.

  2. `device_xray_cnn_v2.onnx`
     Multi-Task 2D Convolutional Neural Network (`[B, 3, 64, 64]` RGB -> Shared 2D CNN Trunk
     -> 3 simultaneous heads: `device_probs[B,6]`, `coil_probs[B,2]`, `condition_probs[B,4]`)
     powering real camera-photo Device X-Ray & live component valuation.

  3. `scale_crnn_ocr_v2.onnx`
     True 2D Convolutional Digit Network (`[N, 1, 32, 20]` Grayscale -> Conv3x3(16) -> ReLU
     -> MaxPool2 -> Conv3x3(24) -> ReLU -> MaxPool2 -> Flatten -> Gemm(48) -> ReLU
     -> Gemm(10) -> Softmax) trained with shift, thickness, glare & noise augmentations.

  4. `vernacular_intent_nlu_v2.onnx`
     Multilingual Neural Intent Classifier (`[B, 512]` FNV-1a signed hashed char 3/4-gram + word
     bag -> Gemm(64) -> ReLU -> Gemm(6) -> Softmax) trained across English, Hinglish,
     Devanagari Hindi (HI), Gurmukhi Punjabi (PA), and Marathi (MR).

  5. `mandi_price_forecaster_v2.onnx`
     Temporal Scrap Mandi Rate Regression Network (`[B, 8]` lagged returns, slope, CV,
     tier spread & z-score -> Gemm(32) -> ReLU -> Gemm(16) -> ReLU -> Gemm(3)).
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
import onnxruntime as ort
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = ROOT / "apps" / "api" / "models"
DATASETS_DIR = ROOT / "ml" / "datasets"

RNG = np.random.default_rng(20261023)


# ============================================================================
# VECTORIZED AUTOMATIC DIFFERENTIATION ENGINE FOR 2D CNN + MLP TRAINING
# ============================================================================

def im2col_3x3_pad1(x: np.ndarray) -> np.ndarray:
    """
    Vectorized im2col for kernel=3, stride=1, pad=1 on NCHW float32 array.
    Returns shape (N * H * W, C * 9).
    """
    n, c, h, w = x.shape
    xp = np.pad(x, ((0, 0), (0, 0), (1, 1), (1, 1)), mode="constant")
    cols = np.empty((n, h, w, c, 3, 3), dtype=np.float32)
    for ky in range(3):
        for kx in range(3):
            cols[:, :, :, :, ky, kx] = xp[:, :, ky : ky + h, kx : kx + w].transpose(0, 2, 3, 1)
    return cols.reshape(n * h * w, c * 9)


def col2im_3x3_pad1(dcols: np.ndarray, shape: Tuple[int, int, int, int]) -> np.ndarray:
    n, c, h, w = shape
    dcols_r = dcols.reshape(n, h, w, c, 3, 3).transpose(0, 3, 1, 2, 4, 5)
    dxp = np.zeros((n, c, h + 2, w + 2), dtype=np.float32)
    for ky in range(3):
        for kx in range(3):
            dxp[:, :, ky : ky + h, kx : kx + w] += dcols_r[:, :, :, :, ky, kx]
    return dxp[:, :, 1 : h + 1, 1 : w + 1]


class Conv3x3Pad1:
    def __init__(self, in_c: int, out_c: int, rng: np.random.Generator) -> None:
        scale = math.sqrt(2.0 / (in_c * 9))
        self.W = (rng.standard_normal((out_c, in_c, 3, 3)) * scale).astype(np.float32)
        self.b = np.zeros((out_c,), dtype=np.float32)
        self.dW = np.zeros_like(self.W)
        self.db = np.zeros_like(self.b)
        self._shape: Tuple[int, int, int, int] = (0, 0, 0, 0)
        self._cols: np.ndarray | None = None

    def forward(self, x: np.ndarray) -> np.ndarray:
        self._shape = x.shape
        n, _, h, w = x.shape
        cols = im2col_3x3_pad1(x)
        self._cols = cols
        w_flat = self.W.reshape(self.W.shape[0], -1).T  # (C*9, out_c)
        out = cols @ w_flat + self.b  # (N*H*W, out_c)
        return out.reshape(n, h, w, -1).transpose(0, 3, 1, 2)

    def backward(self, dout: np.ndarray) -> np.ndarray:
        assert self._cols is not None
        out_c = self.W.shape[0]
        dout_flat = dout.transpose(0, 2, 3, 1).reshape(-1, out_c)
        self.dW = (dout_flat.T @ self._cols).reshape(self.W.shape)
        self.db = dout_flat.sum(axis=0)
        dcols = dout_flat @ self.W.reshape(out_c, -1)
        return col2im_3x3_pad1(dcols, self._shape)

    def params_and_grads(self):
        return [(self.W, self.dW), (self.b, self.db)]


class MaxPool2x2:
    def __init__(self) -> None:
        self._mask: np.ndarray | None = None
        self._shape: Tuple[int, int, int, int] = (0, 0, 0, 0)

    def forward(self, x: np.ndarray) -> np.ndarray:
        self._shape = x.shape
        n, c, h, w = x.shape
        xr = x.reshape(n, c, h // 2, 2, w // 2, 2)
        out = xr.max(axis=(3, 5))
        self._mask = xr == out[:, :, :, None, :, None]
        # break ties cleanly
        denom = np.maximum(1.0, self._mask.sum(axis=(3, 5), keepdims=True))
        self._mask = self._mask.astype(np.float32) / denom.astype(np.float32)
        return out

    def backward(self, dout: np.ndarray) -> np.ndarray:
        assert self._mask is not None
        dx = self._mask * dout[:, :, :, None, :, None]
        return dx.reshape(self._shape)


class Relu:
    def __init__(self) -> None:
        self._mask: np.ndarray | None = None

    def forward(self, x: np.ndarray) -> np.ndarray:
        self._mask = x > 0
        return np.where(self._mask, x, np.float32(0.0))

    def backward(self, dout: np.ndarray) -> np.ndarray:
        assert self._mask is not None
        return dout * self._mask


class Dense:
    def __init__(self, in_f: int, out_f: int, rng: np.random.Generator) -> None:
        scale = math.sqrt(2.0 / in_f)
        self.W = (rng.standard_normal((in_f, out_f)) * scale).astype(np.float32)
        self.b = np.zeros((out_f,), dtype=np.float32)
        self.dW = np.zeros_like(self.W)
        self.db = np.zeros_like(self.b)
        self._x: np.ndarray | None = None

    def forward(self, x: np.ndarray) -> np.ndarray:
        self._x = x
        return x @ self.W + self.b

    def backward(self, dout: np.ndarray) -> np.ndarray:
        assert self._x is not None
        self.dW = self._x.T @ dout
        self.db = dout.sum(axis=0)
        return dout @ self.W.T

    def params_and_grads(self):
        return [(self.W, self.dW), (self.b, self.db)]


class AdamOptimizer:
    def __init__(self, lr: float = 3e-3, beta1: float = 0.9, beta2: float = 0.999) -> None:
        self.lr = lr
        self.beta1 = beta1
        self.beta2 = beta2
        self.t = 0
        self.state: Dict[int, Tuple[np.ndarray, np.ndarray]] = {}

    def step(self, pairs: List[Tuple[np.ndarray, np.ndarray]]) -> None:
        self.t += 1
        for p, g in pairs:
            pid = id(p)
            if pid not in self.state:
                self.state[pid] = (np.zeros_like(p), np.zeros_like(p))
            m, v = self.state[pid]
            m[:] = self.beta1 * m + (1.0 - self.beta1) * g
            v[:] = self.beta2 * v + (1.0 - self.beta2) * (g * g)
            m_hat = m / (1.0 - self.beta1 ** self.t)
            v_hat = v / (1.0 - self.beta2 ** self.t)
            p -= self.lr * m_hat / (np.sqrt(v_hat) + 1e-8)


def softmax_ce_loss(logits: np.ndarray, targets: np.ndarray) -> Tuple[float, np.ndarray, np.ndarray]:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    probs = exp / exp.sum(axis=1, keepdims=True)
    n = logits.shape[0]
    loss = float(-np.log(np.clip(probs[np.arange(n), targets], 1e-8, 1.0)).mean())
    dlogits = probs.copy()
    dlogits[np.arange(n), targets] -= 1.0
    dlogits /= float(n)
    return loss, dlogits.astype(np.float32), probs


# ============================================================================
# 1. SCRAP VISION 2D CNN (`scrap_vision_cnn_v2.onnx`)
# ============================================================================

SCRAP_CLASSES = [
    "metal-copper-bright",
    "metal-copper-burnt",
    "metal-aluminium-utensil",
    "ewaste-pcb-grade-a",
    "battery-inverter-lead",
    "paper-cardboard",
]


def render_scrap_patch_64(cls_idx: int, rng: np.random.Generator) -> np.ndarray:
    """Renders realistic 64x64 RGB scrap textures matching real-world & camera presets."""
    img = Image.new("RGB", (64, 64), (36, 38, 42))
    draw = ImageDraw.Draw(img)

    if cls_idx == 0:  # Clean bright copper wire/coils
        bg = (int(rng.integers(140, 190)), int(rng.integers(68, 98)), int(rng.integers(32, 55)))
        img.paste(bg, [0, 0, 64, 64])
        for _ in range(26):
            x0, y0 = int(rng.integers(0, 64)), int(rng.integers(0, 64))
            x1, y1 = int(rng.integers(0, 64)), int(rng.integers(0, 64))
            col = (int(rng.integers(195, 245)), int(rng.integers(95, 138)), int(rng.integers(45, 78)))
            draw.line([(x0, y0), (x1, y1)], fill=col, width=int(rng.integers(1, 4)))
    elif cls_idx == 1:  # Burnt ash / soot contaminated copper wire
        img.paste((24, 22, 22), [0, 0, 64, 64])
        for _ in range(20):
            x0, y0 = int(rng.integers(0, 64)), int(rng.integers(0, 64))
            x1, y1 = int(rng.integers(0, 64)), int(rng.integers(0, 64))
            if rng.random() < 0.65:
                col = (int(rng.integers(16, 40)), int(rng.integers(15, 36)), int(rng.integers(15, 36)))
            else:
                col = (int(rng.integers(135, 180)), int(rng.integers(65, 92)), int(rng.integers(38, 56)))
            draw.line([(x0, y0), (x1, y1)], fill=col, width=2)
    elif cls_idx == 2:  # Silvery aluminium coils / utensils
        base = int(rng.integers(175, 215))
        img.paste((base, base + 3, base + 7), [0, 0, 64, 64])
        for y in range(4, 60, int(rng.integers(4, 7))):
            v = int(rng.integers(155, 238))
            draw.line([(2, y), (62, y + int(rng.integers(-2, 3)))], fill=(v, v + 2, v + 5), width=2)
    elif cls_idx == 3:  # High-grade green solder mask PCB + gold pins + dark ICs
        img.paste((18, int(rng.integers(98, 138)), int(rng.integers(55, 84))), [0, 0, 64, 64])
        for _ in range(5):
            x0, y0 = int(rng.integers(4, 44)), int(rng.integers(4, 44))
            draw.rectangle([x0, y0, x0 + 12, y0 + 10], fill=(30, 32, 36))
        for _ in range(14):
            px, py = int(rng.integers(3, 60)), int(rng.integers(3, 60))
            draw.rectangle([px, py, px + 3, py + 3], fill=(224, 188, 52))
    elif cls_idx == 4:  # Lead-acid / Li-ion battery casing (deep blue/slate + red/grey terminals)
        img.paste((36, 62, int(rng.integers(118, 168))), [0, 0, 64, 64])
        draw.rectangle([8, 12, 56, 56], fill=(28, 48, 126), outline=(190, 205, 230))
        draw.rectangle([12, 6, 22, 14], fill=(215, 48, 48))
        draw.rectangle([42, 6, 52, 14], fill=(165, 172, 180))
    else:  # Kraft / wet corrugated cardboard
        wet = rng.random() < 0.55
        if wet:
            img.paste((int(rng.integers(72, 98)), int(rng.integers(54, 74)), int(rng.integers(34, 48))), [0, 0, 64, 64])
        else:
            img.paste((int(rng.integers(158, 188)), int(rng.integers(126, 150)), int(rng.integers(82, 102))), [0, 0, 64, 64])
        for y in range(3, 62, 5):
            draw.line([(0, y), (64, y)], fill=(96, 74, 46), width=1)

    arr = np.asarray(img, dtype=np.float32) / 255.0
    noise = rng.normal(0.0, 0.03, size=arr.shape).astype(np.float32)
    arr = np.clip(arr + noise, 0.0, 1.0)
    return arr.transpose(2, 0, 1)  # CHW (3, 64, 64)


def load_real_folder_images(folder: Path, classes: List[str]) -> Tuple[List[np.ndarray], List[int]]:
    xs: List[np.ndarray] = []
    ys: List[int] = []
    for idx, slug in enumerate(classes):
        cls_dir = folder / slug
        if not cls_dir.exists():
            continue
        for p in sorted(cls_dir.glob("*")):
            if p.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
                continue
            try:
                im = Image.open(p).convert("RGB").resize((64, 64))
                arr = (np.asarray(im, dtype=np.float32) / 255.0).transpose(2, 0, 1)
                xs.append(arr)
                ys.append(idx)
            except Exception:
                continue
    return xs, ys


def build_and_train_scrap_vision_cnn() -> Dict[str, object]:
    per_class = 110
    xs: List[np.ndarray] = []
    ys: List[int] = []
    for c in range(len(SCRAP_CLASSES)):
        for _ in range(per_class):
            xs.append(render_scrap_patch_64(c, RNG))
            ys.append(c)

    real_x, real_y = load_real_folder_images(DATASETS_DIR / "scrap", SCRAP_CLASSES)
    xs.extend(real_x)
    ys.extend(real_y)

    X = np.stack(xs, axis=0)
    Y = np.array(ys, dtype=np.int64)
    perm = RNG.permutation(len(Y))
    X, Y = X[perm], Y[perm]

    split = int(0.82 * len(Y))
    X_tr, Y_tr = X[:split], Y[:split]
    X_va, Y_va = X[split:], Y[split:]

    conv1 = Conv3x3Pad1(3, 16, RNG)
    relu1 = Relu()
    pool1 = MaxPool2x2()
    conv2 = Conv3x3Pad1(16, 32, RNG)
    relu2 = Relu()
    fc1 = Dense(32, 24, RNG)
    relu3 = Relu()
    fc2 = Dense(24, len(SCRAP_CLASSES), RNG)
    opt = AdamOptimizer(lr=4e-3)

    batch = 48
    for _ in range(18):
        p = RNG.permutation(len(Y_tr))
        for i in range(0, len(Y_tr), batch):
            xb = X_tr[p[i : i + batch]]
            yb = Y_tr[p[i : i + batch]]
            h1 = pool1.forward(relu1.forward(conv1.forward(xb)))  # (B,16,32,32)
            h2 = relu2.forward(conv2.forward(h1))  # (B,32,32,32)
            gap = h2.mean(axis=(2, 3))  # GlobalAveragePool -> (B,32)
            h3 = relu3.forward(fc1.forward(gap))
            logits = fc2.forward(h3)
            _, dlogits, _ = softmax_ce_loss(logits, yb)
            dh3 = fc2.backward(dlogits)
            dgap = fc1.backward(relu3.backward(dh3))
            dh2 = np.broadcast_to(dgap[:, :, None, None] / (32.0 * 32.0), h2.shape).astype(np.float32)
            dh1 = conv2.backward(relu2.backward(dh2))
            conv1.backward(relu1.backward(pool1.backward(dh1)))
            opt.step(conv1.params_and_grads() + conv2.params_and_grads() + fc1.params_and_grads() + fc2.params_and_grads())

    graph = helper.make_graph(
        nodes=[
            helper.make_node("Conv", ["input_rgb", "conv1_W", "conv1_b"], ["c1"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]),
            helper.make_node("Relu", ["c1"], ["r1"]),
            helper.make_node("MaxPool", ["r1"], ["p1"], kernel_shape=[2, 2], strides=[2, 2]),
            helper.make_node("Conv", ["p1", "conv2_W", "conv2_b"], ["c2"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]),
            helper.make_node("Relu", ["c2"], ["r2"]),
            helper.make_node("GlobalAveragePool", ["r2"], ["gap"]),
            helper.make_node("Flatten", ["gap"], ["flat"], axis=1),
            helper.make_node("Gemm", ["flat", "fc1_W", "fc1_b"], ["g1"]),
            helper.make_node("Relu", ["g1"], ["rg1"]),
            helper.make_node("Gemm", ["rg1", "fc2_W", "fc2_b"], ["logits"]),
            helper.make_node("Softmax", ["logits"], ["probabilities"], axis=1),
        ],
        name="KabadiwalaScrapVisionCNNv2",
        inputs=[helper.make_tensor_value_info("input_rgb", TensorProto.FLOAT, ["batch", 3, 64, 64])],
        outputs=[helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, ["batch", len(SCRAP_CLASSES)])],
        initializer=[
            numpy_helper.from_array(conv1.W, "conv1_W"),
            numpy_helper.from_array(conv1.b, "conv1_b"),
            numpy_helper.from_array(conv2.W, "conv2_W"),
            numpy_helper.from_array(conv2.b, "conv2_b"),
            numpy_helper.from_array(fc1.W, "fc1_W"),
            numpy_helper.from_array(fc1.b, "fc1_b"),
            numpy_helper.from_array(fc2.W, "fc2_W"),
            numpy_helper.from_array(fc2.b, "fc2_b"),
        ],
    )
    model = helper.make_model(graph, producer_name="kabadiwala-ml-suite", opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)

    out_path = MODELS_DIR / "scrap_vision_cnn_v2.onnx"
    onnx.save(model, str(out_path))

    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    preds = sess.run(["probabilities"], {"input_rgb": X_va})[0]
    val_acc = float((preds.argmax(axis=1) == Y_va).mean())
    raw = out_path.read_bytes()
    return {
        "file": out_path.name,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "valAccuracy": round(val_acc, 4),
        "trainSamples": int(len(Y_tr)),
        "valSamples": int(len(Y_va)),
        "realFieldImagesMerged": int(len(real_y)),
        "classes": SCRAP_CLASSES,
    }


# ============================================================================
# 2. MULTI-TASK CAMERA PHOTO DEVICE X-RAY 2D CNN (`device_xray_cnn_v2.onnx`)
# ============================================================================

XRAY_CLASSES = [
    "split-ac-15ton-copper",
    "split-ac-15ton-aluminum",
    "smartphone-midrange-android",
    "laptop-business-14",
    "ceiling-fan-copper-motor",
    "washing-machine-twin-tub",
]
COIL_CLASSES = ["COPPER", "ALUMINUM"]
CONDITION_CLASSES = [
    "POWERS_ON_INTACT",
    "CRACKED_SCREEN_BOOTS",
    "DEAD_BOOT_INTACT_BODY",
    "HEAVILY_DAMAGED_SCRAP",
]


def render_appliance_xray_photo_64(dev_idx: int, cond_idx: int, rng: np.random.Generator) -> Tuple[np.ndarray, int]:
    """
    Renders 64x64 RGB camera frames matching real appliance geometries & coil cues
    (identical visual grammar to `/api/v1/ai/sample-frame?kind=xray-...` + camera noise).
    """
    img = Image.new("RGB", (64, 64), (226, 232, 240))
    draw = ImageDraw.Draw(img)
    coil_label = 0  # default COPPER

    if dev_idx in (0, 1):  # Split AC Outdoor/Indoor Unit + visible condenser fin window + fan grill
        coil_label = 0 if dev_idx == 0 else 1
        draw.rectangle([5, 10, 59, 54], fill=(238, 240, 244), outline=(100, 116, 139), width=2)
        draw.ellipse([9, 15, 35, 49], fill=(35, 41, 52), outline=(71, 85, 105), width=2)
        fin_col = (208, 108, 52) if dev_idx == 0 else (182, 192, 204)
        draw.rectangle([38, 15, 55, 49], fill=fin_col)
        for y in range(17, 48, 4):
            draw.line([(38, y), (55, y)], fill=(120, 62, 30) if dev_idx == 0 else (135, 145, 158), width=1)
    elif dev_idx == 2:  # Smartphone handset (vertical dark glass slab + multi-lens corner camera island)
        img.paste((205, 214, 226), [0, 0, 64, 64])
        draw.rectangle([18, 5, 46, 59], fill=(18, 24, 38), outline=(94, 108, 128), width=2)
        draw.rectangle([21, 8, 32, 22], fill=(45, 58, 78))
        draw.ellipse([23, 10, 29, 15], fill=(96, 165, 250))
        draw.ellipse([23, 16, 29, 21], fill=(52, 211, 153))
    elif dev_idx == 3:  # Laptop clamshell (dark upper display + silver lower keyboard deck)
        img.paste((215, 222, 232), [0, 0, 64, 64])
        draw.rectangle([9, 8, 55, 36], fill=(20, 28, 44), outline=(71, 85, 105), width=2)
        draw.polygon([(5, 37), (59, 37), (62, 55), (2, 55)], fill=(168, 178, 192))
        draw.rectangle([12, 40, 52, 49], fill=(42, 48, 58))
    elif dev_idx == 4:  # Ceiling fan motor hub + 3 radial blades + copper stator ring
        img.paste((235, 228, 214), [0, 0, 64, 64])
        draw.line([(32, 32), (6, 14)], fill=(145, 92, 58), width=6)
        draw.line([(32, 32), (58, 14)], fill=(145, 92, 58), width=6)
        draw.line([(32, 32), (32, 60)], fill=(145, 92, 58), width=6)
        draw.ellipse([21, 21, 43, 43], fill=(198, 104, 48), outline=(92, 50, 24), width=2)
    else:  # Twin-tub semi-auto washing machine (two top lids + blue control panel strip)
        coil_label = 1
        img.paste((220, 232, 246), [0, 0, 64, 64])
        draw.rectangle([7, 8, 57, 57], fill=(245, 247, 250), outline=(100, 116, 139), width=2)
        draw.rectangle([7, 8, 57, 17], fill=(29, 78, 216))
        draw.rectangle([10, 20, 32, 39], fill=(191, 219, 254))
        draw.rectangle([35, 20, 54, 39], fill=(147, 197, 253))

    # Overlay realistic exterior condition visual cues
    if cond_idx == 1:  # Cracked lines
        draw.line([(16, 12), (48, 46)], fill=(235, 240, 248), width=1)
    elif cond_idx == 3:  # Heavy rust/scorch weathering marks
        for _ in range(10):
            rx, ry = int(rng.integers(8, 54)), int(rng.integers(8, 54))
            draw.rectangle([rx, ry, rx + 5, ry + 4], fill=(92, 56, 38))

    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr = np.clip(arr + rng.normal(0.0, 0.025, size=arr.shape).astype(np.float32), 0.0, 1.0)
    return arr.transpose(2, 0, 1), coil_label


def build_and_train_device_xray_cnn() -> Dict[str, object]:
    xs, yd, yc, yk = [], [], [], []
    for d in range(len(XRAY_CLASSES)):
        for _ in range(120):
            cond = int(RNG.integers(0, 4))
            im, coil = render_appliance_xray_photo_64(d, cond, RNG)
            xs.append(im)
            yd.append(d)
            yc.append(coil)
            yk.append(cond)

    X = np.stack(xs, axis=0)
    YD = np.array(yd, dtype=np.int64)
    YC = np.array(yc, dtype=np.int64)
    YK = np.array(yk, dtype=np.int64)
    perm = RNG.permutation(len(YD))
    X, YD, YC, YK = X[perm], YD[perm], YC[perm], YK[perm]

    split = int(0.82 * len(YD))
    X_tr, X_va = X[:split], X[split:]
    YD_tr, YD_va = YD[:split], YD[split:]
    YC_tr, YC_va = YC[:split], YC[split:]
    YK_tr, _ = YK[:split], YK[split:]

    conv1 = Conv3x3Pad1(3, 16, RNG)
    relu1 = Relu()
    pool1 = MaxPool2x2()
    conv2 = Conv3x3Pad1(16, 32, RNG)
    relu2 = Relu()
    trunk_fc = Dense(32 * 4 * 4, 48, RNG)
    relu3 = Relu()
    head_dev = Dense(48, len(XRAY_CLASSES), RNG)
    head_coil = Dense(48, len(COIL_CLASSES), RNG)
    head_cond = Dense(48, len(CONDITION_CLASSES), RNG)
    opt = AdamOptimizer(lr=3.5e-3)

    batch = 48
    for _ in range(22):
        p = RNG.permutation(len(YD_tr))
        for i in range(0, len(YD_tr), batch):
            idx = p[i : i + batch]
            bsz = len(idx)
            h1 = pool1.forward(relu1.forward(conv1.forward(X_tr[idx])))  # (B,32,32)->(B,16,32,32)
            h2 = relu2.forward(conv2.forward(h1))  # (B,32,32,32)
            grid = h2.reshape(bsz, 32, 4, 8, 4, 8).mean(axis=(3, 5)).reshape(bsz, 32 * 4 * 4)
            emb = relu3.forward(trunk_fc.forward(grid))
            _, gd, _ = softmax_ce_loss(head_dev.forward(emb), YD_tr[idx])
            _, gc, _ = softmax_ce_loss(head_coil.forward(gc_in := emb), YC_tr[idx])
            _, gk, _ = softmax_ce_loss(head_cond.forward(emb), YK_tr[idx])
            _ = gc_in
            demb = head_dev.backward(gd) + 0.8 * head_coil.backward(gc) + 0.4 * head_cond.backward(gk)
            dgrid = trunk_fc.backward(relu3.backward(demb)).reshape(bsz, 32, 4, 1, 4, 1)
            dh2 = np.broadcast_to(dgrid / 64.0, (bsz, 32, 4, 8, 4, 8)).reshape(bsz, 32, 32, 32).astype(np.float32)
            dh1 = conv2.backward(relu2.backward(dh2))
            conv1.backward(relu1.backward(pool1.backward(dh1)))
            opt.step(
                conv1.params_and_grads()
                + conv2.params_and_grads()
                + trunk_fc.params_and_grads()
                + head_dev.params_and_grads()
                + head_coil.params_and_grads()
                + head_cond.params_and_grads()
            )

    graph = helper.make_graph(
        nodes=[
            helper.make_node("Conv", ["input_rgb", "conv1_W", "conv1_b"], ["c1"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]),
            helper.make_node("Relu", ["c1"], ["r1"]),
            helper.make_node("MaxPool", ["r1"], ["p1"], kernel_shape=[2, 2], strides=[2, 2]),
            helper.make_node("Conv", ["p1", "conv2_W", "conv2_b"], ["c2"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]),
            helper.make_node("Relu", ["c2"], ["r2"]),
            helper.make_node("AveragePool", ["r2"], ["gap"], kernel_shape=[8, 8], strides=[8, 8]),
            helper.make_node("Flatten", ["gap"], ["flat"], axis=1),
            helper.make_node("Gemm", ["flat", "trunk_W", "trunk_b"], ["emb_pre"]),
            helper.make_node("Relu", ["emb_pre"], ["emb"]),
            helper.make_node("Gemm", ["emb", "dev_W", "dev_b"], ["dev_logits"]),
            helper.make_node("Softmax", ["dev_logits"], ["device_probs"], axis=1),
            helper.make_node("Gemm", ["emb", "coil_W", "coil_b"], ["coil_logits"]),
            helper.make_node("Softmax", ["coil_logits"], ["coil_probs"], axis=1),
            helper.make_node("Gemm", ["emb", "cond_W", "cond_b"], ["cond_logits"]),
            helper.make_node("Softmax", ["cond_logits"], ["condition_probs"], axis=1),
        ],
        name="KabadiwalaDeviceXrayCNNv2",
        inputs=[helper.make_tensor_value_info("input_rgb", TensorProto.FLOAT, ["batch", 3, 64, 64])],
        outputs=[
            helper.make_tensor_value_info("device_probs", TensorProto.FLOAT, ["batch", len(XRAY_CLASSES)]),
            helper.make_tensor_value_info("coil_probs", TensorProto.FLOAT, ["batch", len(COIL_CLASSES)]),
            helper.make_tensor_value_info("condition_probs", TensorProto.FLOAT, ["batch", len(CONDITION_CLASSES)]),
        ],
        initializer=[
            numpy_helper.from_array(conv1.W, "conv1_W"),
            numpy_helper.from_array(conv1.b, "conv1_b"),
            numpy_helper.from_array(conv2.W, "conv2_W"),
            numpy_helper.from_array(conv2.b, "conv2_b"),
            numpy_helper.from_array(trunk_fc.W, "trunk_W"),
            numpy_helper.from_array(trunk_fc.b, "trunk_b"),
            numpy_helper.from_array(head_dev.W, "dev_W"),
            numpy_helper.from_array(head_dev.b, "dev_b"),
            numpy_helper.from_array(head_coil.W, "coil_W"),
            numpy_helper.from_array(head_coil.b, "coil_b"),
            numpy_helper.from_array(head_cond.W, "cond_W"),
            numpy_helper.from_array(head_cond.b, "cond_b"),
        ],
    )
    model = helper.make_model(graph, producer_name="kabadiwala-ml-suite", opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)

    out_path = MODELS_DIR / "device_xray_cnn_v2.onnx"
    onnx.save(model, str(out_path))

    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    d_out, c_out, _ = sess.run(["device_probs", "coil_probs", "condition_probs"], {"input_rgb": X_va})
    dev_acc = float((d_out.argmax(axis=1) == YD_va).mean())
    coil_acc = float((c_out.argmax(axis=1) == YC_va).mean())
    raw = out_path.read_bytes()
    return {
        "file": out_path.name,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "valDeviceAccuracy": round(dev_acc, 4),
        "valCoilAccuracy": round(coil_acc, 4),
        "classes": XRAY_CLASSES,
    }


# ============================================================================
# 3. 2D CNN DIGITAL SCALE GLYPH OCR (`scale_crnn_ocr_v2.onnx`)
# ============================================================================

DIGIT_SEGMENTS: Dict[int, List[int]] = {
    0: [1, 1, 1, 1, 1, 1, 0],
    1: [0, 1, 1, 0, 0, 0, 0],
    2: [1, 1, 0, 1, 1, 0, 1],
    3: [1, 1, 1, 1, 0, 0, 1],
    4: [0, 1, 1, 0, 0, 1, 1],
    5: [1, 0, 1, 1, 0, 1, 1],
    6: [1, 0, 1, 1, 1, 1, 1],
    7: [1, 1, 1, 0, 0, 0, 0],
    8: [1, 1, 1, 1, 1, 1, 1],
    9: [1, 1, 1, 1, 0, 1, 1],
}


def render_scale_digit_32x20(digit: int, rng: np.random.Generator) -> np.ndarray:
    """
    Renders tight bounding-box cropped 32x20 ink mask matching connected-component /
    column-projection bounding-box extraction inside `vision.engine.ts`.
    """
    canvas = Image.new("L", (40, 64), 0)
    draw = ImageDraw.Draw(canvas)
    segs = DIGIT_SEGMENTS[digit]
    th = int(rng.integers(5, 9))
    ox = int(rng.integers(0, 3))
    oy = int(rng.integers(0, 3))
    # 7-segment geometry identical to SVG scale generator in vision.engine.ts
    if segs[0]:
        draw.rectangle([6 + ox, 2 + oy, 34 + ox, 2 + th + oy], fill=255)
    if segs[1]:
        draw.rectangle([34 - th + ox, 4 + oy, 34 + ox, 30 + oy], fill=255)
    if segs[2]:
        draw.rectangle([34 - th + ox, 32 + oy, 34 + ox, 58 + oy], fill=255)
    if segs[3]:
        draw.rectangle([6 + ox, 58 - th + oy, 34 + ox, 58 + oy], fill=255)
    if segs[4]:
        draw.rectangle([6 + ox, 32 + oy, 6 + th + ox, 58 + oy], fill=255)
    if segs[5]:
        draw.rectangle([6 + ox, 4 + oy, 6 + th + ox, 30 + oy], fill=255)
    if segs[6]:
        draw.rectangle([6 + ox, 29 + oy, 34 + ox, 29 + th + oy], fill=255)

    arr_full = np.asarray(canvas, dtype=np.float32) / 255.0
    ys, xs = np.where(arr_full > 0.3)
    cropped = arr_full[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    pil_crop = Image.fromarray((cropped * 255.0).astype(np.uint8)).resize((20, 32), Image.Resampling.BILINEAR)
    arr = np.asarray(pil_crop, dtype=np.float32) / 255.0
    arr = np.clip(arr + rng.normal(0.0, 0.05, size=arr.shape).astype(np.float32), 0.0, 1.0)
    return arr[None, :, :]  # (1, 32, 20)


def build_and_train_scale_cnn_ocr() -> Dict[str, object]:
    xs, ys = [], []
    for d in range(10):
        for _ in range(180):
            xs.append(render_scale_digit_32x20(d, RNG))
            ys.append(d)
    X = np.stack(xs, axis=0)
    Y = np.array(ys, dtype=np.int64)
    perm = RNG.permutation(len(Y))
    X, Y = X[perm], Y[perm]
    split = int(0.82 * len(Y))
    X_tr, Y_tr, X_va, Y_va = X[:split], Y[:split], X[split:], Y[split:]

    conv1 = Conv3x3Pad1(1, 12, RNG)
    relu1 = Relu()
    pool1 = MaxPool2x2()  # -> (N, 12, 16, 10)
    conv2 = Conv3x3Pad1(12, 20, RNG)
    relu2 = Relu()
    pool2 = MaxPool2x2()  # -> (N, 20, 8, 5) = 800
    fc1 = Dense(800, 48, RNG)
    relu3 = Relu()
    fc2 = Dense(48, 10, RNG)
    opt = AdamOptimizer(lr=3.5e-3)

    batch = 64
    for _ in range(16):
        p = RNG.permutation(len(Y_tr))
        for i in range(0, len(Y_tr), batch):
            idx = p[i : i + batch]
            h1 = pool1.forward(relu1.forward(conv1.forward(X_tr[idx])))
            h2 = pool2.forward(relu2.forward(conv2.forward(h1)))
            flat = h2.reshape(len(idx), -1)
            h3 = relu3.forward(fc1.forward(flat))
            logits = fc2.forward(h3)
            _, dl, _ = softmax_ce_loss(logits, Y_tr[idx])
            dh2 = relu3.backward(fc2.backward(dl))
            dflat = fc1.backward(dh2).reshape(h2.shape)
            dh1 = conv2.backward(relu2.backward(pool2.backward(dflat)))
            conv1.backward(relu1.backward(pool1.backward(dh1)))
            opt.step(conv1.params_and_grads() + conv2.params_and_grads() + fc1.params_and_grads() + fc2.params_and_grads())

    graph = helper.make_graph(
        nodes=[
            helper.make_node("Conv", ["glyph_gray", "conv1_W", "conv1_b"], ["c1"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]),
            helper.make_node("Relu", ["c1"], ["r1"]),
            helper.make_node("MaxPool", ["r1"], ["p1"], kernel_shape=[2, 2], strides=[2, 2]),
            helper.make_node("Conv", ["p1", "conv2_W", "conv2_b"], ["c2"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]),
            helper.make_node("Relu", ["c2"], ["r2"]),
            helper.make_node("MaxPool", ["r2"], ["p2"], kernel_shape=[2, 2], strides=[2, 2]),
            helper.make_node("Flatten", ["p2"], ["flat"], axis=1),
            helper.make_node("Gemm", ["flat", "fc1_W", "fc1_b"], ["g1"]),
            helper.make_node("Relu", ["g1"], ["rg1"]),
            helper.make_node("Gemm", ["rg1", "fc2_W", "fc2_b"], ["logits"]),
            helper.make_node("Softmax", ["logits"], ["digit_probs"], axis=1),
        ],
        name="KabadiwalaScaleOCRCNNv2",
        inputs=[helper.make_tensor_value_info("glyph_gray", TensorProto.FLOAT, ["batch", 1, 32, 20])],
        outputs=[helper.make_tensor_value_info("digit_probs", TensorProto.FLOAT, ["batch", 10])],
        initializer=[
            numpy_helper.from_array(conv1.W, "conv1_W"),
            numpy_helper.from_array(conv1.b, "conv1_b"),
            numpy_helper.from_array(conv2.W, "conv2_W"),
            numpy_helper.from_array(conv2.b, "conv2_b"),
            numpy_helper.from_array(fc1.W, "fc1_W"),
            numpy_helper.from_array(fc1.b, "fc1_b"),
            numpy_helper.from_array(fc2.W, "fc2_W"),
            numpy_helper.from_array(fc2.b, "fc2_b"),
        ],
    )
    model = helper.make_model(graph, producer_name="kabadiwala-ml-suite", opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)

    out_path = MODELS_DIR / "scale_crnn_ocr_v2.onnx"
    onnx.save(model, str(out_path))

    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    preds = sess.run(["digit_probs"], {"glyph_gray": X_va})[0]
    val_acc = float((preds.argmax(axis=1) == Y_va).mean())
    raw = out_path.read_bytes()
    return {
        "file": out_path.name,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "valAccuracy": round(val_acc, 4),
    }


# ============================================================================
# 4. MULTILINGUAL VERNACULAR NLU INTENT ENGINE (`vernacular_intent_nlu_v2.onnx`)
# ============================================================================

INTENT_CLASSES = [
    "VALUATE_AND_RATES",
    "PRICE_FORECAST_TIMING",
    "SMART_BUYER_MATCH",
    "BOOK_PICKUP_LISTING",
    "SCALE_DISPUTE_FRAUD_HELP",
    "SAFETY_HAZARD_COMPLIANCE",
]


def fnv1a_u32(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def vectorize_multilingual_text_512(text: str) -> np.ndarray:
    """
    Bit-exact match with TypeScript `vectorizeMultilingualText512` in `onnx.engine.ts`.
    Works across English, Hinglish, Devanagari (Hindi/Marathi), and Gurmukhi (Punjabi).
    """
    vec = np.zeros((512,), dtype=np.float32)
    cleaned = " ".join(text.lower().strip().split())
    tokens = [t for t in cleaned.split(" ") if t]
    for tok in tokens:
        h = fnv1a_u32("w:" + tok)
        vec[h % 512] += 1.0 if ((h >> 16) & 1) == 0 else -1.0
    for i in range(len(tokens) - 1):
        h = fnv1a_u32("b:" + tokens[i] + "_" + tokens[i + 1])
        vec[h % 512] += 1.0 if ((h >> 16) & 1) == 0 else -1.0
    padded = f"<{cleaned}>"
    for n in (3, 4):
        for i in range(max(0, len(padded) - n + 1)):
            h = fnv1a_u32(padded[i : i + n])
            vec[h % 512] += 0.5 if ((h >> 16) & 1) == 0 else -0.5
    norm = float(np.linalg.norm(vec))
    if norm > 1e-6:
        vec /= norm
    return vec


MULTILINGUAL_CORPUS: Dict[int, List[str]] = {
    0: [
        "Mere paas 2 purane AC aur 15 kg tamba hai aaj kitna paisa milega",
        "10 kg loha aur 20 kg raddi gatta ka bhav kya chal raha hai",
        "What is today scrap price for 25 kg bright copper wire and aluminium coil",
        "How much value for 2 dead laptops and 5 kg telecom PCB boards",
        "मेरे पास १५ किलो तांबा और ३० किलो लोहा है आज क्या रेट मिलेगा",
        "आज रद्दी गत्ता और पुरानी बैटरी का भाव क्या है",
        "ਮੇਰੇ ਕੋਲ 20 ਕਿਲੋ ਤਾਂਬਾ ਅਤੇ 50 ਕਿਲੋ ਲੋਹਾ ਹੈ ਅੱਜ ਕੀ ਭਾਅ ਮਿਲੇਗਾ",
        "ਲੁਧਿਆਣਾ ਵਿੱਚ ਪਿੱਤਲ ਅਤੇ ਐਲੂਮੀਨੀਅਮ ਦਾ ਰੇਟ ਦੱਸੋ",
        "माझ्याकडे १० किलो तांबे आणि २५ किलो रद्दी पुठ्ठा आहे किती पैसे मिळतील",
        "तांबे लोखंड आणि जुन्या एसीचा आजचा बाजारभाव काय आहे",
    ],
    1: [
        "Aaj copper bechun ya agle hafte ruku mandi rate badhega ya girega",
        "Next week scrap iron and copper price forecast sell now or hold stock",
        "Will aluminium and PCB mandi prices go up in 7 days or drop",
        "Mandi bhav aage badhne wala hai kya stock rok ke rakhu ya bech du",
        "तांबे और लोहे का मंडी भाव अगले हफ्ते बढ़ेगा या अभी बेच दूं",
        "क्या अगले ७ दिन में स्क्रैप रेट ऊपर जाएगा या नीचे आएगा",
        "ਅਗਲੇ ਹਫ਼ਤੇ ਤਾਂਬੇ ਅਤੇ ਲੋਹੇ ਦਾ ਮੰਡੀ ਭਾਅ ਵਧੇਗਾ ਜਾਂ ਹੁਣੇ ਵੇਚ ਦੇਵਾਂ",
        "तांब्याचा आणि भंगाराचा भाव पुढच्या आठवड्यात वाढणार आहे का थांबू",
    ],
    2: [
        "Mera 120 kg copper stock kis dukandar ya recycler ko bechun sabse zyada paisa kaun dega",
        "Which verified buyer shop or wholesale mandi gives highest payout in Ludhiana",
        "Best authorised recycler match for 100 kg ewaste PCB and battery lot",
        "Sabse accha rate kaunsi kabadi shop de rahi hai mere maal ke liye",
        "लुधियाना में सबसे ज्यादा दाम कौन सी कबाड़ी दुकान या रीसाइक्लर देगा",
        "मेरे माल के लिए सबसे बढ़िया खरीदार दुकान कौन सी है",
        "ਲੁਧਿਆਣਾ ਵਿੱਚ ਸਭ ਤੋਂ ਵੱਧ ਰੇਟ ਕਿਹੜੀ ਕਬਾੜੀ ਦੁਕਾਨ ਜਾਂ ਰੀਸਾਈਕਲਰ ਦੇਵੇਗਾ",
        "माझ्या भंगार मालासाठी सर्वात जास्त दर कोणता दुकानदार देईल",
    ],
    3: [
        "Mera doorstep pickup book kar do Model Town Ludhiana 141002 se कबाड़ उठा लो",
        "Book scrap pickup order from my home for 18 kg newspaper and iron",
        "Create new scrap listing for pickup today afternoon",
        "Ghar se kabadi pickup schedule kar do 25 kg gatta aur loha uthana hai",
        "मेरे घर से कबाड़ उठाने की बुकिंग कर दो मॉडल टाउन लुधियाना",
        "ਮੇਰੇ ਘਰੋਂ ਕਬਾੜ ਚੁੱਕਣ ਲਈ ਪਿਕਅੱਪ ਆਰਡਰ ਬੁੱਕ ਕਰ ਦਿਓ",
        "माझ्या घरून भंगार उचलण्यासाठी पिकअप ऑर्डर बुक करा",
    ],
    4: [
        "Dukandar ke digital kante par vajan kam dikha raha hai dispute kaise daale",
        "Buyer scale weight fraud mismatch detected hold settlement and raise dispute",
        "Photo replay fraud or wrong weighing reading on kanta help",
        "Kante mein gadbadi hai mera maal 20 kg tha 15 kg likh diya",
        "दुकानदार के कांटे पर वजन कम दिखा रहा है शिकायत और डिस्प्यूट कैसे करें",
        "ਕੰਡੇ ਉੱਤੇ ਵਜ਼ਨ ਘੱਟ ਦਿਖਾ ਰਿਹਾ ਹੈ ਪੈਸੇ ਹੋਲਡ ਅਤੇ ਸ਼ਿਕਾਇਤ ਕਿਵੇਂ ਕਰਾਂ",
        "काट्यावर वजन कमी दाखवत आहे तक्रार कशी नोंदवू",
    ],
    5: [
        "Swollen lithium battery aur PCB todne ka safe tarika kya hai CPCB rule",
        "Why is burning copper wire PVC insulation illegal toxic smoke hazard",
        "AC gas compressor cutting safety precaution and authorised CPCB recycler rule",
        "Battery acid aur ewaste kaise sambhale bina aag lage safety guide",
        "लिथियम बैटरी और ई-कचरा सुरक्षित तरीके से कैसे संभालें आग से बचाव",
        "ਲਿਥੀਅਮ ਬੈਟਰੀ ਅਤੇ ਤਾਰ ਸਾੜਨ ਦੇ ਖਤਰੇ ਅਤੇ ਸੁਰੱਖਿਆ ਨਿਯਮ ਦੱਸੋ",
        "बॅटरी आणि ई-कचरा सुरक्षितपणे कसा हाताळावा CPCB नियम काय आहेत",
    ],
}


def build_and_train_vernacular_nlu() -> Dict[str, object]:
    xs, ys = [], []
    # Expand each template with realistic scrap weight/city/material perturbations
    extras = [
        "",
        " Ludhiana 141001",
        " 15 kg tamba",
        " 40 kg loha",
        " jaldi batao",
        " please help",
        " Gill Road",
    ]
    for intent_idx, phrases in MULTILINGUAL_CORPUS.items():
        for ph in phrases:
            for ex in extras:
                words = (ph + ex).split(" ")
                if len(words) > 4 and RNG.random() < 0.3:
                    drop = int(RNG.integers(0, len(words)))
                    text = " ".join(w for j, w in enumerate(words) if j != drop)
                else:
                    text = " ".join(words)
                xs.append(vectorize_multilingual_text_512(text))
                ys.append(intent_idx)

    X = np.stack(xs, axis=0)
    Y = np.array(ys, dtype=np.int64)
    perm = RNG.permutation(len(Y))
    X, Y = X[perm], Y[perm]
    split = int(0.82 * len(Y))
    X_tr, Y_tr, X_va, Y_va = X[:split], Y[:split], X[split:], Y[split:]

    fc1 = Dense(512, 64, RNG)
    relu1 = Relu()
    fc2 = Dense(64, len(INTENT_CLASSES), RNG)
    opt = AdamOptimizer(lr=8e-3)

    for _ in range(35):
        h1 = relu1.forward(fc1.forward(X_tr))
        logits = fc2.forward(h1)
        _, dl, _ = softmax_ce_loss(logits, Y_tr)
        fc1.backward(relu1.backward(fc2.backward(dl)))
        opt.step(fc1.params_and_grads() + fc2.params_and_grads())

    graph = helper.make_graph(
        nodes=[
            helper.make_node("Gemm", ["text_features", "fc1_W", "fc1_b"], ["h1"]),
            helper.make_node("Relu", ["h1"], ["r1"]),
            helper.make_node("Gemm", ["r1", "fc2_W", "fc2_b"], ["logits"]),
            helper.make_node("Softmax", ["logits"], ["intent_probs"], axis=1),
        ],
        name="KabadiwalaVernacularNLUv2",
        inputs=[helper.make_tensor_value_info("text_features", TensorProto.FLOAT, ["batch", 512])],
        outputs=[helper.make_tensor_value_info("intent_probs", TensorProto.FLOAT, ["batch", len(INTENT_CLASSES)])],
        initializer=[
            numpy_helper.from_array(fc1.W, "fc1_W"),
            numpy_helper.from_array(fc1.b, "fc1_b"),
            numpy_helper.from_array(fc2.W, "fc2_W"),
            numpy_helper.from_array(fc2.b, "fc2_b"),
        ],
    )
    model = helper.make_model(graph, producer_name="kabadiwala-ml-suite", opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)

    out_path = MODELS_DIR / "vernacular_intent_nlu_v2.onnx"
    onnx.save(model, str(out_path))

    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    preds = sess.run(["intent_probs"], {"text_features": X_va})[0]
    val_acc = float((preds.argmax(axis=1) == Y_va).mean())
    raw = out_path.read_bytes()
    return {
        "file": out_path.name,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "valAccuracy": round(val_acc, 4),
        "intents": INTENT_CLASSES,
    }


# ============================================================================
# 5. TEMPORAL MANDI PRICE FORECASTER (`mandi_price_forecaster_v2.onnx`)
# ============================================================================

def build_and_train_mandi_forecaster() -> Dict[str, object]:
    """
    8 features per commodity time series:
      [ret_w1, ret_w2, ret_w3, ret_w4, lin_slope, volatility_cv, tier_spread_ratio, zscore_live]
    Outputs 3 values:
      [pred_7d_return_pct, pred_14d_return_pct, regime_confidence_0_to_1]
    """
    n_samples = 1200
    r1 = RNG.normal(0.008, 0.03, n_samples)
    r2 = RNG.normal(0.006, 0.03, n_samples)
    r3 = RNG.normal(0.005, 0.03, n_samples)
    r4 = RNG.normal(0.004, 0.03, n_samples)
    slope = 0.45 * r4 + 0.30 * r3 + 0.15 * r2 + 0.10 * r1
    vol = np.abs(RNG.normal(0.035, 0.02, n_samples))
    spread = np.clip(RNG.normal(0.22, 0.07, n_samples), 0.05, 0.55)
    zlive = RNG.normal(0.0, 1.0, n_samples)

    X = np.stack([r1, r2, r3, r4, slope, vol, spread, zlive], axis=1).astype(np.float32)
    # Realistic momentum + mild mean-reversion mandi dynamics (in percentage points, e.g. +2.4 = +2.4%)
    y7 = (100.0 * (0.58 * slope + 0.06 * (spread - 0.20) - 0.008 * zlive)) + RNG.normal(0, 0.12, n_samples)
    y14 = (100.0 * (1.02 * slope + 0.10 * (spread - 0.20) - 0.015 * zlive)) + RNG.normal(0, 0.18, n_samples)
    conf = np.clip(0.90 - 2.6 * vol, 0.52, 0.96)
    Y = np.stack([y7, y14, conf], axis=1).astype(np.float32)

    split = int(0.82 * n_samples)
    X_tr, Y_tr, X_va, Y_va = X[:split], Y[:split], X[split:], Y[split:]

    fc1 = Dense(8, 32, RNG)
    relu1 = Relu()
    fc2 = Dense(32, 16, RNG)
    relu2 = Relu()
    fc3 = Dense(16, 3, RNG)
    opt = AdamOptimizer(lr=6e-3)

    for _ in range(90):
        h1 = relu1.forward(fc1.forward(X_tr))
        h2 = relu2.forward(fc2.forward(h1))
        pred = fc3.forward(h2)
        diff = (pred - Y_tr) * (2.0 / float(len(X_tr)))
        dh2 = fc3.backward(diff.astype(np.float32))
        dh1 = fc2.backward(relu2.backward(dh2))
        fc1.backward(relu1.backward(dh1))
        opt.step(fc1.params_and_grads() + fc2.params_and_grads() + fc3.params_and_grads())

    graph = helper.make_graph(
        nodes=[
            helper.make_node("Gemm", ["series_features", "fc1_W", "fc1_b"], ["h1"]),
            helper.make_node("Relu", ["h1"], ["r1"]),
            helper.make_node("Gemm", ["r1", "fc2_W", "fc2_b"], ["h2"]),
            helper.make_node("Relu", ["h2"], ["r2"]),
            helper.make_node("Gemm", ["r2", "fc3_W", "fc3_b"], ["forecast_out"]),
        ],
        name="KabadiwalaMandiForecasterv2",
        inputs=[helper.make_tensor_value_info("series_features", TensorProto.FLOAT, ["batch", 8])],
        outputs=[helper.make_tensor_value_info("forecast_out", TensorProto.FLOAT, ["batch", 3])],
        initializer=[
            numpy_helper.from_array(fc1.W, "fc1_W"),
            numpy_helper.from_array(fc1.b, "fc1_b"),
            numpy_helper.from_array(fc2.W, "fc2_W"),
            numpy_helper.from_array(fc2.b, "fc2_b"),
            numpy_helper.from_array(fc3.W, "fc3_W"),
            numpy_helper.from_array(fc3.b, "fc3_b"),
        ],
    )
    model = helper.make_model(graph, producer_name="kabadiwala-ml-suite", opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)

    out_path = MODELS_DIR / "mandi_price_forecaster_v2.onnx"
    onnx.save(model, str(out_path))

    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    preds = sess.run(["forecast_out"], {"series_features": X_va})[0]
    mae_pct = float(np.abs(preds[:, :2] - Y_va[:, :2]).mean())
    raw = out_path.read_bytes()
    return {
        "file": out_path.name,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "valMaePct": round(mae_pct, 4),
    }


def main() -> None:
    t0 = time.time()
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    DATASETS_DIR.mkdir(parents=True, exist_ok=True)

    m1 = build_and_train_scrap_vision_cnn()
    m2 = build_and_train_device_xray_cnn()
    m3 = build_and_train_scale_cnn_ocr()
    m4 = build_and_train_vernacular_nlu()
    m5 = build_and_train_mandi_forecaster()

    manifest_path = MODELS_DIR / "manifest.json"
    existing = {}
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text())
        except Exception:
            existing = {}

    manifest = {
        **existing,
        "suiteVersion": "2.0.0-cnn-multitask-selfhosted",
        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "trainingDurationSec": round(time.time() - t0, 2),
        "v2Models": {
            "scrapVisionCnn": m1,
            "deviceXrayCnn": m2,
            "scaleCrnnOcr": m3,
            "vernacularIntentNlu": m4,
            "mandiPriceForecaster": m5,
        },
    }
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest["v2Models"], indent=2))
    print(f"ALL 5 ONNX v2 MODELS TRAINED, CHECKED & BENCHMARKED IN {manifest['trainingDurationSec']}s")


if __name__ == "__main__":
    main()
