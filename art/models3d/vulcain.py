"""Le Vulcain : un dirigeable de bombardement court et cuirassé.

Un gros cigare dont le dos est une cuirasse aux couleurs du camp, découpée en plaques par des cercles de
fer rivetés et une épine de fer, un nez-bélier de suie ; une coupole dorsale ; une lourde nacelle blindée
aux meurtrières rougeoyantes, sa cheminée, la soute ouverte sur un râtelier de bombes ; deux gros moteurs
sur des moignons d'aile, hélices propulsives ; un empennage de fer en croix, la dérive haute de couleur.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit as kitmod  # noqa: E402
from common import PI, finish, lamp, prop, start  # noqa: E402
from emp import EMP, e_stack  # noqa: E402
from kit import frame, xf  # noqa: E402

K = start(EMP)
kitmod.GRADE[:] = [-0.36, 0.3]
K.use("hull")
RX, RZ, L = 0.21, 0.176, 0.35


def engine_pod(x, y, z, r, ln):
    """Un moteur le long de Y : tambour de fer riveté, bagues de laiton, une ceinture de couleur, la grille qui luit derrière."""
    K.lathe([(r * 0.8, -ln / 2 - 0.004), (r, -ln / 2), (r, ln / 2), (r * 0.5, ln / 2 + r * 0.8), (0, ln / 2 + r * 1.3)], (x, y, z), "fer_m", seg=10, axis="y")
    K.lathe([(r * 1.05, -ln * 0.07), (r * 1.05, ln * 0.23), (r, ln * 0.23), (r, -ln * 0.07)], (x, y, z), "team", seg=10, axis="y", closed=True, detail=True)
    K.torus(r * 1.03, r * 0.1, (x, y - ln * 0.35, z), "laiton_t", seg=10, tseg=3, axis="y", detail=True)
    K.lathe([(r * 0.78, 0), (0, 0.002)], (x, y - ln / 2 - 0.005, z), "fire", seg=10, axis="-y", detail=True)
    e_stack(K, (x, y - ln * 0.2, z + r * 0.8), r * 0.28, 0.07, seg=6)


# ---------------------------------------------------------------- l'enveloppe
N = 12
PROF = [(math.sin(PI * k / N), -L * math.cos(PI * k / N)) for k in range(N + 1)]
PROF[0], PROF[-1] = (0.0, -L), (0.0, L)
ENV = xf((0, 0, 0), (-PI / 2, 0, 0), (RX, RZ, 1))
TOP = (PI * 1.5 - PI * 3 / 14, PI * 1.5 + PI * 3 / 14)
K.lathe(PROF[:3], (0, 0, 0), "fer_m", seg=14, M=ENV, fix=True)
K.lathe(PROF[-3:], (0, 0, 0), "soot", seg=14, M=ENV, fix=True)
K.lathe(PROF[2:-2][::-1], (0, 0, 0), "team", seg=3, hs=9, M=ENV, arc=TOP, fix=False)
K.lathe(PROF[2:-2][::-1], (0, 0, 0), "fer_m", seg=11, hs=33, M=ENV, arc=(TOP[1], TOP[0] + 2 * PI), fix=False)
# les cercles de fer en travers du dos, leurs rivets ; l'épine de fer sur la crête
for y in (0.2, 0.07, -0.06, -0.19):
    k = math.sqrt(1 - (y / L) ** 2)
    K.lathe([(1.0, -0.014), (1.05, -0.011), (1.05, 0.011), (1.0, 0.014)], (0, 0, 0), "fer", seg=14, closed=True, detail=True, M=xf((0, y, 0), (-PI / 2, 0, 0), (RX * k, RZ * k, 1)))
    for i in range(9):
        a = PI * (0.1 + 0.8 * i / 8)
        K.rivet((RX * k * 1.05 * math.cos(a), y, RZ * k * 1.05 * math.sin(a)), (math.cos(a), 0, math.sin(a)), 0.007, "rivet_e")
K.strip_x([(L * 0.75 * math.cos(a), RZ * 1.0 * math.sin(a) ** 0.9 + 0.004) for a in [PI * (0.14 + 0.72 * i / 10) for i in range(11)]], -0.02, 0.02, 0.016, "fer")
K.rivets((0, 0.22, RZ + 0.018), (0, -0.22, RZ + 0.018), 9, r=0.007, mat="rivet_e")
# le nez-bélier : une calotte de suie, un collier de laiton, une pointe de fer ; deux fanaux
K.torus(0.085, 0.01, (0, L - 0.075, 0), "laiton_t", seg=12, tseg=4, axis="y", scale=(1, 1, 0.84), detail=True)
K.lathe([(0.022, 0), (0.016, 0.03), (0, 0.085)], (0, L - 0.01, 0), "fer_m", seg=6, axis="y")
for s in (1, -1):
    lamp(K, (s * 0.06, L - 0.05, -0.05), 0.018)
# la coupole dorsale à l'avant : un tambour de laiton, sa calotte de couleur, un canon court
K.lathe([(0.046, -0.02), (0.046, 0.02), (0.04, 0.034), (0.034, 0.036)], (0, 0.17, RZ * 0.86 + 0.02), "laiton_t", seg=10)
K.lathe([(0.04, 0.034), (0.036, 0.046), (0, 0.05)], (0, 0.17, RZ * 0.86 + 0.02), "team", seg=10)
K.cyl(0.008, 0.09, (0, 0.2, RZ * 0.86 + 0.035), "gun", seg=6, axis="y")

# --------------------------------------------------------------------- la nacelle
GZ = -0.25
K.box(0.16, 0.36, 0.09, (0, 0.02, GZ - 0.045), "fer", top=(0.15, 0.34))
K.prism([(-0.08, 0.2), (0.08, 0.2), (0, 0.29)], GZ - 0.04, GZ + 0.035, "fer_m")
for s in (1, -1):
    with K.on(frame((s * 0.0805, 0.02, GZ), (s, 0, 0))):
        K.box(0.2, 0.014, 0.004, (0.02 * s, 0.03, 0), "fire", detail=True)
        K.box(0.22, 0.006, 0.006, (0.02 * s, 0.042, 0), "fer_m", detail=True)
        for u in (-0.08, 0.06):
            K.torus(0.016, 0.005, (u, -0.015, 0.003), "laiton_t", seg=8, tseg=3, detail=True)
            K.lathe([(0.013, 0), (0, 0.004)], (u, -0.015, 0.002), "amber", seg=8, detail=True)
        K.rivets((-0.16, -0.036, 0), (0.16, -0.036, 0), 9, r=0.005, mat="rivet_e")
        K.rivets((-0.16, 0.055, 0), (0.16, 0.055, 0), 9, r=0.005, mat="rivet_e")
    for y in (0.12, -0.08):
        K.pipe([(s * 0.06, y, GZ + 0.04), (s * 0.12, y, -0.13)], 0.008, "fer_m", seg=4)
e_stack(K, (0, -0.1, GZ + 0.04), 0.024, 0.1, seg=8)
# la soute dessous : un râtelier de quatre bombes, nez de couleur, empennage de laiton
K.box(0.12, 0.22, 0.012, (0, 0.0, GZ - 0.056), "fer_m")
for x in (-0.035, 0.035):
    for y in (0.05, -0.07):
        K.lathe([(0, -0.05), (0.014, -0.04), (0.02, -0.01), (0.02, 0.04)], (x, y, GZ - 0.08), "fer", seg=6, axis="y", fix=True)
        K.lathe([(0.02, 0.04), (0.015, 0.06), (0, 0.075)], (x, y, GZ - 0.08), "team", seg=6, axis="y")
        K.box(0.045, 0.014, 0.004, (x, y - 0.05, GZ - 0.082), "laiton_t")
        K.box(0.004, 0.014, 0.045, (x, y - 0.05, GZ - 0.1025), "laiton_t")

# ------------------------------------------------- les moteurs et l'empennage
PROPS = []
for s in (1, -1):
    x = s * 0.31
    K.box(0.2, 0.08, 0.025, (s * 0.2, -0.06, -0.0925), "fer", top=(0.2, 0.06))
    K.pipe([(s * 0.15, -0.04, -0.16), (x, -0.06, -0.1)], 0.008, "fer_m", seg=4)
    engine_pod(x, -0.06, -0.08, 0.045, 0.18)
    PROPS.append((x, -0.172, -0.08))
K.rings([[(-0.006, -0.22, 0.09), (0.006, -0.22, 0.09), (0.006, -0.4, 0.09), (-0.006, -0.4, 0.09)],
         [(-0.005, -0.29, 0.24), (0.005, -0.29, 0.24), (0.005, -0.4, 0.26), (-0.005, -0.4, 0.26)]], "team")
K.rings([[(-0.006, -0.22, -0.09), (0.006, -0.22, -0.09), (0.006, -0.4, -0.09), (-0.006, -0.4, -0.09)],
         [(-0.005, -0.29, -0.21), (0.005, -0.29, -0.21), (0.005, -0.4, -0.22), (-0.005, -0.4, -0.22)]], "fer")
K.box(0.016, 0.11, 0.012, (0, -0.345, 0.25), "laiton_t")
for s in (1, -1):
    K.prism([(s * x, y) for x, y in ([(0.1, -0.23), (0.28, -0.3), (0.28, -0.4), (0.1, -0.4)] if s < 0 else [(0.1, -0.4), (0.28, -0.4), (0.28, -0.3), (0.1, -0.23)])], -0.006, 0.006, "fer")
    K.box(0.012, 0.1, 0.016, (s * 0.28, -0.35, -0.008), "laiton_t")
    K.rivets((s * 0.13, -0.3, 0.006), (s * 0.26, -0.34, 0.006), 4, r=0.006, mat="rivet_e")
    K.sphere(0.01, (s * 0.285, -0.4, 0.0), "fire", seg=6, rings=4)

SCREW = prop(K, "screw", (4, 0, 0), 0.1, 3, axis="y", blade="fer_m", tip="team", width=0.2, hub="laiton_t", hub_r=0.02)
finish(K, "vulcain", {"screw": SCREW})
print("[vulcain] hélices", PROPS)
