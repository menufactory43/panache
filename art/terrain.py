#!/usr/bin/env python3
"""Offline terrain renderer for Battle Drones skirmish maps.

Paints a top-down terrain image for every map in ``art/maps/<id>.json`` from
the map's tile grid plus the AI-generated material textures and decoration
sprite sheets in ``art/raw``, then writes the game-ready chunks:

    public/assets/maps/<id>/t_<col>_<row>.webp   48 px per tile, 1024 px chunks
    public/assets/maps/<id>/meta.json
    public/assets/maps/<id>/thumb.webp          256x256 overview (map picker, minimap)
    art/previews/terrain-<id>.jpg               ~1200 px QA preview

and then refreshes the rock materials of those maps' biomes, which the 3D
cliffs and crags are textured with (art/textures.py, whose seamless-texture
helpers it shares: public/assets/textures/rock-<biome>.webp).

Usage:  python3 art/terrain.py [map ids...] [--debug]

Rendering is deterministic for a given map JSON (all randomness is seeded from
the map seed). ``--debug`` also writes a full-size QA image with impassable tiles
(rock / deep water) outlined in red, shallows in yellow and forest in cyan to
``art/previews/terrain-<id>-grid.jpg`` for checking edge fidelity.

Chunk quality is chosen per map: the highest of WEBP_QUALITY whose chunks fit in
BUDGET bytes (scaled by area for maps bigger than 64 x 64). Needs Pillow, numpy and scipy.

Terrain codes: 0 Ground, 1 Rock, 2 Scrap, 3 Water (lava on volcanic), 4 Road,
5 Rough, 6 Forest, 7 Crystal, 8 Bridge, 9 Shallows, 10 Deep (open sea), one
base-36 character per tile in the exported grid (Deep is "a").
"""

from __future__ import annotations

import io
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

from textures import flatten, make_seamless, write_rock_textures

ROOT = Path(__file__).resolve().parent.parent
MAPS_DIR = ROOT / "art" / "maps"
RAW = ROOT / "art" / "raw"
OUT_DIR = ROOT / "public" / "assets" / "maps"
PREVIEW_DIR = ROOT / "art" / "previews"

PX = 48  # pixels per tile
CHUNK = 1024
WEBP_QUALITY = (82, 78, 74, 70, 66, 62)  # highest that fits the budget wins
BUDGET = 1.5 * 1024 * 1024               # bytes of chunks per map up to 64 x 64 tiles (soft target)
BUDGET_TILES = 64 * 64                   # bigger maps get the budget scaled by their area
SOFTEN = 0.8                             # px blur on ground-level textures (big byte saver)
THUMB = 256
PREVIEW = 1200

GROUND, ROCK, SCRAP, WATER, ROAD, ROUGH, FOREST, CRYSTAL, BRIDGE, SHALLOWS, DEEP = range(11)

# Light comes from the upper left; shadows fall toward +x, +y.
SUN_SLOPE = 0.85  # tan(sun elevation): shadow length == occluder height / SUN_SLOPE

# ----------------------------------------------------------------- biomes ---
# Texture scales are "fraction of the 1024 px source per rendered texture":
# 0.42 => the 1024 texture covers ~430 px (~9 tiles) on the map.
# Doodads: sheet index (row-major in the 3x3 sheet) ->
#   (name, min size, max size [tiles, longest side], height for shadows [tiles], weight).
# Sheet indices 0-2 are always the tree crowns. The slot names are the painter's roles (they drive
# placement rules); the Panache sheets hold Belle Époque objects in them: temperate bush = haystack,
# log = firewood stack, wreck = hay cart; desert cactus = balloon basket, skull = expedition crates,
# wreck = covered wagon; arctic wreck = ruined refuge, crate = loaded sled; volcanic fumarole =
# basalt columns, debris = mine cart, wreck = lava-stone hut ruin, sulfur = dry grass; tropical
# (Brittany) mangrove = gorse, coral = shells, log = rowing boat, wreck = fishing boat, crate = lobster pots.

BIOMES: dict[str, dict] = {
    "temperate": dict(
        scale=dict(ground=0.42, ground2=0.44, rough=0.44, rock=0.48, liquid=0.55, road=0.36, forest=0.62),
        ground2_cover=0.2,
        ground_tint=(0.94, 0.93, 0.86), ground_sat=0.8, pebbles=0.35,
        lowfreq=(0.07, 0.035),  # brightness, warm/cool amplitude
        water=dict(
            near_mul=(0.95, 1.15, 1.05), near_add=(0.05, 0.10, 0.07),
            deep_mul=(0.62, 0.78, 0.86), deep_add=(0.0, 0.01, 0.03),
            clarity=0.45, bed="rough", bed_mul=(1.0, 1.0, 1.0), bed_color=(0.6, 0.55, 0.43),
            sh_mul=(0.9, 1.1, 1.08), sh_add=(0.06, 0.15, 0.15), sh_opacity=0.38,
            foam=(0.86, 0.92, 0.9), wet=0.28,
        ),
        rock_h=0.95, forest_h=0.5, tree_h=0.7,
        rail=(0.44, 0.34, 0.24), deck_tint=(1.0, 0.98, 0.95), deck="planks", wood=(0.6, 0.47, 0.33),
        stain=(0.8, 0.75, 0.7), crystal_tint=(0.9, 1.0, 0.92), road_curb=0.08,
        grade=dict(sat=1.08, contrast=1.06, lift=(0.0, 0.0, 0.01), gain=(1.02, 1.01, 0.98), gamma=1.0),
        shadow_col=(0.52, 0.56, 0.66), shadow_k=0.8,
        trees=[0, 1, 2], tree_size=(1.05, 1.5),
        big={3: ("boulder", 0.85, 1.1, 0.30, 5), 6: ("log", 0.95, 1.2, 0.12, 3), 7: ("wreck", 1.05, 1.25, 0.18, 1)},
        small={4: ("rocks", 0.6, 0.85, 0.1, 2), 5: ("bush", 0.75, 0.95, 0.14, 1), 8: ("flowers", 0.6, 0.85, 0.0, 3)},
        tree_w=[0.45, 0.2, 0.35],
    ),
    "desert": dict(
        scale=dict(ground=0.42, ground2=0.45, rough=0.44, rock=0.52, liquid=0.55, road=0.36, forest=0.62),
        ground2_cover=0.30, pebbles=0.35,
        lowfreq=(0.06, 0.03),
        water=dict(
            near_mul=(1.0, 1.02, 0.98), near_add=(0.04, 0.05, 0.03),
            deep_mul=(0.42, 0.62, 0.75), deep_add=(0.0, 0.02, 0.05),
            clarity=0.55, bed="ground", bed_mul=(1.0, 0.96, 0.88),
            sh_mul=(0.85, 1.05, 1.02), sh_add=(0.06, 0.14, 0.14), sh_opacity=0.38,
            foam=(0.95, 0.95, 0.88), wet=0.3,
        ),
        rock_h=1.0, forest_h=0.35, tree_h=0.8,
        rail=(0.46, 0.34, 0.24), deck_tint=(1.0, 0.97, 0.92), deck="planks", wood=(0.62, 0.47, 0.32),
        stain=(0.82, 0.76, 0.7), crystal_tint=(0.9, 1.0, 0.93), road_contrast=1.15, road_curb=0.1,
        grade=dict(sat=1.04, contrast=1.06, lift=(0.01, 0.0, 0.0), gain=(1.02, 1.0, 0.96), gamma=1.0),
        shadow_col=(0.5, 0.48, 0.58), shadow_k=0.8,
        trees=[0, 1, 2], tree_size=(1.1, 1.5),
        big={3: ("boulder", 0.85, 1.1, 0.3, 5), 8: ("wreck", 1.05, 1.25, 0.18, 1)},
        small={4: ("rocks", 0.6, 0.85, 0.1, 3), 5: ("tumbleweed", 0.5, 0.65, 0.1, 2), 6: ("cactus", 0.45, 0.6, 0.18, 2),
               7: ("skull", 0.45, 0.55, 0.02, 1)},
    ),
    "arctic": dict(
        scale=dict(ground=0.44, ground2=0.46, rough=0.42, rock=0.48, liquid=0.6, road=0.34, forest=0.6),
        ground2_cover=0.12, ground2_max=0.6,
        lowfreq=(0.045, 0.03),
        water=dict(
            near_mul=(1.05, 1.12, 1.12), near_add=(0.05, 0.1, 0.12),
            deep_mul=(0.72, 0.8, 0.88), deep_add=(0.0, 0.0, 0.02),
            clarity=0.4, bed="ground2", bed_mul=(0.92, 0.97, 1.02),
            sh_mul=(0.9, 1.0, 1.05), sh_add=(0.1, 0.16, 0.2), sh_opacity=0.32, ford_stones=False,
            foam=(0.92, 0.96, 1.0), wet=0.18,
        ),
        rock_h=0.95, forest_h=0.5, tree_h=0.75,
        rail=(0.36, 0.33, 0.31), deck_tint=(1.0, 1.0, 1.02), deck="planks", wood=(0.45, 0.38, 0.32),
        deck_snow=0.35,
        stain=(0.8, 0.8, 0.82), crystal_tint=(0.9, 1.0, 0.95), road_curb=0.06,
        grade=dict(sat=1.03, contrast=1.05, lift=(0.0, 0.005, 0.02), gain=(0.99, 1.0, 1.02), gamma=1.0),
        shadow_col=(0.5, 0.58, 0.74), shadow_k=0.75,
        trees=[0, 1, 2], tree_size=(1.0, 1.4),
        big={3: ("boulder", 0.85, 1.1, 0.3, 5), 7: ("wreck", 1.05, 1.25, 0.18, 1), 8: ("crate", 0.7, 0.85, 0.14, 1)},
        small={4: ("ice", 0.6, 0.8, 0.06, 2), 5: ("shrub", 0.6, 0.8, 0.12, 3), 6: ("drift", 0.7, 0.95, 0.03, 2)},
    ),
    "volcanic": dict(
        scale=dict(ground=0.44, ground2=0.46, rough=0.44, rock=0.5, liquid=0.6, road=0.42, forest=0.6),
        ground2_cover=0.34,
        lowfreq=(0.08, 0.03),
        water=dict(  # lava
            near_mul=(1.0, 1.0, 1.0), near_add=(0.0, 0.0, 0.0),
            deep_mul=(1.0, 1.0, 1.0), deep_add=(0.0, 0.0, 0.0),
            clarity=1.0, bed="rock", bed_mul=(1.0, 1.0, 1.0),
            sh_mul=(1.0, 1.0, 1.0), sh_add=(0.0, 0.0, 0.0), sh_opacity=0.5,
            foam=(1.0, 0.8, 0.4), wet=0.0,
        ),
        rock_h=1.0, forest_h=0.12, tree_h=0.45,
        rail=(0.5, 0.48, 0.46), deck_tint=(0.85, 0.82, 0.8), deck_glow=True,
        stain=(0.85, 0.8, 0.76), crystal_tint=(0.9, 1.0, 0.92), coal=(0.1, 0.095, 0.09), radium=(0.07, 0.16, 0.12),
        road_contrast=1.15, road_mul=(0.9, 0.88, 0.86), road_curb=0.25,
        forest_mul=1.22, tree_spacing=0.7, tree_density=1.0, tree_bright=1.18,
        rock_rim=0.2, rock_mul=(1.15, 1.12, 1.12),
        grade=dict(sat=1.06, contrast=1.08, lift=(0.012, 0.004, 0.0), gain=(1.03, 1.0, 0.96), gamma=1.0),
        shadow_col=(0.45, 0.45, 0.52), shadow_k=0.75,
        trees=[0, 1, 2], tree_size=(1.25, 1.6),
        big={3: ("boulder", 0.8, 1.05, 0.3, 5), 5: ("fumarole", 0.9, 1.1, 0.12, 2), 7: ("wreck", 1.05, 1.25, 0.18, 1)},
        small={4: ("lavarocks", 0.6, 0.8, 0.08, 3), 6: ("debris", 0.65, 0.85, 0.06, 2), 8: ("sulfur", 0.55, 0.7, 0.1, 1)},
    ),
    # Coral Archipelago at midday: white beaches round low jungle islands, turquoise lagoons
    # falling away past a line of surf into sapphire open sea (Terrain.Deep).
    "tropical": dict(
        scale=dict(ground=0.42, ground2=0.42, rough=0.44, rock=0.5, liquid=0.6, road=0.32, forest=0.6),
        ground2_cover=0.18, ground2_tint=(1.02, 1.01, 0.97),
        ground_tint=(0.94, 0.95, 0.88),
        beach=1.1,  # ground2 (white coral sand) forced into a band this many tiles wide along every wet edge
        lowfreq=(0.05, 0.025),
        water=dict(
            near_mul=(0.62, 1.08, 1.0), near_add=(0.01, 0.1, 0.08),
            deep_mul=(0.14, 0.48, 0.55), deep_add=(0.0, 0.03, 0.06), depth_reach=2.6,
            clarity=0.65, bed="ground2", bed_mul=(0.75, 0.98, 0.96),
            sh_mul=(0.85, 1.15, 1.12), sh_add=(0.05, 0.2, 0.2), sh_opacity=0.3, ford_stones=True,
            foam=(0.96, 0.99, 0.98), wet=0.22, drop=0.1,
            # the open sea: abyss colour, how far (tiles) past the reef it takes over, swells, surf, coral
            abyss=(0.06, 0.18, 0.26), abyss_mix=0.62, abyss_reach=1.6, abyss_far=(0.3, 8.0),
            swell=0.055, surf=0.85, coral=0.4,
        ),
        rock_h=1.0, forest_h=0.55, tree_h=0.9,
        rock_mul=(1.12, 1.1, 1.1), rock_notch=0.4,
        forest_mul=(0.98, 1.02, 1.0), tree_tint=(0.97, 1.0, 1.0),
        rail=(0.42, 0.37, 0.31), deck_tint=(1.0, 1.0, 1.0), deck="planks", wood=(0.6, 0.53, 0.45),
        bridge_reach=24,  # each Archipelago bridge spans ~20 tiles of sea
        trestle=1.5,      # timber trestles: a bent every 1.5 tiles
        road_blur=0.75, road_wobble=0.45,
        stain=(0.82, 0.78, 0.72), crystal_tint=(0.9, 1.0, 0.93), road_curb=0.06,
        road_mul=(1.0, 0.97, 0.92),
        grade=dict(sat=1.1, contrast=1.05, lift=(0.0, 0.006, 0.012), gain=(1.01, 1.01, 0.99), gamma=1.0),
        shadow_col=(0.42, 0.56, 0.62), shadow_k=0.8,
        trees=[0, 1, 2], tree_size=(1.15, 1.6), tree_w=[0.45, 0.35, 0.2],
        rough_big_mul=2.5,  # mangroves (and driftwood, boulders) standing in the mudflats
        rough_soft=2.5,
        big={2: ("mangrove", 0.8, 1.1, 0.5, 6), 3: ("boulder", 0.85, 1.1, 0.3, 4), 5: ("log", 0.95, 1.2, 0.12, 3),
             7: ("wreck", 1.2, 1.45, 0.18, 1), 8: ("crate", 0.7, 0.85, 0.14, 2)},
        small={4: ("coral", 0.55, 0.75, 0.03, 3), 6: ("bush", 0.6, 0.85, 0.14, 3)},
        small_shore=("coral",),  # only within a couple of tiles of the water
    ),
}

