"""L'Épervier : un chasseur biplan à vapeur, trapu.

Un court baril de fer riveté pour fuselage, le capot de chaudière cerclé de laiton qui rougeoie par ses
persiennes, le plan supérieur aux couleurs du camp (nervures sombres), un plan inférieur de suie, des
mâts en I croisés de haubans, le pilote avec la cheminée dans le dos et la caisse à charbon, deux
mitrailleuses à ailettes sur le capot, un empennage de couleur, deux roues à rais, une hélice bipale.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit as kitmod  # noqa: E402
from common import PI, finish, lamp, prop, start  # noqa: E402
from emp import EMP, e_stack  # noqa: E402
from kit import xf  # noqa: E402

K = start(EMP)
kitmod.GRADE[:] = [-0.2, 0.2]
K.use("hull")


def hoop(y, w, top, bot, n=10):
    cz, hz = (top + bot) / 2, (top - bot) / 2
    return [(w * math.cos(2 * PI * k / n), y, cz + hz * math.sin(2 * PI * k / n)) for k in range(n)]


# ---------------------------------------------------------------- le fuselage
K.rings([hoop(0.27, 0.06, 0.06, -0.06), hoop(0.1, 0.066, 0.066, -0.066), hoop(-0.12, 0.05, 0.05, -0.05), hoop(-0.42, 0.012, 0.03, 0.0)], "fer_m")
for s in (1, -1):
    K.rivets((s * 0.062, 0.2, 0.03), (s * 0.05, -0.1, 0.026), 8, n=(s, 0, 0.5), r=0.005, mat="rivet_e")
    K.rivets((s * 0.062, 0.2, -0.03), (s * 0.05, -0.1, -0.026), 8, n=(s, 0, -0.5), r=0.005, mat="rivet_e")
for y in (0.18, 0.0, -0.2):
    w = 0.064 if y > -0.1 else 0.042
    K.torus(w + 0.001, 0.003, (0, y, 0.0 if y > -0.1 else 0.012), "fer", seg=10, tseg=3, axis="y", detail=True)
# le capot de chaudière : un tambour cerclé de laiton, ses persiennes qui rougeoient, la grille et son cône
K.lathe([(0.062, 0), (0.07, 0.006), (0.07, 0.064), (0.062, 0.07)], (0, 0.26, 0), "fer", seg=12, axis="y")
for y in (0.268, 0.322):
    K.torus(0.071, 0.006, (0, y, 0), "laiton_t", seg=12, tseg=4, axis="y", detail=True)
for i in range(8):
    a = 2 * PI * i / 8 + PI / 8
    K.box(0.014, 0.036, 0.006, (0.0715 * math.cos(a), 0.295, 0.0715 * math.sin(a)), "fire", rot=(0, PI / 2 - a, 0), center=True, detail=True)
K.lathe([(0.062, 0.0), (0, 0.002)], (0, 0.331, 0), "soot", seg=12, axis="y", detail=True)
for z in (-0.03, 0.0, 0.03):
    K.box(0.1, 0.004, 0.006, (0, 0.334, z - 0.003), "fire", detail=True)
for s in (1, -1):
    for y in (0.25, 0.22):
        K.pipe([(s * 0.06, y, -0.01), (s * 0.085, y - 0.01, -0.035)], 0.008, "soot", seg=4)

# ---------------------------------------------------------------- les deux plans
WING = [(0, 0.2), (0.4, 0.19), (0.45, 0.16), (0.45, 0.06), (0.41, 0.035), (0, 0.04)]
LOW = [(0, 0.17), (0.37, 0.165), (0.4, 0.13), (0.4, 0.05), (0.37, 0.03), (0, 0.03)]
for s in (1, -1):
    side = lambda pts: [(s * x, y) for x, y in (pts if s > 0 else pts[::-1])]  # noqa: E731
    K.prism(side(WING), 0.14, 0.153, "team")
    K.prism(side(LOW), -0.06, -0.049, "fer")
    for x in (0.08, 0.16, 0.24, 0.32, 0.4):
        K.box(0.006, 0.15, 0.004, (s * x, 0.115, 0.153), "fer", detail=True)
        if x < 0.36:
            K.box(0.005, 0.13, 0.004, (s * x, 0.1, -0.049), "fer_m", detail=True)
    K.pipe([(s * 0.01, 0.195, 0.147), (s * 0.4, 0.186, 0.147)], 0.008, "fer_m", seg=4)
    K.box(0.16, 0.006, 0.004, (s * 0.34, 0.055, 0.153), "fer", detail=True)
    K.rivets((s * 0.06, 0.05, 0.153), (s * 0.4, 0.05, 0.153), 8, r=0.005, mat="rivet_e")
    # les mâts en I, leurs haubans croisés, la cabane
    for y in (0.15, 0.06):
        K.box(0.012, 0.024, 0.2, (s * 0.305, y, -0.055), "fer_m")
    K.pipe([(s * 0.3, 0.15, -0.05), (s * 0.31, 0.07, 0.14)], 0.002, "fer", seg=3)
    K.pipe([(s * 0.3, 0.06, -0.05), (s * 0.31, 0.16, 0.14)], 0.002, "fer", seg=3)
    K.pipe([(s * 0.05, 0.1, -0.05), (s * 0.3, 0.11, 0.14)], 0.002, "fer", seg=3)
    for y in (0.17, 0.07):
        K.pipe([(s * 0.03, y, 0.05), (s * 0.05, y, 0.14)], 0.006, "fer_m", seg=4)
    lamp(K, (s * 0.445, 0.115, 0.165), 0.014)

# --------------------------------------------- le pilote, la cheminée, les mitrailleuses
K.torus(0.04, 0.007, (0, -0.04, 0.052), "laiton_t", seg=10, tseg=4, scale=(1, 1.2, 1))
K.sphere(0.024, (0, -0.04, 0.08), "leather", seg=8, rings=5)
K.box(0.04, 0.01, 0.008, (0, -0.017, 0.08), "laiton_t")
K.box(0.012, 0.05, 0.012, (0.02, -0.07, 0.062), "team")
K.box(0.07, 0.006, 0.032, (0, 0.005, 0.06), "jar", rot=(0.5, 0, 0))
e_stack(K, (0, -0.1, 0.045), 0.02, 0.13, seg=8)
K.box(0.07, 0.05, 0.03, (0, -0.16, 0.04), "fer", top=(0.06, 0.04))
for x, y in ((-0.015, -0.155), (0.015, -0.165)):
    K.box(0.022, 0.02, 0.014, (x, y, 0.07), "coal", rot=(x * 30, 0, 0.4))
for s in (1, -1):
    K.box(0.024, 0.07, 0.026, (s * 0.025, 0.2, 0.062), "gun")
    K.cyl(0.011, 0.1, (s * 0.025, 0.235, 0.077), "laiton_t", seg=6, axis="y")
    for y in (0.25, 0.27, 0.29, 0.31):
        K.torus(0.012, 0.003, (s * 0.025, y, 0.077), "laiton_t", seg=6, tseg=3, axis="y", detail=True)
    K.cyl(0.007, 0.03, (s * 0.025, 0.335, 0.077), "gun", seg=5, axis="y")

# --------------------------------------------------------- l'empennage et le train
for s in (1, -1):
    K.prism([(s * x, y) for x, y in ([(0, -0.32), (0.15, -0.35), (0.15, -0.41), (0, -0.43)] if s < 0 else [(0, -0.43), (0.15, -0.41), (0.15, -0.35), (0, -0.32)])], 0.022, 0.03, "team")
    K.prism([(s * x, y) for x, y in ([(0, -0.43), (0.15, -0.41), (0.13, -0.45), (0, -0.46)] if s < 0 else [(0, -0.46), (0.13, -0.45), (0.15, -0.41), (0, -0.43)])], 0.0225, 0.0295, "fer")
    for x in (0.05, 0.1):
        K.box(0.004, 0.08, 0.003, (s * x, -0.385, 0.03), "fer", detail=True)
K.rings([[(-0.005, -0.3, 0.02), (0.005, -0.3, 0.02), (0.005, -0.44, 0.02), (-0.005, -0.44, 0.02)],
         [(-0.004, -0.37, 0.13), (0.004, -0.37, 0.13), (0.004, -0.44, 0.14), (-0.004, -0.44, 0.14)]], "team")
K.rings([[(-0.005, -0.44, 0.02), (0.005, -0.44, 0.02), (0.005, -0.47, 0.02), (-0.005, -0.47, 0.02)],
         [(-0.004, -0.44, 0.14), (0.004, -0.44, 0.14), (0.004, -0.48, 0.12), (-0.004, -0.48, 0.12)]], "fer")
K.sphere(0.01, (0, -0.44, 0.148), "fire", seg=6, rings=4)
for s in (1, -1):
    K.pipe([(s * 0.03, 0.22, -0.06), (s * 0.08, 0.17, -0.15)], 0.006, "fer", seg=4)
    K.pipe([(s * 0.03, 0.12, -0.06), (s * 0.08, 0.17, -0.15)], 0.006, "fer", seg=4)
    ax = "x" if s > 0 else "-x"
    K.lathe([(0.045, -0.009), (0.045, 0.009), (0.034, 0.008), (0.034, -0.008)], (s * 0.09, 0.17, -0.15), "fer", seg=10, axis=ax, closed=True)
    K.lathe([(0.034, -0.003), (0.034, 0.003), (0.01, 0.005), (0.01, -0.005)], (s * 0.09, 0.17, -0.15), "fer_m", seg=10, axis=ax, closed=True)
    K.lathe([(0.012, -0.012), (0.012, 0.012), (0, 0.016)], (s * 0.09, 0.17, -0.15), "laiton_t", seg=6, axis=ax)
K.pipe([(-0.09, 0.17, -0.15), (0.09, 0.17, -0.15)], 0.005, "fer", seg=4)
K.pipe([(0, -0.36, 0.0), (0, -0.42, -0.06)], 0.006, "fer", seg=3)

PROP = prop(K, "rotor0", (0, 0.35, 0), 0.15, 2, axis="y", blade="wood", tip="laiton_t", width=0.18, hub="laiton_t", hub_r=0.022)
finish(K, "epervier", {"rotor0": PROP})
