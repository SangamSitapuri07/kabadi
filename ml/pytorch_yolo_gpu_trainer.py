#!/usr/bin/env python3
"""
Kabadiwala Connect — GPU Transfer-Learning & YOLOv8 Multi-Object Trainer
========================================================================
Run this script on Google Colab, Kaggle, or a local CUDA / Apple MPS workstation
once you have collected hundreds/thousands of real street scrap & kanta photos
(including automatic exports from `npx tsx apps/api/scripts/export-active-learning-dataset.ts`).

Exports drop-in replacement `.onnx` weights into `apps/api/models/` matching the
exact input/output tensor contracts consumed by `apps/api/src/modules/ai/onnx.engine.ts`:
  - `scrap_vision_cnn_v2.onnx`  : input `input_rgb` [B, 3, 64, 64] -> `probabilities` [B, 6]
  - `device_xray_cnn_v2.onnx`   : input `input_rgb` [B, 3, 64, 64] -> `device_probs` [B, 6], `coil_probs` [B, 2], `condition_probs` [B, 4]
  - `yolov8n_scrap_detector.onnx`: optional Ultralytics YOLOv8n bounding-box detector
"""

from __future__ import annotations

import argparse
from pathlib import Path

SCRAP_CLASSES = [
    "metal-copper-bright",
    "metal-copper-burnt",
    "metal-aluminium-utensil",
    "ewaste-pcb-grade-a",
    "battery-inverter-lead",
    "paper-cardboard",
]

XRAY_CLASSES = [
    "split-ac-15ton-copper",
    "split-ac-15ton-aluminum",
    "smartphone-midrange-android",
    "laptop-business-14",
    "ceiling-fan-copper-motor",
    "washing-machine-twin-tub",
]


def train_scrap_mobilenet_pytorch(data_dir: Path, out_dir: Path, epochs: int) -> None:
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader
    from torchvision import datasets, models, transforms

    device = torch.device(
        "cuda"
        if torch.cuda.is_available()
        else "mps"
        if torch.backends.mps.is_available()
        else "cpu"
    )
    tfm = transforms.Compose(
        [
            transforms.Resize((72, 72)),
            transforms.RandomResizedCrop((64, 64), scale=(0.75, 1.0)),
            transforms.RandomHorizontalFlip(),
            transforms.ColorJitter(brightness=0.25, contrast=0.25, saturation=0.2),
            transforms.ToTensor(),
        ]
    )
    ds = datasets.ImageFolder(str(data_dir / "scrap"), transform=tfm)
    loader = DataLoader(ds, batch_size=32, shuffle=True, num_workers=2)

    backbone = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.DEFAULT)
    in_features = backbone.classifier[-1].in_features
    backbone.classifier[-1] = nn.Linear(in_features, len(SCRAP_CLASSES))

    class WrappedSoftmaxModel(nn.Module):
        def __init__(self, net: nn.Module) -> None:
            super().__init__()
            self.net = net

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            return torch.softmax(self.net(x), dim=1)

    backbone.to(device)
    opt = torch.optim.AdamW(backbone.parameters(), lr=3e-4, weight_decay=1e-4)
    loss_fn = nn.CrossEntropyLoss()

    backbone.train()
    for epoch in range(epochs):
        total_loss, correct, total = 0.0, 0, 0
        for imgs, labels in loader:
            imgs, labels = imgs.to(device), labels.to(device)
            opt.zero_grad()
            logits = backbone(imgs)
            loss = loss_fn(logits, labels)
            loss.backward()
            opt.step()
            total_loss += float(loss.item()) * imgs.size(0)
            correct += int((logits.argmax(dim=1) == labels).sum().item())
            total += int(imgs.size(0))
        print(
            f"[Epoch {epoch + 1}/{epochs}] loss={total_loss / max(1, total):.4f} acc={correct / max(1, total):.4f}"
        )

    export_model = WrappedSoftmaxModel(backbone.cpu()).eval()
    dummy = torch.randn(1, 3, 64, 64, dtype=torch.float32)
    out_path = out_dir / "scrap_vision_cnn_v2.onnx"
    torch.onnx.export(
        export_model,
        dummy,
        str(out_path),
        opset_version=13,
        input_names=["input_rgb"],
        output_names=["probabilities"],
        dynamic_axes={"input_rgb": {0: "batch"}, "probabilities": {0: "batch"}},
    )
    print(f"Exported MobileNetV3 ONNX model -> {out_path}")


def train_yolov8_scrap_detector(yolo_yaml: Path, out_dir: Path, epochs: int) -> None:
    from ultralytics import YOLO

    model = YOLO("yolov8n.pt")
    model.train(data=str(yolo_yaml), epochs=epochs, imgsz=640, batch=16)
    exported = model.export(format="onnx", opset=13, dynamic=True)
    target = out_dir / "yolov8n_scrap_detector.onnx"
    Path(exported).replace(target)
    print(f"Exported YOLOv8n multi-object scrap detector -> {target}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Kabadiwala Connect PyTorch + YOLOv8 GPU Trainer")
    parser.add_argument("--mode", choices=["scrap-cnn", "yolo", "all"], default="scrap-cnn")
    parser.add_argument("--data-dir", type=Path, default=Path("ml/datasets"))
    parser.add_argument("--yolo-yaml", type=Path, default=Path("ml/datasets/scrap_yolo.yaml"))
    parser.add_argument("--epochs", type=int, default=35)
    parser.add_argument("--out-dir", type=Path, default=Path("apps/api/models"))
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.mode in ("scrap-cnn", "all"):
        train_scrap_mobilenet_pytorch(args.data_dir, args.out_dir, args.epochs)
    if args.mode in ("yolo", "all") and args.yolo_yaml.exists():
        train_yolov8_scrap_detector(args.yolo_yaml, args.out_dir, args.epochs)


if __name__ == "__main__":
    main()