# Per-map tweaks on top of the biome defaults.
MAP_OVERRIDES: dict[str, dict] = {
    # Rocky, dry grassland: more exposed dirt, drier grass, more stones.
    "proving-grounds": dict(ground2_cover=0.4, ground_tint=(1.0, 0.95, 0.78), ground_sat=0.72,
                            small_ground_p=0.05, ground2_scale_tiles=5.0, pebbles=1.0, rock_boulder_p=0.16),
}


# ------------------------------------------------------------------ utils ---

def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def upsample(a: np.ndarray, H: int, W: int) -> np.ndarray:
    """Bilinear resize of a float field to (H, W)."""
    return np.asarray(Image.fromarray(a.astype(np.float32), "F").resize((W, H), Image.BILINEAR))


def lum(c: np.ndarray) -> np.ndarray:
    return c[..., 0] * 0.299 + c[..., 1] * 0.587 + c[..., 2] * 0.114


def detail(c: np.ndarray, sigma: float = 3.0) -> np.ndarray:
    """Normalised high-pass luminance, used to make blend edges follow texture shapes."""
    L = lum(c)
    d = L - ndi.gaussian_filter(L, sigma)
    return d / (d[::5, ::5].std() + 1e-6)


def hmask(e: np.ndarray, feather: float, det: np.ndarray | float, k: float = 0.9) -> np.ndarray:
    """Height-blend mask: edge at e == 0 (px), displaced by texture detail."""
    return sstep(-1.0, 1.0, e / feather + k * det)


class Noise:
    """Seeded smooth noise fields (Gaussian-filtered white noise, upsampled)."""

    def __init__(self, seed: int):
        self.rng = np.random.default_rng(seed)

    def octave(self, H: int, W: int, feat: float) -> np.ndarray:
        cell = max(feat / 2.0, 1.0)
        gh = int(math.ceil(H / cell)) + 4
        gw = int(math.ceil(W / cell)) + 4
        g = self.rng.standard_normal((gh, gw)).astype(np.float32)
        g = ndi.gaussian_filter(g, 1.0, mode="wrap")
        g /= g.std() + 1e-6
        if cell == 1.0:
            return g[2:2 + H, 2:2 + W]
        a = np.asarray(Image.fromarray(g, "F").resize((int(round(gw * cell)), int(round(gh * cell))), Image.BICUBIC))
        o = int(cell * 2)
        return a[o:o + H, o:o + W]

    def fbm(self, H: int, W: int, feat: float, octaves: int = 4, persistence: float = 0.5) -> np.ndarray:
        total = np.zeros((H, W), np.float32)
        amp, norm, f = 1.0, 0.0, feat
        for _ in range(octaves):
            if f < 1.5:
                break
            total += amp * self.octave(H, W, f)
            norm += amp * amp
            amp *= persistence
            f /= 2.0
        total /= math.sqrt(norm)
        s = total[::7, ::7].std()
        return total / (s + 1e-6)


def tile_sdf(mask: np.ndarray, blur: float = 0.3, lr: int = 12, pad: int = 4) -> np.ndarray:
    """Signed distance (in output px, positive inside) to the boundary of a tile mask,
    smoothed by a Gaussian of ``blur`` tiles (rounds corners), at full resolution."""
    h, w = mask.shape
    if not mask.any():
        return np.full((h * PX, w * PX), -1e4, np.float32)
    if mask.all():
        return np.full((h * PX, w * PX), 1e4, np.float32)
    m = np.pad(mask, pad, mode="edge")
    big = np.repeat(np.repeat(m, lr, 0), lr, 1)
    din = ndi.distance_transform_edt(big)
    dout = ndi.distance_transform_edt(~big)
    sdf = np.where(big, din - 0.5, 0.5 - dout).astype(np.float32)
    if blur > 0:
        sdf = ndi.gaussian_filter(sdf, blur * lr)
    sdf = sdf[pad * lr: -pad * lr, pad * lr: -pad * lr] * (PX / lr)
    return upsample(sdf, h * PX, w * PX)


def shift(a: np.ndarray, dy: int, dx: int, fill: float) -> np.ndarray:
    out = np.full_like(a, fill)
    H, W = a.shape[:2]
    ys, yd = (slice(0, H - dy), slice(dy, H)) if dy >= 0 else (slice(-dy, H), slice(0, H + dy))
    xs, xd = (slice(0, W - dx), slice(dx, W)) if dx >= 0 else (slice(-dx, W), slice(0, W + dx))
    out[yd, xd] = a[ys, xs]
    return out


def cast_shadow(Hf: np.ndarray, soft: float, maxlen: int = 128) -> np.ndarray:
    """0..1 shadow amount from height field (px units), light from upper-left."""
    occ = Hf.copy()
    step = 1
    drop = SUN_SLOPE * math.sqrt(2.0)
    while step < maxlen:
        np.maximum(occ, shift(occ, step, step, -1e6) - drop * step, out=occ)
        step *= 2
    s = np.clip((occ - Hf) / soft, 0.0, 1.0)
    return ndi.gaussian_filter(s, 1.6)


