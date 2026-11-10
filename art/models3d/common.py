"""Ce que les modèles faits main partagent : la palette de matières, quelques pièces (roue d'artillerie,
phare, cheminée) et la sortie (cuisson + .glb).

  Blender -b --python art/models3d/<modèle>.py -- [--fast] [--res 2048]
  python3 art/models3d/pack.py <modèle>
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import kit as kitmod  # noqa: E402
from kit import PI, Kit, xf  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
FAST = "--fast" in ARGS
RES = int(ARGS[ARGS.index("--res") + 1]) if "--res" in ARGS else (1024 if FAST else 2048)

STEEL = 0x9a968e
MATERIALS = {
    # la tôle peinte, kaki bronze ; sous la peinture, l'acier
    "armor": dict(color=0x80602f, under=STEEL, rough=0.6, mud=0.16, bump=0.35, edge_paint=0.5),
    "armor_d": dict(color=0x3f3024, under=STEEL, rough=0.62, mud=0.2, bump=0.35, edge_paint=0.6),
    "team": dict(color=0xdcdcdc, under=STEEL, rough=0.5, team=1.0, chips=0.3, vary=0.1, streaks=0.35, edge_paint=0.3),
    # les métaux nus
    "iron": dict(color=0x2c2723, under=0x9c978f, metal=0.75, rough=0.55, wear=0.0, edge_light=0.3, mud=0.14, dirt_color=0x3a2c1e),
    "track": dict(color=0x3d352d, under=0xb5aea2, metal=0.7, rough=0.55, wear=0.0, edge_light=0.9, mud=0.3, dirt=1.3, dirt_color=0x4b3a27),
    "gun": dict(color=0x25252b, under=0xa6a6b0, metal=0.9, rough=0.36, wear=0.0, edge_light=0.7, streaks=0.2, dirt=0.6),
    "brass": dict(color=0xd9ad55, under=0xffe6a8, metal=1.0, rough=0.3, wear=0.0, edge_light=0.5, dirt_color=0x3b2a12, streaks=0.3, bump=0.15),
    "rivet": dict(color=0xcfa552, under=0xffe6a8, metal=1.0, rough=0.32, wear=0.0, edge_light=0.4, dirt=0.5, dirt_color=0x3b2a12, streaks=0.0, bump=0.0),
    "copper": dict(color=0xbd6c3c, under=0xf0a070, metal=1.0, rough=0.34, wear=0.0, edge_light=0.5, dirt=1.1, dirt_color=0x3f7566, streaks=0.5, bump=0.2),
    "wood": dict(color=0x7a5230, under=0xb08a58, under_metal=0.0, under_rough=0.8, rough=0.75, wear=0.6, wood=True, bump=0.2),
    "wood_l": dict(color=0x9a6d3e, under=0xc09a66, under_metal=0.0, under_rough=0.8, rough=0.75, wear=0.6, wood=True, bump=0.2),
    "leather": dict(color=0x5a2f1c, under=0x8a5a3a, under_metal=0.0, under_rough=0.7, rough=0.55, wear=0.5, bump=0.5, bump_scale=200.0),
    "canvas": dict(color=0xb7a57a, rough=0.95, wear=0.0, bump=0.9, bump_scale=320.0, streaks=0.6),
    "ivory": dict(color=0xe2d8bc, rough=0.9, wear=0.0, bump=0.8, bump_scale=300.0, streaks=0.5, dirt=0.8),
    "enamel": dict(color=0xe8e2d0, rough=0.35, wear=0.0, dirt=0.4, streaks=0.2),
    "coal": dict(color=0x1b1816, rough=0.5, metal=0.2, wear=0.0, edge_light=0.25, under=0x6a6660, dirt=0.3),
    "soot": dict(color=0x120e0b, rough=0.95, wear=0.0, dirt=0.3),
    "amber": dict(color=0xffab3d, glow=1.0, wear=0.0, dirt=0.0, streaks=0.0, vary=0.0),
    "fire": dict(color=0xff7a22, glow=1.0, wear=0.0, dirt=0.0, streaks=0.0, vary=0.0),
    "skirt": dict(color=0x2f271f, rough=0.92, wear=0.0, bump=0.9, bump_scale=260.0, streaks=0.7, mud=0.1, dirt_color=0x6a5a44),
    "jar": dict(color=0x6f8f78, rough=0.12, metal=0.25, wear=0.0, dirt=0.3, streaks=0.1, vary=0.05),
    "spark": dict(color=0xe4f2ff, glow=1.0, wear=0.0, dirt=0.0, streaks=0.0, vary=0.0),
    "radium": dict(color=0xd4ffd8, glow=1.0, wear=0.0, dirt=0.0, streaks=0.0, vary=0.0),
}


def start(extra=None):
    """Un kit neuf ; `extra` : des matières propres au modèle, en plus de la palette."""
    kitmod.reset_scene()
    return Kit({**MATERIALS, **(extra or {})})


def wheel(K, c, r, w, side=1, spokes=10, felloe="wood", spoke="wood_l", seg=14):
    """Roue d'artillerie d'axe X, centrée en c : bandage de fer, jante de bois, rais, moyeu de laiton (côté `side`)."""
    ax = "x" if side > 0 else "-x"
    K.lathe([(r, -w / 2), (r, w / 2), (r * 0.9, w / 2), (r * 0.9, -w / 2)], c, "iron", seg=seg, axis=ax, closed=True)
    K.lathe([(r * 0.9, -w * 0.4), (r * 0.9, w * 0.4), (r * 0.75, w * 0.34), (r * 0.75, -w * 0.34)], c, felloe, seg=seg, axis=ax, closed=True)
    for i in range(spokes):
        a = 2 * PI * i / spokes
        K.box(w * 0.34, r * 0.1, r * 0.6, (c[0], c[1] + r * 0.47 * math.cos(a), c[2] + r * 0.47 * math.sin(a)), spoke,
              rot=(a - PI / 2, 0, 0), center=True, top=(w * 0.26, r * 0.075))
    K.lathe([(0, -w * 0.5), (r * 0.2, -w * 0.5), (r * 0.22, -w * 0.2), (r * 0.22, w * 0.35), (r * 0.15, w * 0.62), (r * 0.08, w * 0.75), (0, w * 0.78)], c, "brass", seg=10, axis=ax)
    # les boulons du bandage et l'écrou du moyeu, dans la texture
    for i in range(spokes):
        a = 2 * PI * (i + 0.5) / spokes
        K.rivet((c[0] + side * w * 0.5, c[1] + r * 0.95 * math.cos(a), c[2] + r * 0.95 * math.sin(a)), (side, 0, 0), r * 0.035)
        K.rivet((c[0] + side * w * 0.36, c[1] + r * 0.2 * math.cos(a), c[2] + r * 0.2 * math.sin(a)), (side, 0, 0), r * 0.03, "iron")


def lamp(K, at, r=0.034, axis="y", glass="amber"):
    """Phare à acétylène : un tambour de laiton, sa visière, la lentille allumée vers l'avant (l'axe)."""
    K.lathe([(0, -r * 1.25), (r * 0.5, -r * 1.2), (r * 0.9, -r * 0.8), (r, -r * 0.2), (r, r * 0.5), (r * 1.12, r * 0.5), (r * 1.12, r * 0.72), (r * 0.86, r * 0.72)], at, "brass", seg=10, axis=axis)
    K.lathe([(r * 0.86, r * 0.62), (r * 0.5, r * 0.78), (0, r * 0.82)], at, glass, seg=10, axis=axis, fix=True)


def stack(K, base, r, h, seg=12):
    """Cheminée : fût de fer noirci, bagues de laiton, couronne évasée pleine de suie."""
    K.lathe([(r * 1.3, 0.0), (r * 1.3, h * 0.07), (r * 1.05, h * 0.12), (r * 0.95, h * 0.72), (r * 1.05, h * 0.77), (r * 1.5, h * 0.93), (r * 1.56, h), (r * 1.3, h * 1.015)], base, "iron", seg=seg)
    K.lathe([(r * 1.3, h * 1.01), (r * 0.8, h * 0.92), (0, h * 0.91)], base, "soot", seg=seg, fix=True)
    for z in (0.28, 0.72):
        K.torus(r * 1.04, r * 0.18, (base[0], base[1], base[2] + h * z), "brass", seg=seg, tseg=5, detail=True)
    K.torus(r * 1.55, r * 0.15, (base[0], base[1], base[2] + h * 0.985), "brass", seg=seg, tseg=5, detail=True)


def finish(K, name, pivots=None):
    """Assemble, déplie, cuit (passes brutes dans out/<nom>) et écrit public/assets/models/<nom>/<nom>.glb."""
    out = os.path.join(HERE, "..", "..", "public", "assets", "models", name)
    os.makedirs(out, exist_ok=True)
    tris = K.build()
    kitmod.unwrap(K.low)
    kitmod.bake(K, os.path.join(HERE, "out", name), res=RES, samples=8 if FAST else 32, extrusion=0.02, ray=0.05)
    kitmod.export(K, os.path.join(out, name + ".glb"), pivots or {})
    print(f"[{name}] {tris} triangles")


def prop(K, part, c, r, n, axis="y", blade="wood_l", tip=None, width=0.17, hub="brass", hub_r=None):
    """Hélice de n pales de rayon r, pièce tournante `part` de pivot c : d'axe Y (tractive ou propulsive)
    ou Z (vis sustentatrice). Chaque pale un peu calée ; `tip` peint le bout (le disque qui tourne montre
    alors un cercle de cette couleur). Rend le pivot."""
    prev = K.part
    K.use(part)
    for i in range(n):
        a = 2 * PI * i / n
        M = xf(c, (0, a, 0) if axis == "y" else (0, 0, a))
        with K.on(M):
            th = min(0.016, 0.012 * r / 0.12)
            dims = lambda ln, w: (ln, th, w) if axis == "y" else (ln, w, th)  # noqa: E731
            body = r * (0.72 if tip else 0.92)
            K.box(*dims(body, r * width), (r * 0.1 + body / 2, 0, 0), blade, rot=(0.35, 0, 0), center=True)
            if tip:
                K.box(*dims(r * 0.2, r * width * 1.08), (r * 0.1 + body + r * 0.1, 0, 0), tip, rot=(0.35, 0, 0), center=True)
    h = hub_r or r * 0.17
    K.lathe([(0, -h * 0.82), (h * 0.88, -h * 0.7), (h, 0), (h * 0.7, h * 0.82), (0, h * 1.3)], c, hub, seg=8, axis=axis)
    K.use(prev)
    return tuple(c)
