"""L'Éole d'Ader (Wasp), 1890.

Nacelle de bois verni portant une machine à vapeur de laiton (chaudière, cheminée, foyer rougeoyant),
ailes de chauve-souris en toile tendue sur des nervures sombres, leurs panneaux extérieurs aux couleurs
du camp, hélice tractive à quatre pales ; des râteliers de petites fusées sous l'emplanture.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, lamp, prop, start  # noqa: E402
from kit import xf  # noqa: E402

import kit as kitmod  # noqa: E402

K = start()
kitmod.GRADE[:] = [-0.1, 0.15]
K.use("hull")

# ---------------------------------------------------------------- la nacelle
def sec(y, w, top, bot):
    c = min(0.02, w * 0.5)
    return [(-w, y, top - c), (-w + c, y, top), (w - c, y, top), (w, y, top - c), (w, y, bot + c), (w - c, y, bot), (-w + c, y, bot), (-w, y, bot + c)]


K.rings([sec(0.24, 0.026, 0.022, -0.03), sec(0.17, 0.052, 0.042, -0.052), sec(0.0, 0.058, 0.048, -0.058), sec(-0.14, 0.042, 0.036, -0.042), sec(-0.28, 0.01, 0.012, -0.012)], "wood")
for y in (0.17, 0.0, -0.14):
    w = {0.17: 0.054, 0.0: 0.06, -0.14: 0.044}[y]
    K.rings([[(x * 1.0, yy, z) for x, yy, z in sec(y + 0.008, w, w * 0.82, -w * 0.98)], [(x, yy, z) for x, yy, z in sec(y - 0.008, w, w * 0.82, -w * 0.98)]], "brass", detail=True)
for s in (1, -1):
    K.rivets((s * 0.06, 0.15, 0.0), (s * 0.046, -0.12, 0.0), 9, n=(s, 0, 0), r=0.004)
# la machine : chaudière de laiton couchée, cheminée, le foyer qui rougeoie de chaque côté
K.lathe([(0, -0.07), (0.028, -0.066), (0.034, -0.05), (0.034, 0.05), (0.028, 0.066), (0, 0.07)], (0, 0.07, 0.066), "brass", seg=10, axis="y")
for y in (0.03, 0.11):
    K.torus(0.035, 0.005, (0, y, 0.066), "copper", seg=10, tseg=4, axis="y", detail=True)
K.lathe([(0.016, 0), (0.013, 0.01), (0.012, 0.055), (0.019, 0.07), (0.02, 0.078), (0.016, 0.08)], (0, 0.03, 0.084), "iron", seg=8)
K.lathe([(0.016, 0.079), (0.008, 0.07), (0, 0.07)], (0, 0.03, 0.084), "soot", seg=8, fix=True)
for s in (1, -1):
    K.box(0.014, 0.026, 0.018, (s * 0.034, 0.035, 0.04), "fire")
    K.pipe([(s * 0.03, 0.09, 0.08), (s * 0.05, 0.09, 0.05), (s * 0.05, 0.16, 0.02)], 0.005, "copper", seg=4, round_=0.015)
# le pilote dans son baquet, casque de cuir et lunettes
K.box(0.07, 0.09, 0.014, (0, -0.06, 0.044), "leather", top=(0.06, 0.08))
K.sphere(0.022, (0, -0.065, 0.07), "leather", seg=8, rings=5)
K.box(0.03, 0.008, 0.01, (0, -0.045, 0.07), "brass", detail=True)
# le nez de laiton vers l'arbre d'hélice, un patin de queue, deux roulettes
K.lathe([(0.03, 0), (0.026, 0.02), (0.012, 0.045), (0.008, 0.06)], (0, 0.235, -0.004), "brass", seg=8, axis="y")
K.pipe([(0, -0.24, -0.01), (0, -0.27, -0.06)], 0.005, "iron", seg=3)
for s in (1, -1):
    K.pipe([(s * 0.03, 0.08, -0.05), (s * 0.06, 0.07, -0.1)], 0.005, "iron", seg=3)
    K.lathe([(0.026, -0.006), (0.026, 0.006), (0.01, 0.008), (0.01, -0.008)], (s * 0.066, 0.07, -0.1), "iron", seg=8, axis="x", closed=True)

# -------------------------------------------------------------------- les ailes
LE = [(0.04, 0.07), (0.12, 0.12), (0.24, 0.13), (0.36, 0.09), (0.45, 0.01)]
FING = [(0.45, 0.01), (0.4, -0.12), (0.28, -0.18), (0.14, -0.18)]
SCAL = [(0.38, -0.04), (0.31, -0.12), (0.2, -0.14), (0.09, -0.13)]
WING = list(LE)
for i in range(1, len(FING)):
    WING += [SCAL[i - 1], FING[i]]
WING += [SCAL[3], (0.04, -0.12)]
OUTER = [(0.19, 0.128), (0.24, 0.13), (0.36, 0.09), (0.45, 0.01), (0.38, -0.04), (0.4, -0.12), (0.31, -0.12), (0.28, -0.18), (0.215, -0.143), (0.2, 0.0)]
D = 0.1
for s in (1, -1):
    side = lambda pts: [(s * x, y) for x, y in (pts if s > 0 else pts[::-1])]  # noqa: E731
    with K.on(xf((0, 0, 0.004), (0, -s * D, 0))):
        K.prism(side(WING), 0.0, 0.009, "canvas")
        K.prism(side(OUTER), 0.009, 0.014, "team", detail=True)
        # les nervures : de l'épaule à chaque doigt ; le longeron du bord d'attaque
        root = (s * 0.04, 0.03, 0.012)
        for x, y in FING[1:] + [(0.38, -0.04)]:
            K.pipe([root, (s * x, y, 0.012)], 0.0045, "armor_d", seg=4)
        K.pipe([(s * x, y, 0.012) for x, y in LE], 0.007, "wood", seg=4)
        K.pipe([(s * 0.12, 0.12, 0.012), (s * 0.31, -0.12, 0.012)], 0.004, "armor_d", seg=3)
        for x, y in FING:
            K.rivet((s * x, y, 0.014), (0, 0, 1), 0.007)
        lamp(K, (s * 0.445, 0.015, 0.024), 0.014)
        # le râtelier : trois fusées à corps d'ivoire, ogive de couleur, empennage de laiton
        K.box(0.08, 0.11, 0.01, (s * 0.15, 0.03, -0.022), "armor_d")
        for dx in (-0.026, 0.0, 0.026):
            x = s * 0.15 + dx
            K.cyl(0.011, 0.12, (x, -0.04, -0.036), "enamel", seg=6, axis="y")
            K.lathe([(0.011, 0), (0.008, 0.016), (0, 0.032)], (x, 0.08, -0.036), "team", seg=6, axis="y")
            K.box(0.028, 0.018, 0.003, (x, -0.035, -0.0375), "brass")
            K.box(0.003, 0.018, 0.028, (x, -0.035, -0.05), "brass")
    # les haubans, du poinçon au-dessus de la nacelle
    for x, y in ((0.24, 0.1), (0.3, -0.08)):
        K.pipe([(0, 0.0, 0.13), (s * x * math.cos(D), y, 0.016 + x * math.sin(D))], 0.002, "iron", seg=3)
K.pipe([(0, 0.0, 0.045), (0, 0.0, 0.13)], 0.005, "wood", seg=4)

PROP = prop(K, "rotor0", (0, 0.297, -0.004), 0.12, 4, axis="y", width=0.2)
finish(K, "eole", {"rotor0": PROP})
print("[eole] hélice", PROP)