def hillshade(Hf: np.ndarray) -> np.ndarray:
    """Relative diffuse shade (1 == flat) for light from the upper left at 45 deg."""
    gy, gx = np.gradient(Hf)
    L = np.array([-1.0, -1.0, math.sqrt(2.0)])
    L /= np.linalg.norm(L)
    n = 1.0 / np.sqrt(gx * gx + gy * gy + 1.0)
    d = (-gx * L[0] - gy * L[1] + L[2]) * n
    return d / L[2]


def swell_field(noise: Noise, H: int, W: int, angle: float, along: float, across: float) -> np.ndarray:
    """Long streaks (unit std): white noise blurred far more along one direction than across
    it, turned to `angle` degrees; worked at quarter resolution."""
    h4, w4 = H // 4, W // 4
    D = int(math.ceil(math.hypot(h4, w4))) + 8
    g = noise.rng.standard_normal((D, D)).astype(np.float32)
    g = ndi.gaussian_filter(g, (across / 4, along / 4), mode="wrap")
    g = ndi.rotate(g, angle, reshape=False, order=1, mode="wrap")
    oy, ox = (D - h4) // 2, (D - w4) // 2
    g = g[oy:oy + h4, ox:ox + w4]
    g = g / (g.std() + 1e-6)
    return upsample(g, H, W)


# --------------------------------------------------------------- textures ---

_TEX_CACHE: dict[tuple[str, str, float], np.ndarray] = {}


def _wrap_blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur wrapping round the edges (for the seamless helpers shared with art/textures.py)."""
    return ndi.gaussian_filter(a, sigma, mode="wrap")


FLATTEN = dict(ground=0.7, ground2=0.6, rough=0.6, rock=0.5, liquid=0.35, road=0.6, forest=0.5)


def get_texture(biome: str, mat: str, scale: float) -> np.ndarray:
    key = (biome, mat, scale)
    if key in _TEX_CACHE:
        return _TEX_CACHE[key]
    src = np.asarray(Image.open(RAW / f"tex-{biome}-{mat}.webp").convert("RGB"), np.float32) / 255.0
    rng = np.random.default_rng([ord(c) for c in biome + mat])
    a = make_seamless(src, rng, _wrap_blur)
    a = flatten(a, FLATTEN.get(mat, 0.5), _wrap_blur)
    N = a.shape[0]
    n = max(16, int(round(N * scale)))
    big = np.tile(a, (3, 3, 1))
    im = Image.fromarray((np.clip(big, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
    im = im.resize((3 * n, 3 * n), Image.LANCZOS)
    t = np.asarray(im, np.float32)[n:2 * n, n:2 * n] / 255.0
    _TEX_CACHE[key] = t
    return t


def dihedral(t: np.ndarray, k: int) -> np.ndarray:
    t = np.rot90(t, k % 4)
    return t[:, ::-1] if k >= 4 else t


def tiled(t: np.ndarray, H: int, W: int, k: int, oy: int, ox: int) -> np.ndarray:
    v = dihedral(t, k)
    n = v.shape[0]
    reps = (int(math.ceil((H + n) / n)), int(math.ceil((W + n) / n)))
    return np.tile(v, (reps[0], reps[1], 1))[oy % n: oy % n + H, ox % n: ox % n + W]


def tex_layer(t: np.ndarray, H: int, W: int, rng, noise: Noise, variants: int = 3, feat: float = 4.5 * PX,
              sharp: float = 3.0) -> np.ndarray:
    """Anti-tiled full-image layer: several dihedral/offset copies mixed by noise."""
    n = t.shape[0]
    ks = rng.permutation(8)[:variants]
    m = t.mean((0, 1))
    num = np.zeros((H, W, 3), np.float32)
    ws = []
    for i in range(variants):
        w = np.exp(sharp * noise.fbm(H // 4, W // 4, feat / 4, octaves=2))
        ws.append(upsample(w, H, W))
    tot = sum(ws)
    sq = np.zeros((H, W), np.float32)
    for i in range(variants):
        w = ws[i] / tot
        num += (tiled(t, H, W, int(ks[i]), int(rng.integers(n)), int(rng.integers(n))) - m) * w[..., None]
        sq += w * w
    return np.clip(m + num / np.sqrt(sq)[..., None], 0.0, 1.0)


def sample_bilinear(t: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Sample periodic texture t at float coords (u = x, v = y)."""
    n = t.shape[0]
    x0 = np.floor(u)
    y0 = np.floor(v)
    fx = (u - x0)[..., None].astype(np.float32)
    fy = (v - y0)[..., None].astype(np.float32)
    x0 = x0.astype(np.int64) % n
    y0 = y0.astype(np.int64) % n
    x1 = (x0 + 1) % n
    y1 = (y0 + 1) % n
    a = t[y0, x0] * (1 - fx) + t[y0, x1] * fx
    b = t[y1, x0] * (1 - fx) + t[y1, x1] * fx
    return a * (1 - fy) + b * fy


def streak_angle(t: np.ndarray) -> float:
    """Dominant streak orientation of a texture (radians, image coords); 0 when the
    texture has no clear direction (or is a grid of plates, which should stay axis-aligned)."""
    L = ndi.gaussian_filter(lum(t), max(2.0, t.shape[0] / 85))
    gy, gx = np.gradient(L)
    jxx, jyy, jxy = (gx * gx).mean(), (gy * gy).mean(), (gx * gy).mean()
    coh = math.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2) / (jxx + jyy + 1e-12)
    if coh < 0.15:
        return 0.0
    theta = 0.5 * math.atan2(2 * jxy, jxx - jyy)  # dominant gradient direction
    return theta + math.pi / 2


# ---------------------------------------------------------------- doodads ---

_SPRITES: dict[str, list[Image.Image]] = {}


