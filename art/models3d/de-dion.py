"""L'Autocanon De Dion : un tricar De Dion-Bouton.

Le conducteur à cheval sur la roue avant, un monocylindre à ailettes, et sur le plateau arrière (aux
couleurs du camp, sous sa lisse nickelée) un canon-revolver à quatre tubes pointé vers le ciel derrière
un bouclier cintré de couleur, son chargeur à tambour sur le flanc.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, start  # noqa: E402
from kit import xf  # noqa: E402
from rep import REP, carriage_lamp, driver, wire_wheel  # noqa: E402

K = start(REP)
K.use("hull")

# ------------------------------------------------- l'avant : la roue, le guidon, la selle
wire_wheel(K, (0, 0.34, 0.12), 0.12, 0.045, side=1, n=12)
arc = [(0.34 + 0.15 * math.cos(a), 0.12 + 0.15 * math.sin(a)) for a in [PI * (0.85 - 0.7 * i / 5) for i in range(6)]]
K.strip_x(arc, -0.022, 0.022, 0.008, "ivoire")
for s in (1, -1):
    K.pipe([(s * 0.032, 0.34, 0.12), (s * 0.026, 0.3, 0.31)], 0.008, "nickel", seg=5)
    K.pipe([(s * 0.026, 0.3, 0.31), (s * 0.11, 0.27, 0.315)], 0.006, "nickel", seg=4)
    K.cyl(0.011, 0.045, (s * 0.09 if s > 0 else s * 0.135, 0.27, 0.315), "leather", seg=6, axis="x")
carriage_lamp(K, (0, 0.375, 0.29), 0.034)
K.box(0.06, 0.36, 0.05, (0, 0.12, 0.175), "laque")
K.pipe([(0, 0.28, 0.2), (0, 0.3, 0.29)], 0.012, "laque", seg=5)
K.lathe([(0, 0), (0.05, 0.005), (0.055, 0.02), (0.03, 0.032), (0, 0.033)], (0, 0.16, 0.23), "leather", seg=8, M=xf((0, 0.16, 0.23), (0, 0, 0), (1, 1.1, 1)))
for s in (1, -1):
    K.cyl(0.006, 0.035, (s * 0.03, 0.13, 0.2), "nickel", seg=4)
driver(K, (0, 0.17, 0.325), "ivoire", "team", goggles=True)
# le De Dion : cylindre à ailettes, dôme de laiton, carburateur, l'échappement vers l'arrière
K.cyl(0.04, 0.12, (0, 0.0, 0.12), "nickel_d", seg=10)
for z in (0.14, 0.165, 0.19, 0.215):
    K.lathe([(0.056, -0.004), (0.056, 0.004), (0.04, 0.004), (0.04, -0.004)], (0, 0.0, z), "nickel", seg=10, closed=True)
K.sphere(0.03, (0, 0.0, 0.24), "brass", seg=8, rings=4, half=True)
K.cyl(0.015, 0.04, (0.04, 0.02, 0.17), "brass", seg=6, axis="x")
K.pipe([(-0.04, -0.02, 0.15), (-0.09, -0.12, 0.13), (-0.12, -0.34, 0.12)], 0.01, "nickel_d", seg=5, round_=0.03)
K.cyl(0.014, 0.06, (-0.12, -0.3, 0.12), "nickel_d", seg=6, axis="-y")

# ---------------------------------------- l'arrière : l'essieu, les roues, le plateau du canon
K.cyl(0.015, 0.46, (-0.23, -0.16, 0.14), "laque", seg=6, axis="x")
for s in (1, -1):
    wire_wheel(K, (s * 0.235, -0.16, 0.14), 0.14, 0.05, side=s, n=12)
    arc = [(-0.16 + 0.172 * math.cos(a), 0.14 + 0.172 * math.sin(a)) for a in [PI * (0.92 - 0.84 * i / 7) for i in range(8)]]
    K.strip_x(arc, s * 0.195, s * 0.275, 0.01, "ivoire")
    K.strip_x([(a, b + 0.002) for a, b in arc], s * 0.266, s * 0.28, 0.01, "laque", detail=True)
K.box(0.4, 0.38, 0.05, (0, -0.15, 0.21), "team", top=(0.39, 0.37))
K.box(0.41, 0.39, 0.016, (0, -0.15, 0.204), "nickel")
for s in (1, -1):
    K.rivets((s * 0.18, 0.0, 0.26), (s * 0.18, -0.3, 0.26), 7, r=0.006, mat="nickel")
    K.pipe([(s * 0.2, 0.03, 0.312), (s * 0.2, -0.33, 0.312)], 0.005, "nickel", seg=4)
    for y in (0.02, -0.15, -0.32):
        K.cyl(0.004, 0.052, (s * 0.2, y, 0.26), "nickel", seg=4)
    # deux coffres à munitions ivoire à l'arrière du plateau
    K.box(0.1, 0.06, 0.06, (s * 0.1, -0.3, 0.26), "ivoire", top=(0.095, 0.055))
    K.box(0.104, 0.064, 0.008, (s * 0.1, -0.3, 0.295), "laque", detail=True)
    K.box(0.02, 0.006, 0.014, (s * 0.1, -0.332, 0.285), "brass", detail=True)

# ---------------------------------------------------------------- le canon-revolver
K.use("turret")
C = (0.0, -0.16, 0.26)
at = lambda x, y, z: (C[0] + x, C[1] + y, C[2] + z)  # noqa: E731
K.lathe([(0.092, -0.025), (0.092, 0.01), (0.08, 0.025), (0, 0.027)], C, "nickel", seg=12)
K.lathe([(0.094, 0.0), (0.094, 0.014), (0.09, 0.014), (0.09, 0.0)], C, "brass", seg=12, closed=True, detail=True)
# le siège du servant, derrière
K.lathe([(0, 0), (0.04, 0.004), (0.045, 0.016), (0.02, 0.024), (0, 0.025)], at(0, -0.11, 0.06), "leather", seg=8)
K.cyl(0.008, 0.06, at(0, -0.11, 0.01), "nickel", seg=5)
K.pipe([at(0, -0.03, 0.02), at(0, -0.11, 0.02)], 0.008, "nickel", seg=4)
# le bouclier cintré, en deux volets de couleur de part et d'autre des tubes
for s in (1, -1):
    with K.on(xf(at(s * 0.078, 0.11, 0.03), (0.25, 0, -s * 0.35))):
        K.box(0.14, 0.02, 0.19, (0, 0, 0), "team", top=(0.13, 0.02))
        K.box(0.14, 0.024, 0.012, (0, 0, 0.182), "nickel", detail=True)
        K.box(0.012, 0.024, 0.18, (s * 0.066, 0, 0.005), "nickel", detail=True)
        K.rivets((-s * 0.05, 0.01, 0.02), (-s * 0.05, 0.01, 0.17), 4, n=(0, 1, 0), r=0.006, mat="nickel")
for s in (1, -1):
    K.box(0.02, 0.06, 0.1, at(s * 0.05, 0.0, 0.02), "laque")
PITCH = 1.05
G = at(0, -0.02, 0.12)
with K.on(xf(G, (PITCH, 0, 0))):
    K.lathe([(0, -0.02), (0.045, -0.015), (0.052, 0.0), (0.052, 0.09), (0.04, 0.1)], (0, 0, 0), "laque", seg=10, axis="y")
    for u, v in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
        K.cyl(0.0125, 0.32, (u * 0.022, 0.02, v * 0.022), "gun", seg=5, axis="y")
    for y in (0.14, 0.28):
        K.lathe([(0.046, 0), (0.046, 0.02), (0.01, 0.02), (0.01, 0)], (0, y, 0), "nickel", seg=10, axis="y", closed=True)
    # le chargeur à tambour sur le flanc, le viseur à œilleton
    K.lathe([(0, 0), (0.05, 0.003), (0.052, 0.028), (0.02, 0.034), (0, 0.035)], (0.052, 0.03, 0.0), "ivoire", seg=12, axis="x")
    K.cyl(0.02, 0.04, (0.052, 0.03, 0.0), "brass", seg=8, axis="x")
    K.torus(0.024, 0.004, (-0.062, 0.12, 0.05), "nickel", seg=8, tseg=3, axis="y")
    K.cyl(0.004, 0.05, (-0.062, 0.12, 0.0), "nickel", seg=4)
MUZZLE = (0, -0.02 + 0.34 * math.cos(PITCH), 0.12 + 0.34 * math.sin(PITCH))

finish(K, "de-dion", {"turret": C})
print("[de-dion] bouche", MUZZLE)
