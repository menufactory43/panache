"""Le Canon Branly : un canon électromagnétique.

Deux roues pleines (flasques ivoire cloutés de nickel), une flèche qui porte une dynamo ivoire bobinée
de cuivre avec son volant de laiton et un coffre d'accumulateurs aux couleurs du camp ; sur le pivot, un
long tube de nickel enfilé de bobines de couleur entre des bagues de cuivre et des isolateurs de
porcelaine, une batterie de bouteilles allumées sur la culasse, une lueur bleue à la bouche.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, start  # noqa: E402
from kit import toward, xf  # noqa: E402
from rep import REP, insulator  # noqa: E402

K = start(REP)
K.use("hull")
AY, R = 0.04, 0.15

# --------------------------------------------------------------------- l'affût
K.cyl(0.022, 0.52, (-0.26, AY, 0.17), "laque", seg=8, axis="x")
for s in (1, -1):
    ax = "x" if s > 0 else "-x"
    c = (s * 0.25, AY, 0.17)
    K.torus(R, 0.025, c, "pneu", seg=16, tseg=5, axis=ax, scale=(1, 1, 1.1))
    K.lathe([(0, -0.02), (0.14, -0.02), (0.14, 0.02), (0.1, 0.026), (0.045, 0.026), (0.04, 0.045), (0, 0.048)], c, "ivoire", seg=16, axis=ax)
    K.lathe([(0.1, 0.022), (0.1, 0.03), (0.045, 0.03), (0.045, 0.022)], c, "ivoire_d", seg=16, axis=ax, closed=True, detail=True)
    for i in range(8):
        a = 2 * PI * i / 8
        K.rivet((c[0] + s * 0.021, AY + 0.12 * math.cos(a), 0.17 + 0.12 * math.sin(a)), (s, 0, 0), 0.009, "nickel")
    K.lathe([(0.02, 0.04), (0.02, 0.06), (0, 0.064)], c, "brass", seg=6, axis=ax)
# la flèche vers sa bêche, ses rails de nickel
T0, T1 = (0.0, 0.185), (-0.5, 0.075)
K.rings([[(-0.05, T0[0], T0[1] - 0.03), (0.05, T0[0], T0[1] - 0.03), (0.05, T0[0], T0[1] + 0.03), (-0.05, T0[0], T0[1] + 0.03)],
         [(-0.04, T1[0], T1[1] - 0.028), (0.04, T1[0], T1[1] - 0.028), (0.04, T1[0], T1[1] + 0.028), (-0.04, T1[0], T1[1] + 0.028)]], "laque")
for s in (1, -1):
    K.pipe([(s * 0.047, T0[0] - 0.02, T0[1] + 0.034), (s * 0.038, T1[0] + 0.02, T1[1] + 0.032)], 0.006, "nickel", seg=4)
    K.rivets((s * 0.052, -0.06, T0[1] - 0.012), (s * 0.043, -0.44, T1[1] + 0.012), 8, n=(s, 0, 0), r=0.005, mat="nickel")
K.box(0.2, 0.022, 0.1, (0, -0.51, 0.0), "laque", rot=(-0.3, 0, 0), top=(0.17, 0.022))
K.torus(0.03, 0.008, (0, -0.55, 0.1), "brass", seg=8, tseg=4)
# la dynamo : un tambour ivoire bobiné de cuivre, ses flasques nickelés, le volant de laiton
DY = (0.0, -0.26, 0.21)
K.lathe([(0, -0.085), (0.05, -0.08), (0.065, -0.07), (0.065, 0.07), (0.05, 0.08), (0, 0.085)], DY, "ivoire", seg=12, axis="x")
for x in (-0.05, -0.017, 0.017, 0.05):
    K.lathe([(0.07, -0.011), (0.07, 0.011), (0.064, 0.011), (0.064, -0.011)], (x, DY[1], DY[2]), "copper", seg=12, axis="x", closed=True, detail=True)
for s in (1, -1):
    K.lathe([(0.032, 0), (0.032, 0.014), (0.012, 0.02), (0, 0.02)], (s * 0.082, DY[1], DY[2]), "nickel", seg=8, axis="x" if s > 0 else "-x")
K.torus(0.042, 0.006, (0.112, DY[1], DY[2]), "brass", seg=10, tseg=4, axis="x")
for a in (0.0, PI / 2):
    K.box(0.006, 0.08, 0.008, (0.112, DY[1], DY[2]), "brass", rot=(a, 0, 0), center=True)
K.box(0.12, 0.05, 0.03, (0, DY[1], 0.14), "laque")
# le coffre d'accumulateurs aux couleurs du camp, ses bornes de laiton, un cadran allumé
K.box(0.18, 0.11, 0.085, (0, -0.4, 0.172), "team", top=(0.17, 0.1))
K.box(0.186, 0.116, 0.012, (0, -0.4, 0.176), "nickel", detail=True)
for s in (1, -1):
    K.cyl(0.01, 0.025, (s * 0.05, -0.4, 0.257), "brass", seg=6)
    K.rivets((s * 0.07, -0.44, 0.257), (s * 0.07, -0.36, 0.257), 3, r=0.005, mat="nickel")
K.lathe([(0.02, 0), (0.02, 0.006), (0.016, 0.008), (0.016, 0)], (0, -0.456, 0.225), "brass", seg=10, axis="-y", closed=True, detail=True)
K.lathe([(0.016, 0.004), (0, 0.006)], (0, -0.456, 0.225), "spark", seg=10, axis="-y", detail=True)
K.pipe([(0.05, -0.4, 0.27), (0.04, -0.33, 0.275), (0.02, -0.27, 0.27)], 0.005, "copper", seg=4, round_=0.02)
# le pivot
K.lathe([(0.092, 0), (0.092, 0.03), (0.08, 0.058), (0, 0.06)], (0, AY, 0.18), "nickel", seg=12)
K.rivet_ring((0, AY, 0.2), 0.093, 12, r=0.006, radial=True, mat="brass")

# --------------------------------------------------------------------- la pièce
K.use("turret")
C = (0.0, AY, 0.24)
at = lambda x, y, z: (C[0] + x, C[1] + y, C[2] + z)  # noqa: E731
PITCH = 0.32
for s in (1, -1):
    K.box(0.025, 0.2, 0.1, at(s * 0.062, -0.04, 0.01), "laque", top=(0.025, 0.16))
    K.rivets(at(s * 0.075, 0.03, 0.08), at(s * 0.075, -0.11, 0.08), 4, n=(s, 0, 0), r=0.005, mat="nickel")
# la batterie de condensateurs : un coffre de couleur, six bouteilles allumées, leur barre de cuivre
K.box(0.21, 0.2, 0.11, at(0, -0.17, 0.045), "team", top=(0.2, 0.19))
K.box(0.216, 0.206, 0.012, at(0, -0.17, 0.064), "nickel", detail=True)
for x in (-0.06, 0.0, 0.06):
    for y in (-0.12, -0.21):
        K.lathe([(0.021, 0), (0.021, 0.04), (0.012, 0.05), (0.012, 0.054)], at(x, y, 0.155), "verre", seg=8)
        K.cyl(0.01, 0.014, at(x, y, 0.208), "brass", seg=6)
for y in (-0.12, -0.21):
    K.pipe([at(-0.065, y, 0.222), at(0.065, y, 0.222)], 0.004, "copper", seg=4)
# le tube et ses bobines
G = at(0, -0.2, 0.09)
with K.on(xf(G, (PITCH, 0, 0))):
    K.cyl(0.028, 0.86, (0, 0, 0), "nickel", seg=10, axis="y")
    K.lathe([(0.052, 0.185), (0.052, 0.215), (0.03, 0.215), (0.03, 0.185)], (0, 0, 0), "brass", seg=10, axis="y", closed=True)
    for k in (0.28, 0.42, 0.56, 0.7):
        K.lathe([(0.06, k - 0.05), (0.073, k - 0.04), (0.073, k + 0.04), (0.06, k + 0.05), (0.03, k + 0.05), (0.03, k - 0.05)], (0, 0, 0), "team", seg=12, axis="y", closed=True)
        K.lathe([(0.051, k + 0.05), (0.051, k + 0.07), (0.03, k + 0.07), (0.03, k + 0.05)], (0, 0, 0), "copper", seg=10, axis="y", closed=True)
        for dy in (-0.025, 0.0, 0.025):
            K.torus(0.074, 0.004, (0, k + dy, 0), "copper", seg=12, tseg=3, axis="y", detail=True)
    K.lathe([(0.028, 0.8), (0.04, 0.82), (0.042, 0.855), (0.03, 0.86)], (0, 0, 0), "nickel_d", seg=10, axis="y")
    K.sphere(0.035, (0, 0.868, 0), "spark", seg=10, rings=6)
    K.box(0.11, 0.008, 0.008, (0, 0.868, 0), "arc", rot=(0.4, 0.3, 0.6), center=True)
# (les isolateurs se dressent à la verticale sur chaque bobine)
for k in (0.28, 0.42, 0.56, 0.7):
    insulator(K, (G[0], G[1] + k * math.cos(PITCH) - 0.072 * math.sin(PITCH), G[2] + k * math.sin(PITCH) + 0.07 * math.cos(PITCH)), 0.012)
MUZZLE = (0, -0.2 + 0.868 * math.cos(PITCH), 0.09 + 0.868 * math.sin(PITCH))

finish(K, "branly", {"turret": C})
print("[branly] bouche", MUZZLE)
