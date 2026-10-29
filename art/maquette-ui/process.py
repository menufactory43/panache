#!/usr/bin/env python3
"""raw/*.webp -> public/assets/ui/belle/*.webp : détourage des médaillons, plaques et frise."""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

RAW = Path(__file__).parent / "raw"
OUT = Path(__file__).resolve().parents[2] / "public/assets/ui/belle"
OUT.mkdir(parents=True, exist_ok=True)

def bbox_vs_corners(im, tol=38):
    a = np.asarray(im.convert("RGB")).astype(int)
    bg = np.median(np.concatenate([a[:8, :8].reshape(-1, 3), a[:8, -8:].reshape(-1, 3), a[-8:, :8].reshape(-1, 3), a[-8:, -8:].reshape(-1, 3)]), axis=0)
    m = np.abs(a - bg).sum(axis=2) > tol
    ys, xs = np.where(m)
    # ignore stray pixels: use 0.2 / 99.8 percentiles
    return (int(np.percentile(xs, .2)), int(np.percentile(ys, .2)), int(np.percentile(xs, 99.8)) + 1, int(np.percentile(ys, 99.8)) + 1)

def disc(name, size=256):
    im = Image.open(RAW / f"{name}.webp").convert("RGB")
    x0, y0, x1, y1 = bbox_vs_corners(im)
    c = im.crop((x0, y0, x1, y1)).resize((size * 2, size * 2), Image.LANCZOS)
    mask = Image.new("L", c.size, 0)
    ImageDraw.Draw(mask).ellipse((3, 3, c.size[0] - 3, c.size[1] - 3), fill=255)
    c.putalpha(mask.filter(ImageFilter.GaussianBlur(1.5)))
    c.resize((size, size), Image.LANCZOS).save(OUT / f"{name}.webp", quality=90)

def rect(name, width):
    im = Image.open(RAW / f"{name}.webp").convert("RGB")
    c = im.crop(bbox_vs_corners(im))
    c = c.resize((width, round(c.height * width / c.width)), Image.LANCZOS)
    c.save(OUT / f"{name}.webp", quality=90)

def frise():
    im = Image.open(RAW / "frise.webp").convert("RGB")
    a = np.asarray(im).astype(float)
    lum = a.max(axis=2)
    alpha = np.clip((lum - 18) * 2.2, 0, 255).astype(np.uint8)
    ys, xs = np.where(alpha > 40)
    rgba = Image.fromarray(np.dstack([a.astype(np.uint8), alpha]), "RGBA").crop((xs.min(), ys.min() - 4, xs.max() + 1, ys.max() + 5))
    rgba.resize((1200, round(rgba.height * 1200 / rgba.width)), Image.LANCZOS).save(OUT / "frise.webp", quality=90)

for p in RAW.glob("i-*.webp"):
    disc(p.stem, 192)
disc("cadran", 256)
rect("plaque", 900); rect("plaque-bordeaux", 900); rect("bouton", 1000)
Image.open(RAW / "papier.webp").convert("RGB").resize((768, 768), Image.LANCZOS).save(OUT / "papier.webp", quality=85)
frise()
print(sorted(f.name for f in OUT.iterdir()))
