#!/usr/bin/env python3
"""
Kabadiwala Connect — Real-World Dataset Fetcher (TrashNet)
==========================================================
Downloads and extracts the **TrashNet** real-photo dataset (Gary Thung & Mindy
Yang, Stanford CS229, MIT-licensed): 2,527 genuine photographs of household
recyclables captured on a white background at 512×384, labelled into 6 classes:

    cardboard (403) · glass (501) · metal (410) · paper (594) · plastic (482) · trash (137)

Source repository: https://github.com/garythung/trashnet
Fetched via `codeload.github.com` (repo tarball) so no external CDN is required.

Usage:
    python3 ml/download_real_dataset.py
    python3 ml/train_real.py        # train + benchmark on a real held-out split

The extracted photos land in `ml/datasets/real/trashnet/` and are **git-ignored**
(only the downloader + trained weights + benchmark JSON are committed).
"""

from __future__ import annotations

import io
import pathlib
import sys
import tarfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
TARGET = ROOT / "ml" / "datasets" / "real" / "trashnet"
ARCHIVE_URL = "https://codeload.github.com/garythung/trashnet/tar.gz/refs/heads/master"
EXPECTED_CLASSES = {
    "cardboard": 403,
    "glass": 501,
    "metal": 410,
    "paper": 594,
    "plastic": 482,
    "trash": 137,
}


def download(url: str, timeout: int = 300) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "kabadiwala-connect-ml/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return resp.read()


def main() -> int:
    if TARGET.exists() and any(TARGET.rglob("*.jpg")):
        counts = {d.name: len(list(d.glob("*.jpg"))) for d in TARGET.iterdir() if d.is_dir()}
        print(f"Dataset already present at {TARGET}: {counts}")
        return 0

    print(f"Downloading TrashNet tarball from {ARCHIVE_URL} ...")
    blob = download(ARCHIVE_URL)
    print(f"Downloaded {len(blob) / 1_048_576:.1f} MB — extracting dataset-resized.zip ...")

    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        inner = None
        for member in tar.getmembers():
            if member.name.endswith("data/dataset-resized.zip"):
                inner = tar.extractfile(member)
                break
        if inner is None:
            print("ERROR: dataset-resized.zip not found inside tarball", file=sys.stderr)
            return 1
        zip_bytes = inner.read()

    TARGET.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            parts = name.split("/")
            if len(parts) < 2 or not parts[1] in EXPECTED_CLASSES:
                continue
            if not name.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            dest_dir = TARGET / parts[1]
            dest_dir.mkdir(parents=True, exist_ok=True)
            with zf.open(name) as src, open(dest_dir / pathlib.Path(name).name, "wb") as out:
                out.write(src.read())

    counts = {d.name: len(list(d.glob("*.jpg"))) + len(list(d.glob("*.png"))) for d in TARGET.iterdir() if d.is_dir()}
    total = sum(counts.values())
    print(f"Extracted {total} REAL photographs: {counts}")
    if total < 2000:
        print("WARNING: fewer images than expected — check the archive layout", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
