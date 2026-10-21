#!/usr/bin/env python3
"""The Belle Époque title screen and intro film (src/ui/title.ts): web assets
from the raw generated art.

Usage:
    python3 art/title.py

Needs Pillow (>= 10.1) and numpy. Deterministic: same raws -> same output.

Inputs  (art/raw/):
    titre-fond          Paris at dusk from Montmartre (opaque, the backdrop)
    titre-dirigeable    dirigible, side view (cut-out)
    titre-montgolfiere  hot-air balloon (cut-out)
    titre-gargantua     the walking steam fortress (cut-out)
    titre-heros         the clockwork officer, sabre raised (cut-out)
    intro-marche        intro shot: Gargantua and automatons marching (opaque)
    intro-feu           intro shot: a 75 firing under a sky of machines (opaque)

Outputs (public/assets/ui/title/): the same names as .webp, cut-outs trimmed
to their visible pixels and scaled for phones, plus grain.webp (a tiling
film-grain tile, mid-grey: blended with `overlay` it only adds the grain).
"""
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT.parent / "public" / "assets" / "ui" / "title"

# name -> (longest side in px, webp quality)
OPAQUE = {"titre-fond": (1536, 78), "intro-marche": (1536, 76), "intro-feu": (1536, 76)}
CUTOUT = {
    "titre-dirigeable": (760, 80),
    "titre-montgolfiere": (520, 80),
    "titre-gargantua": (900, 78),
    "titre-heros": (1100, 80),
}


def fit(im: Image.Image, longest: int) -> Image.Image:
    k = longest / max(im.size)
    if k >= 1:
        return im
    return im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)


def trim(im: Image.Image, threshold: int = 12, pad: int = 4) -> Image.Image:
    """Crop to the pixels that really show (faint generator haze is dropped)."""
    a = np.asarray(im.getchannel("A"))
    ys, xs = np.nonzero(a > threshold)
    x0, x1 = max(0, xs.min() - pad), min(im.width, xs.max() + 1 + pad)
    y0, y1 = max(0, ys.min() - pad), min(im.height, ys.max() + 1 + pad)
    im = im.crop((x0, y0, x1, y1))
    # the haze under the threshold goes fully transparent (smaller files, no grey film)
    arr = np.asarray(im).copy()
    arr[..., 3] = np.where(arr[..., 3] <= threshold, 0, arr[..., 3])
    return Image.fromarray(arr)


def grain(size: int = 192, seed: int = 1900) -> Image.Image:
    rng = np.random.default_rng(seed)
    n = rng.normal(0, 1, (size, size))
    # a touch of blur: film grain clumps, it is not per-pixel white noise
    n = (n + np.roll(n, 1, 0) + np.roll(n, 1, 1) + np.roll(np.roll(n, 1, 0), 1, 1)) / 2
    v = np.clip(128 + n * 34, 0, 255).astype(np.uint8)
    return Image.fromarray(v).convert("RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for name, (lim, q) in OPAQUE.items():
        im = fit(Image.open(RAW / f"{name}.webp").convert("RGB"), lim)
        p = OUT / f"{name}.webp"
        im.save(p, "WEBP", quality=q, method=6)
        total += p.stat().st_size
        print(f"{p.name:24} {im.width}x{im.height} {p.stat().st_size // 1024} KB")
    for name, (lim, q) in CUTOUT.items():
        im = fit(trim(Image.open(RAW / f"{name}.webp").convert("RGBA")), lim)
        p = OUT / f"{name}.webp"
        im.save(p, "WEBP", quality=q, alpha_quality=90, method=6)
        total += p.stat().st_size
        print(f"{p.name:24} {im.width}x{im.height} {p.stat().st_size // 1024} KB")
    p = OUT / "grain.webp"
    grain().save(p, "WEBP", quality=70, method=6)
    total += p.stat().st_size
    print(f"{p.name:24} {p.stat().st_size // 1024} KB")
    print(f"total {total // 1024} KB")


if __name__ == "__main__":
    main()
