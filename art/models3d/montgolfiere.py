"""La Montgolfière (Condor) : une barge de transport sous un grand ballon décoré.

La longue barque de bois est la soute ouverte (CONDOR_BAY de models.ts : pont, bancs, plats-bords de
couleur, la rampe de poupe en passerelle) ; le ballon flotte au-dessus du gaillard d'avant, hors de la
soute pour qu'on voie les passagers, ses fuseaux alternant la couleur du camp et l'ivoire sous des
guirlandes dorées, un brasero sous sa bouche. Deux hélices tractives sur des balanciers, un gouvernail
de couleur à la poupe. Mêmes mesures que le modèle du jeu : les escouades s'y assoient.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, lamp, prop, start  # noqa: E402
from kit import toward, xf  # noqa: E402

# (la soute est un creux : la crasse des recoins la noircirait toute, on l'y retient)
import kit as kitmod  # noqa: E402

K = start({
    "bay": dict(color=0x7a5230, under=0xb08a58, under_metal=0.0, under_rough=0.8, rough=0.75, wear=0.5, wood=True, bump=0.2, dirt=0.15),
    "bay_l": dict(color=0xa87844, under=0xc09a66, under_metal=0.0, under_rough=0.8, rough=0.75, wear=0.5, wood=True, bump=0.2, dirt=0.12),
})
kitmod.GRADE[:] = [-0.2, 0.7]
K.use("hull")
# la soute (en repère du jeu : z vers l'arrière) -> ici y = -z
FLOOR, BENCH, WALL, BW, Z0, Z1, RAMP, RAMPW = -0.1, -0.064, 0.0, 0.34, -0.31, 0.17, 0.34, 0.27
W0, W1, W2, W3 = 0.205, 0.21, 0.2, 0.17
IW = BW / 2


def sec(z, w, top, bot, c=0.025, belly=0.05):
    y = -z
    c = min(c, w * 0.5, (top - bot) * 0.3)
    d = min(belly, w * 0.6, (top - bot) * 0.5)
    return [(-w, y, top - c), (-w + c, y, top), (w - c, y, top), (w, y, top - c), (w, y, bot + d), (w - d, y, bot), (-w + d, y, bot), (-w, y, bot + d)]


def plan(pts, sx=1):
    """Contour du jeu [(x, z)…] -> [(x, y)…], dans le bon sens pour chaque bord."""
    out = [(sx * x, -z) for x, z in pts]
    return out if sx > 0 else out[::-1]


# -------------------------------------------------------------------- la barque
K.rings([sec(-0.82, 0.012, 0.075, 0.03), sec(-0.77, 0.07, 0.05, -0.08), sec(-0.67, 0.14, 0.025, -0.14), sec(-0.52, 0.19, 0.01, -0.175), sec(Z0 + 0.01, W0, 0.0, -0.185)], "wood")
K.rings([sec(Z0 - 0.01, W0, FLOOR, -0.185), sec(-0.1, W1, FLOOR, -0.185), sec(Z1, W2, FLOOR, -0.18), sec(RAMP - 0.05, W3, FLOOR, -0.165), sec(RAMP, RAMPW / 2 + 0.012, FLOOR, -0.15)], "wood")
# le liston d'ivoire, les joints du bordé, la quille de laiton
# (plein autour du gaillard, une simple bande le long des parois de la soute : elle reste ouverte)
K.rings([sec(z, w + 0.004, -0.03, -0.048, c=0.003, belly=0.003) for z, w in ((-0.77, 0.07), (-0.67, 0.14), (-0.52, 0.19), (Z0, W0))], "ivory", detail=True)
for sx in (1, -1):
    K.prism(plan([(W0 - 0.01, Z0), (W0 + 0.004, Z0), (W1 + 0.004, -0.1), (W2 + 0.004, Z1), (W3 + 0.004, RAMP - 0.05), (RAMPW / 2 + 0.016, RAMP), (RAMPW / 2 + 0.004, RAMP), (W3 - 0.008, RAMP - 0.05), (W2 - 0.01, Z1), (W1 - 0.01, -0.1)], sx),
            -0.048, -0.03, "ivory", detail=True)
for s in (1, -1):
    for k in (-0.085, -0.125):
        K.pipe([(s * (w + 0.002) * (1.0 if k > -0.1 else 0.93), -z, k) for z, w in ((-0.66, 0.14), (-0.52, 0.19), (Z0, W0), (-0.1, W1), (Z1, W2), (RAMP - 0.05, W3))], 0.003, "soot", seg=3, detail=True)
    K.rivets((s * 0.212, 0.28, -0.015), (s * 0.205, -0.15, -0.015), 10, n=(s, 0, 0), r=0.006)
K.box(0.016, 0.85, 0.016, (0, 0.125, -0.198), "brass")
# le gaillard d'avant : bordé clair, un chevron de couleur à l'étrave, la figure de proue dorée, un fanal
K.rings([sec(-0.76, 0.05, 0.063, 0.05, c=0.004, belly=0.002), sec(-0.67, 0.125, 0.041, 0.025, c=0.004, belly=0.002), sec(-0.52, 0.178, 0.023, 0.005, c=0.004, belly=0.002), sec(Z0 + 0.01, 0.193, 0.013, 0.0, c=0.004, belly=0.002)], "wood_l")
for x in (-0.12, -0.06, 0.0, 0.06, 0.12):
    K.pipe([(x * 0.3, 0.74, 0.063), (x, 0.52, 0.026), (x, 0.31, 0.015)], 0.0025, "soot", seg=3, detail=True)
for sx in (1, -1):
    K.prism(plan([(0, -0.78), (0.07, -0.69), (0.07, -0.66), (0, -0.74)], sx), 0.0, 0.006, "team", at=(0, 0, 0.066), rot=(-0.18, 0, 0), detail=True)
K.lathe([(0.018, 0), (0.014, 0.03), (0.02, 0.05), (0.008, 0.08), (0, 0.1)], (0, 0.8, 0.066), "brass", seg=6, rot=(-PI / 2 + 0.3, 0, 0))
lamp(K, (0, 0.76, 0.1), 0.022)
# la soute : pont bordé, lampes d'allée, un banc le long de chaque paroi, plats-bords de couleur
ZR, ZC = (Z0 + RAMP) / 2, (Z0 + Z1) / 2
K.box(BW, RAMP - Z0, 0.012, (0, -ZR, FLOOR - 0.002), "bay_l")
for x in (-0.11, -0.055, 0.055, 0.11):
    K.box(0.004, RAMP - Z0, 0.003, (x, -ZR, FLOOR + 0.01), "soot", detail=True)
z = Z0 + 0.05
while z < RAMP - 0.03:
    K.box(0.014, 0.036, 0.005, (0, -z, FLOOR + 0.01), "amber", detail=True)
    z += 0.075
for sx in (1, -1):
    K.prism(plan([(IW, Z0), (W0, Z0), (W1, -0.1), (W2, Z1), (W3, RAMP - 0.05), (RAMPW / 2 + 0.012, RAMP), (RAMPW / 2, RAMP), (IW, Z1 - 0.02)], sx), FLOOR, WALL, "bay")
    K.prism(plan([(IW - 0.003, Z0 - 0.01), (W0 + 0.006, Z0 - 0.01), (W1 + 0.006, -0.1), (W2 + 0.005, Z1), (W3 + 0.005, RAMP - 0.05), (RAMPW / 2 + 0.016, RAMP + 0.006), (RAMPW / 2 - 0.004, RAMP + 0.006), (IW - 0.003, Z1 - 0.02)], sx),
            WALL - 0.002, WALL + 0.014, "team")
    K.box(0.034, Z1 - Z0 - 0.02, BENCH - FLOOR, (sx * (IW - 0.017), -ZC, FLOOR), "bay_l")
    K.box(0.03, Z1 - Z0 - 0.03, 0.005, (sx * (IW - 0.017), -ZC, BENCH), "leather", detail=True)
    for zz in (Z0 + 0.05, ZC, Z1 - 0.04):
        K.box(0.006, 0.022, 0.016, (sx * (IW - 0.001), -zz, WALL - 0.03), "amber", detail=True)
    K.rivets((sx * (IW + 0.018), -Z0 - 0.02, WALL + 0.014), (sx * (IW + 0.018), -Z1 + 0.04, WALL + 0.014), 9, r=0.005)
    # des sacs de lest pendus au plat-bord
    for zz in (-0.2, -0.02, 0.12):
        K.lathe([(0.0, 0), (0.018, 0.008), (0.022, 0.03), (0.01, 0.05), (0, 0.052)], (sx * 0.228, -zz, -0.07), "canvas", seg=6)
        K.pipe([(sx * 0.228, -zz, -0.02), (sx * 0.215, -zz, 0.005)], 0.003, "iron", seg=3)
# la poupe : deux montants de part et d'autre de la rampe, une traverse, la bôme jusqu'au gouvernail de couleur
PX = RAMPW / 2 + 0.012
for sx in (1, -1):
    K.box(0.02, 0.02, 0.2, (sx * PX, -RAMP - 0.005, -0.1), "wood")
    lamp(K, (sx * PX, -RAMP - 0.012, 0.115), 0.016, axis="-y")
K.box(2 * PX + 0.02, 0.02, 0.018, (0, -RAMP - 0.005, 0.081), "wood")
K.box(0.014, 0.2, 0.014, (0, -RAMP - 0.1, 0.083), "wood")
K.rings([[(-0.006, -0.4, 0.04), (0.006, -0.4, 0.04), (0.006, -0.55, 0.04), (-0.006, -0.55, 0.04)],
         [(-0.006, -0.42, 0.18), (0.006, -0.42, 0.18), (0.006, -0.55, 0.19), (-0.006, -0.55, 0.19)],
         [(-0.004, -0.48, 0.23), (0.004, -0.48, 0.23), (0.004, -0.55, 0.22), (-0.004, -0.55, 0.22)]], "team")
for zz in (0.09, 0.15):
    K.box(0.014, 0.13, 0.005, (0, -0.485, zz), "brass", detail=True)
# le brasero sous la bouche du ballon ; la barre du timonier, tournée vers la soute
BY = 0.55
K.lathe([(0.04, 0), (0.058, 0.01), (0.06, 0.045), (0.05, 0.055)], (0, BY, 0.012), "brass", seg=10)
for k in range(6):
    a = 2 * PI * k / 6
    K.box(0.03, 0.026, 0.02, (0.025 * math.cos(a), BY + 0.025 * math.sin(a), 0.06), "coal", rot=(k, k * 0.7, a))
K.sphere(0.03, (0, BY, 0.07), "fire", seg=8, rings=4, scale=(1, 1, 0.7))
K.torus(0.03, 0.005, (0, -Z0 - 0.04, 0.07), "wood_l", seg=10, tseg=4, axis="y")
K.box(0.01, 0.01, 0.06, (0, -Z0 - 0.045, 0.012), "wood")

# -------------------------------------------------------------------- le ballon
PROF = [(0.075, 0.16), (0.13, 0.21), (0.2, 0.28), (0.255, 0.37), (0.275, 0.45), (0.265, 0.53), (0.22, 0.6), (0.14, 0.655), (0.0, 0.68)]
N = 16
for i in range(N):
    a0 = 2 * PI * i / N
    K.lathe(PROF[::-1], (0, BY, 0), "ivory" if i % 2 else "team", seg=1, hs=3, arc=(a0, a0 + 2 * PI / N), fix=False)
    # un médaillon doré sur chaque fuseau de couleur
    if i % 2 == 0:
        am = a0 + PI / N
        K.lathe([(0.03, 0), (0.03, 0.006), (0.012, 0.012), (0, 0.012)], (0, 0, 0), "brass", seg=8, detail=True,
                M=xf((0.276 * math.cos(am), BY + 0.276 * math.sin(am), 0.45)) @ toward((math.cos(am), math.sin(am), 0)))
for r, zz, w in ((0.277, 0.45, 0.012), (0.205, 0.285, 0.009), (0.14, 0.655, 0.01), (0.262, 0.54, 0.007), (0.262, 0.37, 0.007)):
    K.torus(r + 0.003, w, (0, BY, zz), "brass", seg=16, tseg=4, detail=True)
K.lathe([(0.02, -0.01), (0.036, 0.0), (0.036, 0.03), (0.014, 0.05), (0.01, 0.09), (0, 0.1)], (0, BY, 0.675), "brass", seg=8)
# la jupe à sa bouche, les suspentes jusqu'aux plats-bords
K.lathe([(0.072, 0.115), (0.08, 0.165), (0.07, 0.165), (0.064, 0.115)], (0, BY, 0), "canvas", seg=12, closed=True)
K.torus(0.075, 0.007, (0, BY, 0.115), "brass", seg=12, tseg=4)
for sx in (1, -1):
    for x, zz in ((0.1, -0.73), (0.19, -0.47), (0.2, Z0 + 0.01)):
        K.pipe([(sx * 0.07, BY + (-zz - BY) * 0.25, 0.115), (sx * x, -zz, 0.02)], 0.003, "iron", seg=3)
        K.pipe([(sx * 0.245, BY + (-zz - BY) * 0.6, 0.34), (sx * x, -zz, 0.02)], 0.0025, "iron", seg=3)

# -------------------------------------------- les balanciers et leurs moteurs
EZ = -0.12
PROPS = []
for sx in (1, -1):
    x = sx * 0.37
    K.pipe([(sx * 0.2, -EZ + 0.06, -0.06), (x, -EZ, -0.06)], 0.009, "wood", seg=4)
    K.pipe([(sx * 0.2, -EZ - 0.08, -0.06), (x, -EZ - 0.02, -0.06)], 0.009, "wood", seg=4)
    K.pipe([(sx * 0.2, -EZ, 0.0), (x, -EZ, -0.04)], 0.003, "iron", seg=3)
    K.lathe([(0, -0.09), (0.03, -0.085), (0.036, -0.06), (0.036, 0.05), (0.028, 0.075), (0.012, 0.095)], (x, -EZ - 0.02, -0.06), "brass", seg=10, axis="y")
    K.lathe([(0.039, -0.075), (0.039, -0.045), (0.035, -0.045), (0.035, -0.075)], (x, -EZ - 0.02, -0.06), "team", seg=10, axis="y", closed=True, detail=True)
    for yy in (-0.02, 0.01, 0.04):
        K.torus(0.037, 0.004, (x, -EZ - 0.02 + yy, -0.06), "copper", seg=10, tseg=3, axis="y", detail=True)
    K.cyl(0.008, 0.05, (x, -EZ - 0.05, -0.03), "iron", seg=5)
    PROPS.append((x, -EZ + 0.095, -0.06))

# ----------------------------------------------------------------------- l'hélice
SCREW = prop(K, "screw", (3, 0, 0), 0.1, 4, axis="y", width=0.22)

# ----------------------------------------------------------------------- la rampe
# (fermée, elle se dresse entre les montants : son dehors regarde l'arrière)
K.use("ramp")
H = (0.0, -RAMP, FLOOR)
L, RW = WALL + 0.02 - FLOOR, RAMPW
K.box(RW - 0.004, 0.02, L, (0, -RAMP, FLOOR), "bay_l")
K.box(RW - 0.05, 0.005, L * 0.7, (0, -RAMP - 0.0115, FLOOR + L * 0.15), "team", detail=True)
K.box(RW - 0.004, 0.007, 0.012, (0, -RAMP - 0.0115, FLOOR + L - 0.012), "brass", detail=True)
for i in range(4):
    K.box(RW - 0.06, 0.009, 0.007, (0, -RAMP + 0.0125, FLOOR + 0.017 + i * 0.026), "wood", detail=True)
for sx in (1, -1):
    K.box(0.011, 0.013, L, (sx * (RW / 2 - 0.01), -RAMP + 0.012, FLOOR), "brass")
    K.box(0.02, 0.008, 0.012, (sx * (RW / 2 - 0.03), -RAMP + 0.013, FLOOR + L - 0.016), "amber", detail=True)

finish(K, "montgolfiere", {"screw": SCREW, "ramp": H})
print("[montgolfiere] hélices", PROPS, "rampe", H, L)
