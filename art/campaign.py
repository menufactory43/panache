#!/usr/bin/env python3
"""« La Campagne de 1900 » chapter stills (src/ui/cine.ts): web assets from the raw generated art.

Usage:
    python3 art/campaign.py

Inputs (art/raw/): chap-1, chap-carbonie, chap-2, chap-3, chap-paris (opaque, 3:2).
Outputs (public/assets/ui/campaign/): the same names as .webp, 1280 px wide.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT.parent / "public" / "assets" / "ui" / "campaign"
NAMES = ["chap-1", "chap-carbonie", "chap-2", "chap-3", "chap-paris"]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name in NAMES:
        im = Image.open(RAW / f"{name}.webp").convert("RGB")
        k = 1280 / im.width
        if k < 1:
            im = im.resize((1280, round(im.height * k)), Image.LANCZOS)
        p = OUT / f"{name}.webp"
        im.save(p, "WEBP", quality=74, method=6)
        print(f"{p.name:22} {im.width}x{im.height} {p.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
