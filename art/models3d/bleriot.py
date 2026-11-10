"""Le Blériot XI de chasse (Raptor).

Fuselage fin, entoilé à l'avant et en treillis de bois nu à l'arrière (cordes à piano) jusqu'à la dérive
et au plan fixe aux couleurs du camp ; une seule aile aux panneaux extérieurs de couleur, haubanée
depuis une cabane ; moteur Anzani en éventail, hélice tractive bipale ; une Hotchkiss sur le capot.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, lamp, prop, start  # noqa: E402
from kit import xf  # noqa: E402

import kit as kitmod  # noqa: E402

K = start()
kitmod.GRADE[:] = [-0.13, 0.13]
K.use("hull")


def sec(y, w, top, bot, c=0.014):
    c = min(c, w * 0.5)
    return [(-w, y, top - c), (-w + c, y, top), (w - c, y, top), (w, y, top - c), (w, y, bot + c), (w - c, y, bot), (-w + c, y, bot), (-w, y, bot + c)]


# ---------------------------------------------------------------- le fuselage
K.rings([sec(0.39, 0.032, 0.03, -0.035), sec(0.33, 0.046, 0.044, -0.052), sec(0.28, 0.046, 0.044, -0.052)], "armor")
K.rings([sec(0.28, 0.045, 0.043, -0.051), sec(0.0, 0.041, 0.041, -0.046), sec(-0.05, 0.037, 0.039, -0.043)], "canvas")
K.rings([sec(0.285, 0.048, 0.046, -0.054), sec(0.272, 0.048, 0.046, -0.054)], "brass", detail=True)
for s in (1, -1):
    K.rivets((s * 0.047, 0.37, 0.0), (s * 0.047, 0.3, 0.0), 4, n=(s, 0, 0), r=0.004)
    for y in (0.2, 0.1, 0.0):
        K.box(0.003, 0.004, 0.085, (s * 0.044, y, -0.047), "wood", detail=True)
# l'Anzani : carter de laiton, trois cylindres à ailettes en éventail
K.lathe([(0.034, 0), (0.034, 0.03), (0.02, 0.04), (0, 0.04)], (0, 0.385, -0.003), "brass", seg=10, axis="y")
for a in (-1.0, 0.0, 1.0):
    with K.on(xf((math.sin(a) * 0.03, 0.385, -0.003 + math.cos(a) * 0.03), (0, a, 0))):
        K.cyl(0.013, 0.05, (0, 0, 0), "iron", seg=6)
        for z in (0.012, 0.024, 0.036):
            K.torus(0.0145, 0.003, (0, 0, z), "iron", seg=6, tseg=3, detail=True)
        K.cyl(0.006, 0.012, (0, 0, 0.05), "brass", seg=5)
# le treillis nu : quatre longerons jusqu'à l'étambot, montants, traverses et croisillons de corde à piano
TAIL = -0.46


def corner(y, sx, top):
    k = (-0.05 - y) / (-0.05 - TAIL)
    w = 0.037 * (1 - k) + 0.006 * k
    return (sx * w, y, (0.039 * (1 - k) + 0.026 * k) if top else (-0.043 * (1 - k)))


for sx in (1, -1):
    for top in (True, False):
        K.pipe([corner(-0.05, sx, top), corner(TAIL, sx, top)], 0.0045, "wood_l", seg=4)
for y in (-0.15, -0.25, -0.35):
    for sx in (1, -1):
        K.pipe([corner(y, sx, True), corner(y, sx, False)], 0.0035, "wood_l", seg=3)
        K.pipe([corner(y + 0.1, sx, True), corner(y, sx, False)], 0.0018, "iron", seg=3)
    K.pipe([corner(y, 1, True), corner(y, -1, True)], 0.0035, "wood_l", seg=3)
    K.pipe([corner(y, 1, False), corner(y, -1, False)], 0.0035, "wood_l", seg=3)
# l'empennage aux couleurs du camp : plan fixe, dérive, leurs nervures
for s in (1, -1):
    K.prism([(s * x, y) for x, y in ([(0.0, -0.37), (0.12, -0.38), (0.15, -0.42), (0.12, -0.465), (0.0, -0.47)] if s > 0 else [(0.0, -0.47), (0.12, -0.465), (0.15, -0.42), (0.12, -0.38), (0.0, -0.37)])], 0.016, 0.024, "team")
    for x in (0.045, 0.095):
        K.box(0.004, 0.085, 0.003, (s * x, -0.42, 0.024), "wood", detail=True)
K.rings([[(-0.004, -0.39, -0.03), (0.004, -0.39, -0.03), (0.004, -0.5, -0.03), (-0.004, -0.5, -0.03)],
         [(-0.004, -0.4, 0.04), (0.004, -0.4, 0.04), (0.004, -0.5, 0.05), (-0.004, -0.5, 0.05)],
         [(-0.003, -0.44, 0.08), (0.003, -0.44, 0.08), (0.003, -0.5, 0.075), (-0.003, -0.5, 0.075)]], "team")
K.pipe([(0, TAIL, 0.0), (0, TAIL - 0.02, -0.05)], 0.004, "iron", seg=3)

# ---------------------------------------------------------------------- l'aile
D = 0.05
APEX, KEEL = (0, 0.17, 0.13), (0, 0.2, -0.1)
for s in (1, -1):
    side = lambda pts: [(s * x, y) for x, y in (pts if s > 0 else pts[::-1])]  # noqa: E731
    with K.on(xf((0, 0, 0.03), (0, -s * D, 0))):
        K.prism(side([(0.0, 0.25), (0.46, 0.25), (0.51, 0.22), (0.52, 0.12), (0.48, 0.07), (0.0, 0.07)]), 0.0, 0.013, "canvas")
        K.prism(side([(0.2, 0.247), (0.46, 0.247), (0.507, 0.218), (0.517, 0.122), (0.478, 0.073), (0.2, 0.073)]), 0.013, 0.018, "team", detail=True)
        for x in (0.05, 0.1, 0.15, 0.24, 0.29, 0.34, 0.39, 0.44):
            K.box(0.006, 0.17, 0.004, (s * x, 0.16, 0.018 if x > 0.2 else 0.013), "armor_d" if x > 0.2 else "wood", detail=True)
        K.pipe([(0, 0.245, 0.007), (s * 0.46, 0.245, 0.007)], 0.008, "wood", seg=4)
        lamp(K, (s * 0.515, 0.17, 0.02), 0.013)
        # les cordes à piano, de la cabane et du train jusqu'à l'aile
        for y in (0.23, 0.1):
            K.pipe([(0, APEX[1], 0.1), (s * 0.3, y, 0.015)], 0.0018, "iron", seg=3)
            K.pipe([(0, KEEL[1], -0.13), (s * 0.3, y, 0.0)], 0.0018, "iron", seg=3)
    # la cabane, le train : jambes de bois, roues à rayons
    K.pipe([(s * 0.03, 0.23, 0.04), APEX], 0.0045, "wood", seg=4)
    K.pipe([(s * 0.03, 0.11, 0.04), APEX], 0.0045, "wood", seg=4)
    K.pipe([(s * 0.04, 0.3, -0.045), (s * 0.075, 0.27, -0.12)], 0.006, "wood", seg=4)
    K.pipe([(s * 0.04, 0.2, -0.045), (s * 0.075, 0.27, -0.12)], 0.005, "wood", seg=4)
    ax = "x" if s > 0 else "-x"
    K.lathe([(0.037, -0.007), (0.037, 0.007), (0.027, 0.006), (0.027, -0.006)], (s * 0.088, 0.27, -0.12), "iron", seg=10, axis=ax, closed=True)
    K.lathe([(0.027, -0.002), (0.027, 0.002), (0.008, 0.004), (0.008, -0.004)], (s * 0.088, 0.27, -0.12), "wood_l", seg=10, axis=ax, closed=True)
    K.lathe([(0.01, -0.01), (0.01, 0.01), (0, 0.014)], (s * 0.088, 0.27, -0.12), "brass", seg=6, axis=ax)
K.pipe([(-0.088, 0.27, -0.12), (0.088, 0.27, -0.12)], 0.004, "iron", seg=4)

# ------------------------------------------- le pilote et la mitrailleuse de capot
K.box(0.07, 0.08, 0.008, (0, 0.0, 0.041), "leather")
K.sphere(0.023, (0, 0.0, 0.064), "leather", seg=8, rings=5)
K.box(0.032, 0.008, 0.01, (0, 0.021, 0.066), "brass", detail=True)
K.box(0.012, 0.04, 0.012, (0, 0.05, 0.05), "enamel")  # l'écharpe
GZ = 0.074
K.box(0.03, 0.075, 0.032, (0, 0.24, GZ - 0.016), "gun")
K.cyl(0.013, 0.1, (0, 0.27, GZ), "brass", seg=8, axis="y")
for y in (0.285, 0.305, 0.325, 0.345):
    K.torus(0.0155, 0.003, (0, y, GZ), "brass", seg=8, tseg=3, axis="y", detail=True)
K.cyl(0.006, 0.07, (0, 0.37, GZ), "gun", seg=5, axis="y")
K.pipe([(0, 0.27, 0.042), (0, 0.27, GZ - 0.01)], 0.005, "iron", seg=3)

PROP = prop(K, "rotor0", (0, 0.432, -0.003), 0.14, 2, axis="y", width=0.18)
finish(K, "bleriot", {"rotor0": PROP})
print("[bleriot] hélice", PROP, "bouche", (0, 0.44, GZ))