def get_sprites(biome: str) -> list[Image.Image]:
    """Split the 3x3 doodad sheet into 9 premultiplied RGBA crops (row-major)."""
    if biome in _SPRITES:
        return _SPRITES[biome]
    im = Image.open(RAW / f"doodads-{biome}.webp").convert("RGBA")
    a = np.asarray(im)
    al = a[..., 3]
    lab, n = ndi.label(al > 24)
    objs = ndi.find_objects(lab)
    sizes = ndi.sum(np.ones_like(al), lab, range(1, n + 1))
    cells: dict[tuple[int, int], list] = {}
    S = im.size[0] / 3.0
    for sl, s in zip(objs, sizes):
        if s < 30:
            continue
        cy = (sl[0].start + sl[0].stop) / 2
        cx = (sl[1].start + sl[1].stop) / 2
        cells.setdefault((min(2, int(cy // S)), min(2, int(cx // S))), []).append(sl)
    out = []
    for r in range(3):
        for c in range(3):
            L = cells[(r, c)]
            y0 = max(0, min(s[0].start for s in L) - 4)
            y1 = min(im.size[1], max(s[0].stop for s in L) + 4)
            x0 = max(0, min(s[1].start for s in L) - 4)
            x1 = min(im.size[0], max(s[1].stop for s in L) + 4)
            out.append(im.crop((x0, y0, x1, y1)).convert("RGBa"))
    _SPRITES[biome] = out
    return out


def prep_sprite(spr: Image.Image, size_px: float, angle: float, flip: bool) -> np.ndarray:
    """Scale so the longest side is size_px, rotate; returns premultiplied float RGBA."""
    w, h = spr.size
    s = size_px / max(w, h)
    im = spr.resize((max(2, int(round(w * s * 2))), max(2, int(round(h * s * 2)))), Image.LANCZOS)
    if flip:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    if abs(angle) > 0.5:
        im = im.rotate(angle, resample=Image.BICUBIC, expand=True)
    im = im.resize((max(1, im.size[0] // 2), max(1, im.size[1] // 2)), Image.LANCZOS)
    return np.asarray(im, np.float32) / 255.0


def paste(img: np.ndarray, Hf: np.ndarray | None, spr: np.ndarray, cx: float, cy: float,
          height: float = 0.0, tint=(1.0, 1.0, 1.0), dome: bool = False) -> None:
    """Alpha-composite a premultiplied sprite centred at (cx, cy) px; raise height field."""
    sh, sw = spr.shape[:2]
    x0 = int(round(cx - sw / 2))
    y0 = int(round(cy - sh / 2))
    H, W = img.shape[:2]
    ax0, ay0 = max(0, x0), max(0, y0)
    ax1, ay1 = min(W, x0 + sw), min(H, y0 + sh)
    if ax1 <= ax0 or ay1 <= ay0:
        return
    s = spr[ay0 - y0: ay1 - y0, ax0 - x0: ax1 - x0]
    a = s[..., 3:4]
    rgb = s[..., :3] * np.asarray(tint, np.float32)
    reg = img[ay0:ay1, ax0:ax1]
    reg *= 1.0 - a
    reg += rgb
    if Hf is not None and height > 0:
        al = a[..., 0]
        if dome:
            yy, xx = np.mgrid[ay0 - y0: ay1 - y0, ax0 - x0: ax1 - x0]
            r = np.sqrt(((xx - sw / 2) / (sw / 2)) ** 2 + ((yy - sh / 2) / (sh / 2)) ** 2)
            prof = 0.55 + 0.45 * np.sqrt(np.clip(1 - r * r, 0, 1))
        else:
            prof = 1.0
        hreg = Hf[ay0:ay1, ax0:ax1]
        solid = al > 0.5
        base = float(hreg[solid].min()) if solid.any() else 0.0  # ground under the sprite
        cand = np.where(al > 0.02, al * prof * height + base, 0.0)
        np.maximum(hreg, cand, out=hreg)


# ------------------------------------------------------------------- map ---

def load_map(mid: str) -> dict:
    d = json.loads((MAPS_DIR / f"{mid}.json").read_text())
    d["grid"] = np.array([[int(c, 36) for c in row] for row in d["terrain"]], np.int8)  # base-36: Deep is "a"
    return d


def render(mid: str, debug: bool = False) -> dict:
    t0 = time.time()
    d = load_map(mid)
    T = d["grid"]
    h, w = T.shape
    H, W = h * PX, w * PX
    biome = d["biome"]
    cfg = dict(BIOMES[biome])
    cfg.update(MAP_OVERRIDES.get(mid, {}))
    seed = int(d["seed"])
    rng = np.random.default_rng([seed, 1])
    noise = Noise(seed * 7919 + 17)
    volcanic = biome == "volcanic"
    has = {c: bool((T == c).any()) for c in range(11)}

    def tex(mat):
        return get_texture(biome, mat, cfg["scale"][mat])

    # ---- shared noise fields for organic edges
    n_edge = noise.fbm(H, W, 0.9 * PX, octaves=4, persistence=0.55)   # boundary wobble
    n_fine = noise.fbm(H, W, 0.22 * PX, octaves=2)                     # crisp jaggies
    n_big = noise.fbm(H // 4, W // 4, 3 * PX / 4, octaves=3)
    n_big = upsample(n_big, H, W)

    def sdf(codes, blur=0.3):
        return tile_sdf(np.isin(T, codes), blur=blur)

    wetcodes = [WATER, SHALLOWS, BRIDGE, DEEP]
    any_wet = has[WATER] or has[SHALLOWS] or has[DEEP]
    sd_wet = sdf(wetcodes, blur=0.42) if any_wet else None  # signed distance to the water's edge (px)

    # ---- 1. base ground: ground + ground2 patches + low-frequency variation
    img = tex_layer(tex("ground"), H, W, rng, noise)
    if "ground_tint" in cfg:
        img *= np.asarray(cfg["ground_tint"], np.float32)
    if "ground_sat" in cfg:
        L = lum(img)[..., None]
        img = L + (img - L) * cfg["ground_sat"]
    g2 = tex_layer(tex("ground2"), H, W, rng, noise, variants=2)
    if "ground2_tint" in cfg:
        g2 *= np.asarray(cfg["ground2_tint"], np.float32)
    g2s = cfg.get("ground2_scale_tiles", 7.0)
    f = noise.fbm(H // 4, W // 4, g2s * PX / 4, octaves=5, persistence=0.55)
    f = upsample(f, H, W) + 0.18 * n_edge
    thr = np.quantile(f[::9, ::9], 1.0 - cfg["ground2_cover"])
    La, Lb = lum(img), lum(g2)
    da = La - ndi.gaussian_filter(La, 3)
    db = Lb - ndi.gaussian_filter(Lb, 3)
    x = (f - thr) / 0.45 + 0.8 * (db / (db.std() + 1e-6) - da / (da.std() + 1e-6))
    g2max = cfg.get("ground2_max", 0.92)
    if cfg.get("beach", 0.0) > 0 and sd_wet is not None:
        # a beach: ground2 forced up into a band `beach` tiles wide along every wet edge
        # (its inland edge wobbles and follows the textures' detail like the other patches)
        band = sstep(-0.35 * PX, 0.25 * PX, sd_wet + cfg["beach"] * PX + 0.3 * PX * n_edge)
        x = x + 4.0 * band
        g2max = g2max + (1.0 - g2max) * band
        del band
    m2 = sstep(-1.2, 1.2, x) * g2max
    del La, Lb, da, db, x
    img = img * (1 - m2[..., None]) + g2 * m2[..., None]
    del g2
    lb, lw = cfg["lowfreq"]
    nb = upsample(noise.fbm(H // 8, W // 8, 10 * PX / 8, octaves=3), H, W)
    nw = upsample(noise.fbm(H // 8, W // 8, 14 * PX / 8, octaves=2), H, W)
    img = ndi.gaussian_filter(img, (SOFTEN, SOFTEN, 0))
    img *= (1.0 + lb * nb)[..., None]
    img *= np.stack([1 + lw * nw, np.ones_like(nw), 1 - lw * nw], -1)

    Hterr = np.zeros((H, W), np.float32)   # height field for cast shadows
    ao = np.zeros((H, W), np.float32)      # ambient-occlusion darkening 0..1

    # ---- 2. coal fields (Scrap: blackened earth, coal-dust stains) / radium fields (Crystal: faint
    #         pale blue-green glow in the soil); the game draws the coal heaps and radium itself
    rough_t = tex("rough")
    if has[SCRAP] or has[CRYSTAL]:
        rl = tex_layer(rough_t, H, W, rng, noise, variants=2)
        det = detail(rl) - detail(img)
        blot = noise.fbm(H, W, 0.35 * PX, octaves=3)
        for code in (SCRAP, CRYSTAL):
            if not has[code]:
                continue
            e = sdf([code], blur=0.4) + 0.2 * PX * n_edge + 0.06 * PX * n_fine + 0.08 * PX
            m = hmask(e, 0.12 * PX, det) * cfg.get("stain_opacity", 0.9)
            st = img * 0.2 + rl * 0.8
            st = st * np.asarray(cfg["stain"], np.float32)
            dark = sstep(0.2, 1.3, blot) * sstep(0.0, 0.5 * PX, e)
            L = lum(st)[..., None]
            if code == SCRAP:
                # charcoal-black earth keeping the material's grain, darker coal-dust blotches inward
                coal = np.asarray(cfg.get("coal", (0.23, 0.215, 0.2)), np.float32)
                grain = L / (float(L[::7, ::7].mean()) + 1e-6)
                st = coal * (0.55 + 0.45 * grain) * (1 - 0.4 * dark[..., None])
                st = st + np.asarray((0.012, 0.012, 0.016), np.float32) * sstep(1.2, 2.2, blot)[..., None]  # faint sheen
            else:
                st = st * (1 - 0.15 * dark[..., None])
                st = L + (st - L) * 0.55  # desaturate
                st = st * np.asarray(cfg["crystal_tint"], np.float32)
                # radium: a faint pale blue-green glow welling up toward the middle, carried by
                # glinting grains (a flat wash alone would read as a puddle)
                inner = sstep(0.0, 0.7 * PX, e)
                glow = inner * (0.5 + 0.5 * sstep(-0.5, 1.2, blot))
                st = st + np.asarray(cfg.get("radium", (0.05, 0.12, 0.09)), np.float32) * glow[..., None]
                grains = sstep(1.6, 2.6, noise.fbm(H, W, 0.12 * PX, octaves=2)) * sstep(0.0, 0.3 * PX, e)
                grains = np.clip(ndi.gaussian_filter(grains, 0.8) * 1.8, 0, 1)
                st = st + np.asarray((0.42, 0.8, 0.62), np.float32) * (0.55 * grains)[..., None]
            img = img * (1 - m[..., None]) + st * m[..., None]
        del rl, det

    # ---- 3. rough ground (also underlays water banks so no grass gaps show)
    if has[ROUGH]:
        e_rough = sdf([ROUGH] + wetcodes, blur=0.32) + 0.2 * PX * n_edge + 0.07 * PX * n_fine
        rl = ndi.gaussian_filter(tex_layer(rough_t, H, W, rng, noise), (SOFTEN * 0.8, SOFTEN * 0.8, 0))
        if "rough_soft" in cfg:  # smoother, less speckled edges (a dark mud against pale sand)
            det = ndi.gaussian_filter(detail(rl) - detail(img), cfg["rough_soft"])
            m = hmask(e_rough, 0.12 * PX, det / (det[::5, ::5].std() + 1e-6))
            del det
        else:
            m = hmask(e_rough, 0.1 * PX, detail(rl) - detail(img))
        # the underlay beneath water only near real rough tiles (no mud rim on grassy shores)
        m *= sstep(-1.1 * PX, -0.55 * PX, tile_sdf(T == ROUGH, blur=0.3))
        img = img * (1 - m[..., None]) + rl * m[..., None]
        del rl

    # ---- 3b. scattered stones embedded in open ground (flat, purely decorative)
    peb = cfg.get("pebbles", 0.0)
    if peb > 0:
        open_ground = np.isin(T, [GROUND, ROUGH])
        allow = sstep(0.1 * PX, 0.4 * PX, tile_sdf(open_ground, blur=0.3))
        clus = upsample(noise.fbm(H // 8, W // 8, 5 * PX / 8, octaves=2), H, W)
        nz = noise.fbm(H, W, 0.22 * PX, octaves=2, persistence=0.4)
        thr = 2.85 - 0.35 * peb - 0.45 * clus
        stone = sstep(thr, thr + 0.35, nz) * allow
        if stone.max() > 0:
            hs = ndi.gaussian_filter(stone, 1.2) * 6.0
            sh = np.clip(hillshade(hs), 0.3, 1.8)
            rkl = tex("rock")
            st_rgb = tiled(rkl, H, W, 3, 37, 91) * 1.12 + 0.03
            st_rgb = st_rgb * (0.35 + 0.65 * sh)[..., None]
            ms = np.clip(stone * 1.4, 0, 1)[..., None]
            img = img * (1 - ms) + st_rgb * ms
            Hterr = np.maximum(Hterr, hs)
            del hs, sh, st_rgb, ms
        del clus, nz, stone, allow

    # ---- 4. roads
    road_t = tex("road")
    if has[ROAD] or has[BRIDGE]:
        rs = tile_sdf(np.isin(T, [ROAD, BRIDGE]), blur=cfg.get("road_blur", 0.45))
        if "road_wobble" in cfg:  # built roads (boardwalks) keep straighter edges
            e_road = rs + cfg["road_wobble"] * (0.07 * PX * n_edge + 0.035 * PX * n_fine)
        else:
            e_road = rs + 0.07 * PX * n_edge + 0.035 * PX * n_fine
        m_road = sstep(-1.2, 1.2, e_road)
        verge = sstep(-0.32 * PX, -0.02 * PX, e_road) * (1 - m_road)
        # shoulders: gravelly and darker
        vr = sstep(-0.2 * PX, 0.0, e_road + 0.06 * PX * n_fine) * (1 - m_road)
        img = img * (1 - 0.22 * verge[..., None])
        img = img * (1 - 0.35 * vr[..., None]) + rough_t.mean((0, 1)) * 0.8 * 0.35 * vr[..., None]
        # oriented texture: blend 4 orientations by local road direction
        lowm = ndi.gaussian_filter(np.isin(T, [ROAD, BRIDGE]).astype(np.float32), 0.9)
        gy, gx = np.gradient(lowm)
        jxx = ndi.gaussian_filter(gx * gx, 1.2)
        jyy = ndi.gaussian_filter(gy * gy, 1.2)
        jxy = ndi.gaussian_filter(gx * gy, 1.2)
        theta = 0.5 * np.arctan2(2 * jxy, jxx - jyy) + math.pi / 2  # road direction
        theta = upsample(np.cos(2 * theta), H, W), upsample(np.sin(2 * theta), H, W)
        ys, xs = np.nonzero(m_road > 0.002)
        c2, s2 = theta[0][ys, xs], theta[1][ys, xs]
        ang = 0.5 * np.arctan2(s2, c2)
        native = streak_angle(road_t)
        acc = np.zeros((len(ys), 3), np.float32)
        wsum = np.zeros(len(ys), np.float32)
        oy, ox = rng.integers(road_t.shape[0], size=2)
        for phi in (0.0, math.pi / 4, math.pi / 2, 3 * math.pi / 4):
            wk = np.clip(np.cos(2 * (ang - phi)), 0, 1) ** 4
            sel = wk > 1e-3
            if not sel.any():
                continue
            rot = native - phi  # rotate texture streaks onto phi
            cr, sr = math.cos(rot), math.sin(rot)
            u = cr * xs[sel] - sr * ys[sel] + ox
            v = sr * xs[sel] + cr * ys[sel] + oy
            acc[sel] += sample_bilinear(road_t, u, v) * wk[sel, None]
            wsum[sel] += wk[sel]
        road_rgb = acc / np.maximum(wsum, 1e-4)[:, None]
        rm = road_t.mean((0, 1))
        road_rgb = (rm + (road_rgb - rm) * cfg.get("road_contrast", 1.0)) * np.asarray(
            cfg.get("road_mul", (1.0, 1.0, 1.0)), np.float32)
        # slight worn darkening toward the edges + low-frequency variation
        edge = sstep(0.28 * PX, 0.0, e_road[ys, xs])
        curb = sstep(0.07 * PX, 0.02 * PX, e_road[ys, xs]) * cfg.get("road_curb", 0.0)
        road_rgb *= (1 - 0.18 * edge - curb)[:, None] * (1 + 0.06 * n_big[ys, xs])[:, None]
        mm = m_road[ys, xs][:, None]
        img[ys, xs] = img[ys, xs] * (1 - mm) + road_rgb * mm
        del theta, acc, ys, xs
    else:
        m_road = np.zeros((H, W), np.float32)

    # ---- 5. water / lava and shallows
    m_water = np.zeros((H, W), np.float32)
    m_lava = np.zeros((H, W), np.float32)
    sd_deep = None
    if any_wet:
        wc = cfg["water"]
        e_wet = sd_wet + 0.13 * PX * n_edge + 0.035 * PX * n_fine
        m_water = sstep(-1.5, 1.5, e_wet)
        sd_deep = sdf([WATER, BRIDGE, DEEP], blur=0.42)
        e_deep = sd_deep + 0.1 * PX * n_edge + 0.03 * PX * n_fine
        m_deep = sstep(-1.5, 1.5, e_deep) * m_water
        liq = ndi.gaussian_filter(tex_layer(tex("liquid"), H, W, rng, noise, feat=3.5 * PX), (0.5, 0.5, 0))
        bed = tex_layer(tex(wc["bed"]), H, W, rng, noise, variants=2) * np.asarray(wc["bed_mul"], np.float32)
        if "bed_color" in wc:  # recolour the bed (e.g. sandy gravel) keeping its detail
            Lb = lum(bed)
            bed = (0.35 + 0.65 * Lb / (Lb.mean() + 1e-6))[..., None] * np.asarray(wc["bed_color"], np.float32)
        if not volcanic:
            # land side: wet darker band
            wet = sstep(-0.3 * PX, 0.0, e_wet) * (1 - m_water) * wc["wet"]
            img *= (1 - wet[..., None] * np.array([1.0, 0.95, 0.85], np.float32))
            depth = np.clip(e_deep / (wc.get("depth_reach", 1.7) * PX), 0, 1) ** 0.75
            if has[SHALLOWS]:
                # a distinct drop-off where deep water meets fordable shallows
                near_sh = sstep(-1.4 * PX, -0.4 * PX, tile_sdf(T == SHALLOWS, blur=0.42))
                depth = np.maximum(depth, (0.5 + 0.5 * depth) * near_sh)
            dd = depth[..., None]
            nm = np.asarray(wc["near_mul"], np.float32)
            dm = np.asarray(wc["deep_mul"], np.float32)
            na = np.asarray(wc["near_add"], np.float32)
            da = np.asarray(wc["deep_add"], np.float32)
            deep_col = liq * (nm + (dm - nm) * dd) + (na + (da - na) * dd)
            clar = wc["clarity"] * (1 - dd) ** 1.5
            deep_col = deep_col * (1 - clar) + bed * 0.8 * clar
            # drop-off edge: darker line just inside deep water
            drop = sstep(0.0, 0.1 * PX, e_deep) * sstep(0.35 * PX, 0.05 * PX, e_deep)
            deep_col *= (1 - wc.get("drop", 0.22) * drop)[..., None]
            if has[DEEP]:
                # the open sea past the coastal shelf: a second, darker drop-off and a
                # long fall into the abyss colour, so islands sit in rings of light water.
                # A bridge out over the sea counts as sea (only its ends stand in the shelf).
                wet_t = np.isin(T, wetcodes)
                offshore = (T == BRIDGE) & (ndi.distance_transform_edt(wet_t) > 1.5)
                e_abyss = tile_sdf((T == DEEP) | offshore, blur=0.5) + 0.25 * PX * n_edge + 0.05 * PX * n_fine
                del wet_t, offshore
                if wc.get("coral", 0.0) > 0:
                    # faint coral heads (pink, ochre, olive) under the film on the reef flat near the drop
                    cm = sstep(0.35, 1.15, noise.fbm(H, W, 0.32 * PX, octaves=3))
                    cm *= sstep(-1.6 * PX, -0.7 * PX, e_abyss) * sstep(0.0, -0.15 * PX, e_abyss)
                    cm *= sstep(0.25 * PX, 0.7 * PX, e_deep)  # not in the swash at the beach
                    hue = noise.fbm(H // 4, W // 4, 1.2 * PX / 4, octaves=2)
                    hue = upsample(hue, H, W)[..., None]
                    pink = np.array([1.75, 0.82, 0.86], np.float32)
                    ochre = np.array([1.7, 1.02, 0.62], np.float32)
                    olive = np.array([1.15, 0.98, 0.62], np.float32)
                    tint = np.where(hue > 0.35, pink, np.where(hue < -0.35, olive, ochre))
                    tint = ndi.gaussian_filter(tint, (2.0, 2.0, 0))
                    a = (wc["coral"] * cm)[..., None]
                    deep_col = deep_col * (1 - a) + deep_col * tint * a
                    del cm, hue, tint, a
                r1, mix1 = wc.get("abyss_reach", 3.5), wc.get("abyss_mix", 0.7)
                ab = sstep(-0.2 * PX, r1 * PX, e_abyss) ** 0.8 * mix1
                if "abyss_far" in wc:  # and on into the abyss colour far from any shore
                    mix2, r2 = wc["abyss_far"]
                    ab = ab + mix2 * sstep(0.5 * r1 * PX, r2 * PX, e_abyss)
                ab = ab[..., None]
                abyss = np.asarray(wc.get("abyss", (0.02, 0.08, 0.16)), np.float32)
                deep_col = deep_col * (1 - ab) + abyss * ab
                ledge = sstep(-0.1 * PX, 0.05 * PX, e_abyss) * sstep(0.4 * PX, 0.1 * PX, e_abyss)
                deep_col *= (1 - 0.18 * ledge)[..., None]
                sea = sstep(0.1 * PX, 1.5 * PX, e_abyss)
                if wc.get("swell", 0.0) > 0:
                    # the sea isn't a slab: broad lighter/darker patches and long swell streaks
                    patch = upsample(noise.fbm(H // 8, W // 8, 9 * PX / 8, octaves=3), H, W)
                    sw = swell_field(noise, H, W, angle=-28.0, along=2.6 * PX, across=0.16 * PX)
                    crest = sstep(1.5, 2.9, sw)
                    k = wc["swell"]
                    deep_col *= (1 + sea * (0.6 * k * patch + k * np.clip(sw, -2, 2)))[..., None]
                    deep_col += (0.04 * sea * crest * sstep(-0.5, 1.0, patch))[..., None] * np.array(
                        [0.6, 0.85, 1.0], np.float32)
                    del patch, sw, crest
                if wc.get("surf", 0.0) > 0:
                    # the reef crest: a broken white line of breaking surf just past the drop, a
                    # fainter second line of wave behind it and spray thrown back onto the reef
                    churn = noise.fbm(H, W, 0.3 * PX, octaves=3, persistence=0.6)
                    es = e_abyss + 0.06 * PX * churn
                    line1 = sstep(-0.16 * PX, 0.0, es) * sstep(0.34 * PX, 0.08 * PX, es)
                    line1 *= np.clip(0.55 + 0.75 * churn, 0, 1)
                    line2 = sstep(0.42 * PX, 0.52 * PX, es) * sstep(0.78 * PX, 0.6 * PX, es)
                    line2 *= np.clip(noise.fbm(H, W, 0.45 * PX, octaves=2) - 0.15, 0, 1) * 0.55
                    spray = sstep(-0.55 * PX, -0.05 * PX, es) * sstep(0.1 * PX, -0.05 * PX, es)
                    spray *= sstep(0.9, 1.9, noise.fbm(H, W, 0.1 * PX, octaves=2)) * 0.6
                    fo = (wc["surf"] * np.clip(line1 + line2 + spray, 0, 1))[..., None]
                    deep_col = deep_col * (1 - fo) + np.asarray(wc["foam"], np.float32) * fo
                    del churn, es, line1, line2, spray, fo
                del ab, sea
            # shallows: bed seen through a thin water film + ripples
            L = lum(liq)
            rip = (L - ndi.gaussian_filter(L, 4))[..., None]
            sh_col = bed * (1 - wc["sh_opacity"]) + (liq * np.asarray(wc["sh_mul"], np.float32)
                                                      + np.asarray(wc["sh_add"], np.float32)) * wc["sh_opacity"]
            sh_col = sh_col + 0.6 * rip
            if wc.get("ford_stones", True) and has[SHALLOWS]:
                # rounded stones on the ford bed, seen through the water film
                nz2 = noise.fbm(H, W, 0.26 * PX, octaves=2, persistence=0.35)
                stn = sstep(0.7, 1.15, nz2)
                hs = ndi.gaussian_filter(stn, 1.5) * 7.0
                shs = np.clip(hillshade(hs), 0.4, 1.6)
                stone_col = tiled(tex("rock"), H, W, 5, 11, 53) * np.asarray(wc["sh_mul"], np.float32) * 1.05
                stone_col = stone_col * (0.4 + 0.6 * shs)[..., None]
                sh_col = sh_col * (1 - 0.8 * stn[..., None]) + stone_col * (0.8 * stn[..., None])
                del nz2, stn, hs, shs, stone_col
            # lighter sand-bar rim along the deep edge
            rim = sstep(-0.3 * PX, -0.02 * PX, e_deep) * (1 - m_deep)
            sh_col = sh_col * (1 + 0.16 * rim[..., None])
            wcol = sh_col * (1 - m_deep[..., None]) + deep_col * m_deep[..., None]
            # foam / highlight line at the shore (inside the water edge)
            foam = sstep(0.0, 0.03 * PX, e_wet) * sstep(0.13 * PX, 0.03 * PX, e_wet)
            foam *= np.clip(0.55 + 0.6 * noise.fbm(H, W, 0.3 * PX, octaves=2), 0, 1)
            foam2 = sstep(0.1 * PX, 0.16 * PX, e_wet) * sstep(0.26 * PX, 0.18 * PX, e_wet)
            foam2 *= np.clip(noise.fbm(H, W, 0.25 * PX, octaves=2) - 0.2, 0, 1) * 0.6
            fo = np.clip(foam * 0.55 + foam2 * 0.3, 0, 1)[..., None]
            wcol = wcol * (1 - fo) + np.asarray(wc["foam"], np.float32) * fo
            img = img * (1 - m_water[..., None]) + wcol * m_water[..., None]
            del deep_col, sh_col, wcol, rip
        else:
            # LAVA: molten texture, cooled crust at the edges, emissive boost
            m_lava = m_deep
            lava = liq.copy()
            Ll = lum(lava)
            hot = sstep(0.3, 0.9, Ll)[..., None]
            lava = lava * (1.1 + 0.35 * hot) + np.array([0.05, 0.015, 0.0], np.float32) * hot
            inner = sstep(0.2 * PX, 1.2 * PX, e_deep)[..., None]
            lava = lava * (0.92 + 0.18 * inner)
            crust_n = noise.fbm(H, W, 0.3 * PX, octaves=3)
            crust = sstep(0.42 * PX, 0.04 * PX, e_deep + 0.1 * PX * crust_n)
            crust_col = bed * np.array([0.42, 0.38, 0.36], np.float32)
            # faint glowing cracks in the crust
            cracks = sstep(0.45, 0.8, Ll)[..., None] * np.array([0.7, 0.22, 0.04], np.float32)
            crust_col = crust_col + cracks * 0.55
            cr = (crust * 0.92)[..., None]
            lava = lava * (1 - cr) + crust_col * cr
            # shallows on a volcanic map = thick crusted flow, fordable
            sh_col = bed * 0.55 + cracks * 0.8
            wcol = sh_col * (1 - m_deep[..., None]) + lava * m_deep[..., None]
            # scorched dark rim on land
            scorch = sstep(-0.3 * PX, 0.0, e_wet) * (1 - m_water)
            img *= (1 - 0.45 * scorch)[..., None]
            img = img * (1 - m_water[..., None]) + wcol * m_water[..., None]
            del lava, crust_col, sh_col, wcol
        del liq, bed

    # ---- 6. forest canopy
    e_for = None
    if has[FOREST]:
        e_for = sdf([FOREST], blur=0.3) + 0.2 * PX * n_edge + 0.08 * PX * n_fine
        m_for = sstep(-0.06 * PX, 0.06 * PX, e_for)
        # AO on the ground around woods
        ao = np.maximum(ao, np.exp(np.minimum(e_for, 0) / (0.28 * PX)) * (1 - m_for) * 0.32)
        fm = cfg.get("forest_mul", 1.0)
        can = tex_layer(tex("forest"), H, W, rng, noise) * (np.asarray(fm, np.float32) if isinstance(fm, tuple) else fm)
        Lc = lum(can)
        Hc = cfg["forest_h"] * PX * sstep(0.0, 0.55 * PX, e_for) + 7.0 * (Lc - ndi.gaussian_filter(Lc, 6))
        Hc = ndi.gaussian_filter(Hc, 1.0)
        shade = np.clip(hillshade(Hc), 0.45, 1.5)
        can = can * (0.25 + 0.75 * shade)[..., None]
        # inner canopy slightly darker/denser
        can *= (0.92 + 0.08 * sstep(1.2 * PX, 0.0, e_for))[..., None]
        if cfg.get("embers"):
            em = sstep(2.3, 3.2, noise.fbm(H, W, 0.1 * PX, octaves=2)) * sstep(0.2 * PX, 0.6 * PX, e_for)
            em = ndi.gaussian_filter(em, 1.2) * 1.6
            can = can + np.array([1.0, 0.38, 0.06], np.float32) * np.clip(em, 0, 1)[..., None]
        img = img * (1 - m_for[..., None]) + can * m_for[..., None]
        Hterr = np.maximum(Hterr, Hc * m_for)
        del can, Lc, shade
    else:
        m_for = np.zeros((H, W), np.float32)

    # ---- 7. rock / cliffs
    e_rock = None
    if has[ROCK]:
        e_rock = sdf([ROCK], blur=0.28) + 0.12 * PX * n_edge + 0.05 * PX * n_fine
        m_rock = sstep(-1.3, 1.3, e_rock)
        rk = tex_layer(tex("rock"), H, W, rng, noise)
        Lr = lum(rk)
        hmax = cfg["rock_h"] * PX
        inside = np.maximum(e_rock, 0)
        flank = sstep(0.0, 0.3 * PX, inside) ** 0.8
        ridged = 1.0 - np.abs(noise.fbm(H, W, 1.6 * PX, octaves=3, persistence=0.5))
        top = sstep(0.12 * PX, 0.9 * PX, inside)
        Hr = hmax * flank * (0.85 + 0.15 * n_big)
        Hr += hmax * (0.32 * ridged - 0.08) * top
        Hr += 0.3 * hmax * sstep(0.5 * PX, 2.0 * PX, inside)   # higher interior
        Hr += 8.0 * (Lr - ndi.gaussian_filter(Lr, 4)) * sstep(0, 0.2 * PX, inside)
        Hr = ndi.gaussian_filter(Hr, 0.9)
        shade = np.clip(hillshade(Hr), 0.1, 2.2)
        rk = rk * np.asarray(cfg.get("rock_mul", (1.0, 1.0, 1.0)), np.float32)
        rk = rk * (0.2 + 0.8 * shade)[..., None]
        # sunlit rim highlight on the upper-left flanks
        rim = np.clip(shade - 1.15, 0, 1) * sstep(0.35 * PX, 0.05 * PX, inside)
        rk = rk + (cfg.get("rock_rim", 0.12) * rim)[..., None]
        # darker cliff faces near the rim, lighter tops
        face = sstep(0.35 * PX, 0.0, e_rock)
        rk = rk * (1 - 0.12 * face)[..., None]
        if cfg.get("rock_notch", 0.0) > 0 and sd_wet is not None:
            # a dark wave-cut notch along the foot where the stone stands in the sea
            notch = sstep(0.4 * PX, 0.0, e_rock) * sstep(-1.2 * PX, -0.2 * PX, sd_wet)
            rk = rk * (1 - cfg["rock_notch"] * notch)[..., None]
            del notch
        ao = np.maximum(ao, np.exp(np.minimum(e_rock, 0) / (0.2 * PX)) * (1 - m_rock) * 0.42)
        img = img * (1 - m_rock[..., None]) + rk * m_rock[..., None]
        Hterr = np.maximum(Hterr, Hr * m_rock)
        del rk, Lr, shade
    else:
        m_rock = np.zeros((H, W), np.float32)

    # ---- apply AO (ground-level darkening around rocks and woods)
    img *= (1 - ao)[..., None]

    # ---- 8. bridges
    bridges = bridge_specs(T, cfg.get("bridge_reach", 12.0))
    m_deck = np.zeros((H, W), np.float32)
    for b in bridges:
        draw_bridge(img, Hterr, m_deck, b, road_t, cfg, rng)

    # ---- 9. doodads + trees
    sprites = get_sprites(biome)
    place_doodads(img, Hterr, d, cfg, sprites, e_for, e_rock)

    # ---- 10. cast shadows from the combined height field
    shadow = cast_shadow(Hterr, soft=0.1 * PX)
    k = cfg["shadow_k"] * (1 - 0.6 * m_lava) * (1 + 0.25 * (m_water - m_lava))
    sc = np.asarray(cfg["shadow_col"], np.float32)
    img *= 1 - (k * shadow)[..., None] * (1 - sc)
    del shadow

    # ---- 11. lava glow (emissive, unaffected by sun shadows)
    if volcanic and sd_deep is not None and has[WATER]:
        dist = np.minimum(e_deep, 0)
        g = (np.exp(dist / (0.35 * PX)) * 0.7 + np.exp(dist / (0.9 * PX)) * 0.3) * (1 - m_lava)
        g *= (0.85 + 0.15 * n_big) * (1 - 0.8 * m_deck)
        gc = np.array([1.0, 0.45, 0.12], np.float32)
        # warm light on surfaces near the lava plus a faint heat haze
        img = img * (1 + 1.6 * gc * g[..., None]) + 0.07 * gc * g[..., None]

    # ---- 12. grading
    img = grade(img, cfg["grade"])
    out = Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
    out = out.filter(ImageFilter.UnsharpMask(radius=1.2, percent=35, threshold=5))

    stats = write_outputs(mid, out, T, debug)
    stats["seconds"] = round(time.time() - t0, 1)
    return stats


def grade(img: np.ndarray, g: dict) -> np.ndarray:
    img = np.clip(img, 0, 1)
    L = lum(img)[..., None]
    img = L + (img - L) * g["sat"]
    img = 0.5 + (img - 0.5) * g["contrast"]
    img = np.clip(img, 0, 1) ** g["gamma"]
    img = img * np.asarray(g["gain"], np.float32) + np.asarray(g["lift"], np.float32)
    return img


# ---------------------------------------------------------------- bridges ---

def bridge_specs(T: np.ndarray, reach: float = 12.0) -> list[dict]:
    """Each bridge's centre, axis, width and painted extent (at most `reach` tiles either side)."""
    lab, n = ndi.label(T == BRIDGE, structure=np.ones((3, 3)))
    specs = []
    h, w = T.shape
    wet = np.isin(T, [WATER, SHALLOWS, BRIDGE, DEEP])
    for i in range(1, n + 1):
        ys, xs = np.nonzero(lab == i)
        comp = lab == i
        near = ndi.binary_dilation(comp, np.ones((3, 3)), iterations=2) & (T == ROAD)
        ry, rx = np.nonzero(near)
        py = np.concatenate([ys, ry]) + 0.5
        pxs = np.concatenate([xs, rx]) + 0.5
        c = np.array([xs.mean() + 0.5, ys.mean() + 0.5])
        P = np.stack([pxs, py], 1) - np.array([pxs.mean(), py.mean()])
        cov = P.T @ P
        evals, evecs = np.linalg.eigh(cov)
        a = evecs[:, 1]
        if abs(evals[1] - evals[0]) < 1e-6:
            a = np.array([1.0, 0.0])
        b = np.array([-a[1], a[0]])
        # deck width ~ tile count / span along the axis; length reaches across the water
        tb = (np.stack([xs + 0.5, ys + 0.5], 1) - c) @ a
        span = (tb.max() - tb.min()) + 1.0
        width = float(np.clip(len(ys) / span, 1.5, 2.4))
        ext = []
        for sgn in (-1, 1):
            best = 0.0
            for off in (-width / 2 + 0.2, 0.0, width / 2 - 0.2):
                t = 0.0
                while t < reach:
                    p = c + a * sgn * t + b * off
                    tx, ty = int(math.floor(p[0])), int(math.floor(p[1]))
                    if not (0 <= tx < w and 0 <= ty < h) or not wet[ty, tx]:
                        break
                    t += 0.05
                best = max(best, t)
            ext.append(best + 0.5)
        specs.append(dict(c=c, a=a, b=b, t0=-ext[0], t1=ext[1], width=width))
    return specs


def _hash01(i: np.ndarray, seed: int) -> np.ndarray:
    h = (i.astype(np.int64) * 374761393 + seed * 668265263) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF).astype(np.float32) / 65535.0


def draw_bridge(img, Hterr, m_deck, b, road_t, cfg, rng):
    """A built bridge deck (plates or planks) with side girders/railings, aligned to
    the bridge axis. Its height goes into Hterr so it casts a shadow on the water."""
    H, W = img.shape[:2]
    c = b["c"] * PX
    a, bb = b["a"], b["b"]
    t0, t1, wd = b["t0"] * PX, b["t1"] * PX, b["width"] * PX
    corners = [c + a * t + bb * s_ for t in (t0, t1) for s_ in (-wd / 2, wd / 2)]
    xs_ = [p[0] for p in corners]
    ys_ = [p[1] for p in corners]
    pad = 4 + (int(0.3 * PX) if cfg.get("trestle") else 0)
    x0, x1 = max(0, int(min(xs_)) - pad), min(W, int(max(xs_)) + pad + 1)
    y0, y1 = max(0, int(min(ys_)) - pad), min(H, int(max(ys_)) + pad + 1)
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    rx, ry = xx + 0.5 - c[0], yy + 0.5 - c[1]
    u = rx * a[0] + ry * a[1]         # along the bridge
    v = rx * bb[0] + ry * bb[1]       # across
    av = np.abs(v)
    hw = wd / 2
    dend = np.minimum(u - t0, t1 - u)
    mask = sstep(-0.7, 0.7, dend) * sstep(-0.7, 0.7, hw - av)
    beam_w = 0.13 * PX
    style = cfg.get("deck", "road")
    n = road_t.shape[0]
    if style == "planks":
        pw = 0.17 * PX
        k = np.floor((u - t0) / pw)
        r = _hash01(k, 7)
        grain = np.sin(v * 0.9 + r * 40.0) * 0.5 + np.sin(v * 2.3 + r * 17.0) * 0.3
        wood = np.asarray(cfg.get("wood", (0.52, 0.4, 0.29)), np.float32)
        deck = wood * (0.78 + 0.32 * r + 0.06 * grain)[..., None]
        # worn wheel lanes, plank gaps
        deck *= (1 - 0.08 * np.exp(-((av - wd * 0.2) / (0.1 * PX)) ** 2))[..., None]
        ph = np.mod(u - t0, pw)
        gap = sstep(1.3, 0.3, np.minimum(ph, pw - ph))
        deck *= (1 - 0.55 * gap)[..., None]
        tex = sample_bilinear(road_t, v + rng.integers(n), u + rng.integers(n))
        deck = deck * (0.85 + 0.3 * (lum(tex) - lum(tex).mean()))[..., None]
        if cfg.get("deck_snow", 0) > 0:
            sn = np.clip(0.5 + 0.8 * (lum(tex) - lum(tex).mean()) * 4 + 0.3 * sstep(hw * 0.6, hw, av), 0, 1)
            sn *= cfg["deck_snow"]
            deck = deck * (1 - sn[..., None]) + np.array([0.9, 0.93, 0.97], np.float32) * sn[..., None]
    else:
        deck = sample_bilinear(road_t, v + rng.integers(n), u + rng.integers(n))
        deck = deck * np.asarray(cfg["deck_tint"], np.float32)
        seg = 0.9 * PX
        ph = np.mod(u - t0, seg)
        joint = sstep(1.6, 0.4, np.minimum(ph, seg - ph))
        deck *= (1 - 0.4 * joint)[..., None]
        deck *= (1 - 0.07 * np.exp(-((av - wd * 0.2) / (0.08 * PX)) ** 2))[..., None]
    # side girders / railings
    railc = np.asarray(cfg["rail"], np.float32)
    rail = sstep(hw - beam_w - 0.6, hw - beam_w + 0.6, av)
    across = sstep(hw - beam_w, hw, av)             # 0 inner edge .. 1 outer edge
    rail_rgb = railc * (1.12 - 0.3 * across)[..., None]
    pp = np.mod(u - t0, 0.45 * PX)
    post = sstep(2.2, 0.8, np.minimum(pp, 0.45 * PX - pp)) * rail
    rail_rgb = rail_rgb * (1 + 0.18 * post)[..., None]
    deck = deck * (1 - rail[..., None]) + rail_rgb * rail[..., None]
    # abutment ends: darker, heavier
    end = sstep(0.22 * PX, 0.0, dend)
    deck *= (1 - 0.2 * end)[..., None]
    outline = sstep(0.0, 1.3, np.minimum(dend, hw - av))
    deck *= (0.5 + 0.5 * outline)[..., None]
    if cfg.get("deck_glow"):
        # molten light from below catching the deck edges
        edge = sstep(3.5, 0.0, hw - av) * sstep(0.3 * PX, 0.6 * PX, dend)
        deck = deck + np.array([0.55, 0.2, 0.03], np.float32) * (0.5 * edge)[..., None]
    reg = img[y0:y1, x0:x1]
    m = mask[..., None]
    reg[:] = reg * (1 - m) + deck * m
    # height: fade up from the banks, deck + railing lip
    hb = (0.55 * PX * sstep(0.0, 0.5 * PX, dend) + 0.08 * PX * rail) * mask
    if cfg.get("trestle"):
        # a timber trestle: the cap beams of its bents (every `trestle` tiles) show past the deck's sides
        sp = cfg["trestle"] * PX
        ph = np.mod(u - t0 - sp / 2, sp)
        du = np.minimum(ph, sp - ph)
        over = 0.2 * PX
        beam = sstep(0.085 * PX, 0.05 * PX, du) * sstep(hw + over, hw + over - 2.0, av)
        beam *= sstep(0.6 * PX, 1.0 * PX, dend) * (1 - mask)
        bc = railc * (0.85 - 0.3 * sstep(hw, hw + over, av))[..., None]
        bm = beam[..., None]
        reg[:] = reg * (1 - bm) + bc * bm
        hb = np.maximum(hb, 0.45 * PX * beam)
    Hterr[y0:y1, x0:x1] = np.maximum(Hterr[y0:y1, x0:x1], hb)
    m_deck[y0:y1, x0:x1] = np.maximum(m_deck[y0:y1, x0:x1], mask)


# ---------------------------------------------------------------- scatter ---

def place_doodads(img, Hterr, d, cfg, sprites, e_for, e_rock):
    """Seeded scatter: big doodads only on non-buildable tiles (rough, forest edges,
    rock edges) and never within ~6 tiles of an HQ; small flat ones sparsely on open
    ground (rarely near HQs); tree crowns densely inside the organic forest mask."""
    T = d["grid"]
    h, w = T.shape
    rng = np.random.default_rng([int(d["seed"]), 99])
    hqs = [((q["tx"] + q["size"] / 2), (q["ty"] + q["size"] / 2)) for q in d.get("hqs", [])]
    ty_, tx_ = np.mgrid[0:h, 0:w]
    dist_hq = np.full((h, w), 1e9)
    for (hx, hy) in hqs:
        dist_hq = np.minimum(dist_hq, np.hypot(tx_ + 0.5 - hx, ty_ + 0.5 - hy))
    near_res = ndi.binary_dilation(np.isin(T, [SCRAP, CRYSTAL]), np.ones((3, 3)))
    near_rock = ndi.binary_dilation(T == ROCK, np.ones((3, 3)))
    rock_edge = (T == ROCK) & ndi.binary_dilation(T != ROCK, ndi.generate_binary_structure(2, 1))
    forest_edge = (T == FOREST) & ndi.binary_dilation(T != FOREST, np.ones((3, 3)))
    wet = np.isin(T, [WATER, SHALLOWS, BRIDGE, DEEP])
    near_wet = ndi.binary_dilation(wet, np.ones((3, 3))) & ~wet
    near_lava = ndi.binary_dilation(T == WATER, np.ones((3, 3)), iterations=1) & ~wet
    near_shore = ndi.binary_dilation(wet, np.ones((3, 3)), iterations=2) & ~wet
    shore_only = cfg.get("small_shore", ())
    volcanic = d["biome"] == "volcanic"

    placed_big: list[tuple[float, float]] = []
    n_wrecks = 0
    jobs = []  # (layer, y, sprite_idx, cx, cy, size_tiles, height, angle, flip, tint, dome)

    big = cfg["big"]
    small = cfg["small"]
    big_ids = list(big.keys())

    def far_from_big(x, y, r):
        return all((x - bx) ** 2 + (y - by) ** 2 > r * r for bx, by in placed_big)

    order = rng.permutation(h * w)
    for idx in order:
        ty, tx = divmod(int(idx), w)
        code = T[ty, tx]
        if dist_hq[ty, tx] < 6.5 or near_res[ty, tx]:
            continue
        p = 0.0
        choices = []
        offset = (0.0, 0.0)
        if code == ROUGH:
            p = (0.11 if not near_wet[ty, tx] else 0.08) * cfg.get("rough_big_mul", 1.0)
            choices = big_ids
        elif forest_edge[ty, tx]:
            p = 0.035
            choices = [k for k in big_ids if big[k][0] in ("boulder", "log", "wreck", "crate")]
        elif rock_edge[ty, tx]:
            p = cfg.get("rock_boulder_p", 0.05)
            choices = [k for k in big_ids if big[k][0] == "boulder"]
            # nudge toward the open side so it sits at the cliff foot
            dx = dy = 0.0
            for (oy, ox) in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                yy, xx = ty + oy, tx + ox
                if 0 <= yy < h and 0 <= xx < w and T[yy, xx] != ROCK:
                    dx += ox
                    dy += oy
            nrm = math.hypot(dx, dy) or 1.0
            offset = (0.3 * dx / nrm, 0.3 * dy / nrm)
        if not choices or rng.random() > p:
            continue
        cx = tx + 0.5 + offset[0] + rng.uniform(-0.18, 0.18)
        cy = ty + 0.5 + offset[1] + rng.uniform(-0.18, 0.18)
        if not far_from_big(cx, cy, 2.2):
            continue
        wts = np.array([big[c][4] for c in choices], float)
        if n_wrecks >= 3:
            wts *= np.array([0.0 if big[c][0] == "wreck" else 1.0 for c in choices])
        if wts.sum() <= 0:
            continue
        k = int(rng.choice(choices, p=wts / wts.sum()))
        name, s0, s1, ht, _ = big[k]
        n_wrecks += name == "wreck"
        size = rng.uniform(s0, s1)
        free_rot = name in ("wreck", "log", "crate", "debris")
        ang = rng.uniform(-180, 180) if free_rot else rng.uniform(-25, 25)
        placed_big.append((cx, cy))
        jobs.append((1, cy, k, cx, cy, size, ht, ang, bool(rng.random() < 0.5) and free_rot, None, name in ("boulder", "mangrove")))

    # small, flat decorations
    small_ids = list(small.keys())
    pg = cfg.get("small_ground_p", 0.03)
    for idx in rng.permutation(h * w):
        ty, tx = divmod(int(idx), w)
        code = T[ty, tx]
        if near_res[ty, tx] or code not in (GROUND, ROUGH):
            continue
        if code == GROUND:
            p = pg * (0.12 if dist_hq[ty, tx] < 6.5 else 1.0)
            if near_rock[ty, tx]:
                p *= 2.0
        else:
            p = 0.09 * (0.3 if dist_hq[ty, tx] < 6.5 else 1.0)
        if rng.random() > p:
            continue
        cands = list(small_ids)
        if volcanic:
            # glowing lava rocks near lava, sulfur only on rough
            if not near_lava[ty, tx]:
                cands = [k for k in cands if small[k][0] != "lavarocks"]
            if code != ROUGH:
                cands = [k for k in cands if small[k][0] != "sulfur"]
        if shore_only and not near_shore[ty, tx]:
            cands = [k for k in cands if small[k][0] not in shore_only]
        if not cands:
            continue
        wts = np.array([small[c][4] for c in cands], float)
        k = int(rng.choice(cands, p=wts / wts.sum()))
        name, s0, s1, ht, _ = small[k]
        cx = tx + 0.5 + rng.uniform(-0.3, 0.3)
        cy = ty + 0.5 + rng.uniform(-0.3, 0.3)
        if not far_from_big(cx, cy, 1.0):
            continue
        ang = rng.uniform(-180, 180) if name in ("rocks", "ice", "debris", "skull", "drift", "coral") else rng.uniform(-30, 30)
        jobs.append((0, cy, k, cx, cy, rng.uniform(s0, s1), ht, ang, bool(rng.random() < 0.5), None, False))

    # trees: jittered grid inside the (organic) forest mask
    if e_for is not None:
        s0, s1 = cfg["tree_size"]
        sp = cfg.get("tree_spacing", 0.62)
        n_y = int(h / sp)
        n_x = int(w / sp)
        for gy in range(n_y):
            for gx in range(n_x):
                cx = (gx + 0.5 + rng.uniform(-0.42, 0.42)) * sp
                cy = (gy + 0.5 + rng.uniform(-0.42, 0.42)) * sp
                px_, py_ = int(cx * PX), int(cy * PX)
                if not (0 <= px_ < w * PX and 0 <= py_ < h * PX):
                    continue
                ev = e_for[py_, px_]
                if ev < 0.1 * PX:
                    continue
                if e_rock is not None and e_rock[py_, px_] > -0.45 * PX:
                    continue
                edge = ev < 0.9 * PX
                if rng.random() > (0.95 if edge else 0.62) * cfg.get("tree_density", 1.0):
                    continue
                tw = np.asarray(cfg.get("tree_w", [1.0] * len(cfg["trees"])), float)
                k = int(rng.choice(cfg["trees"], p=tw / tw.sum()))
                size = rng.uniform(s0, s1) * (0.9 if edge else 1.0)
                tint = tuple(float(x) for x in (cfg.get("tree_bright", 1.0) * rng.uniform(0.86, 1.08) * np.array(
                    [rng.uniform(0.95, 1.05), 1.0, rng.uniform(0.93, 1.05)])))
                if "tree_tint" in cfg:
                    tint = tuple(t_ * c_ for t_, c_ in zip(tint, cfg["tree_tint"]))
                jobs.append((2, cy, k, cx, cy, size, cfg["tree_h"], rng.uniform(-30, 30), False, tint, True))

    jobs.sort(key=lambda j: (j[0], j[1]))
    for (layer, _, k, cx, cy, size, ht, ang, flip, tint, dome) in jobs:
        spr = prep_sprite(sprites[k], size * PX, ang, flip)
        paste(img, Hterr, spr, cx * PX, cy * PX, ht * PX, tint or (1.0, 1.0, 1.0), dome)


# ----------------------------------------------------------------- output ---

def map_budget(T: np.ndarray) -> float:
    return BUDGET * max(1.0, T.size / BUDGET_TILES)


def write_outputs(mid: str, im: Image.Image, T: np.ndarray, debug: bool) -> dict:
    out = OUT_DIR / mid
    budget = map_budget(T)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("t_*.webp"):
        old.unlink()
    W, H = im.size
    cols = int(math.ceil(W / CHUNK))
    rows = int(math.ceil(H / CHUNK))
    crops = {}
    for r in range(rows):
        for c in range(cols):
            box = (c * CHUNK, r * CHUNK, min(W, (c + 1) * CHUNK), min(H, (r + 1) * CHUNK))
            crops[(c, r)] = im.crop(box)
    for q in WEBP_QUALITY:
        blobs = {}
        for key, cim in crops.items():
            b = io.BytesIO()
            cim.save(b, "WEBP", quality=q, method=6)
            blobs[key] = b.getvalue()
        total = sum(len(v) for v in blobs.values())
        if total <= budget:
            break
    for (c, r), data in blobs.items():
        (out / f"t_{c}_{r}.webp").write_bytes(data)
    meta = dict(pxPerTile=PX, chunk=CHUNK, cols=cols, rows=rows, width=W, height=H)
    (out / "meta.json").write_text(json.dumps(meta) + "\n")
    th = im.resize((THUMB, THUMB), Image.LANCZOS)
    th.save(out / "thumb.webp", "WEBP", quality=85, method=6)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    s = PREVIEW / max(W, H)
    pv = im.resize((int(round(W * s)), int(round(H * s))), Image.LANCZOS)
    pv.save(PREVIEW_DIR / f"terrain-{mid}.jpg", "JPEG", quality=88)
    if debug:
        # outline impassable tiles (rock, deep water) in red, shallows/forest in yellow
        dbg = np.asarray(im).copy()
        h, w = T.shape
        for codes, col in (([ROCK, WATER, DEEP], (255, 0, 0)), ([SHALLOWS], (255, 255, 0)), ([FOREST], (0, 255, 255))):
            m = np.isin(T, codes)
            for ty in range(h):
                for tx in range(w):
                    if not m[ty, tx]:
                        continue
                    x0, y0 = tx * PX, ty * PX
                    if tx == 0 or not m[ty, tx - 1]:
                        dbg[y0:y0 + PX, x0:x0 + 2] = col
                    if tx == w - 1 or not m[ty, tx + 1]:
                        dbg[y0:y0 + PX, x0 + PX - 2:x0 + PX] = col
                    if ty == 0 or not m[ty - 1, tx]:
                        dbg[y0:y0 + 2, x0:x0 + PX] = col
                    if ty == h - 1 or not m[ty + 1, tx]:
                        dbg[y0 + PX - 2:y0 + PX, x0:x0 + PX] = col
        Image.fromarray(dbg).save(PREVIEW_DIR / f"terrain-{mid}-grid.jpg", "JPEG", quality=85)
    return dict(bytes=total, quality=q, thumb=(out / "thumb.webp").stat().st_size, cols=cols, rows=rows,
                budget=budget)


def main(argv: list[str]) -> None:
    debug = "--debug" in argv
    ids = [a for a in argv if not a.startswith("--")]
    if not ids:
        ids = sorted(p.stem for p in MAPS_DIR.glob("*.json"))
    for mid in ids:
        st = render(mid, debug)
        over = " (over budget)" if st["bytes"] > st["budget"] else ""
        print(f"{mid}: {st['cols']}x{st['rows']} chunks, {st['bytes'] / 1024:.0f} KB at q{st['quality']}{over} "
              f"(+thumb {st['thumb'] / 1024:.0f} KB) in {st['seconds']}s")
    # the same rock materials, shipped for the 3D cliff walls and crags (those of the biomes just painted)
    write_rock_textures(sorted({load_map(mid)["biome"] for mid in ids}))


if __name__ == "__main__":
    main(sys.argv[1:])
