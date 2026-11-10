"""Le Mortier de 280 : un mortier de siège sur une locomobile à chenilles.

Chenilles de fer à maillons sur cinq galets, affût riveté sous une large plaque aux couleurs du camp,
chaudière cerclée et sa cheminée à l'arrière avec la soute à charbon, un râtelier d'obus, et sur la
plaque tournante rivetée un tube court et gras, fretté, braqué vers le ciel entre deux flasques massifs.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, start  # noqa: E402
from emp import EMP, boiler, coal_heap, e_lamp, e_stack, rivets_e  # noqa: E402
from kit import xf  # noqa: E402

K = start(EMP)
K.use("hull")

# ------------------------------------------------------------------- les chenilles
WHEELS = [(0.42, 0.085, 0.06), (-0.42, 0.075, 0.05)] + [(y, 0.068, 0.045) for y in (-0.3, -0.15, 0.0, 0.15, 0.3)]
for s in (1, -1):
    ax = "x" if s > 0 else "-x"
    K.track(s * 0.235, s * 0.375, WHEELS, "track", th=0.022, links=40)
    for y, z, r in WHEELS:
        K.lathe([(0, -0.065), (r, -0.065), (r, 0.058), (r * 0.8, 0.062), (r * 0.7, 0.045), (r * 0.4, 0.045), (r * 0.3, 0.066), (0, 0.068)], (s * 0.305, y, z), "fer_m", seg=10, axis=ax)
        K.lathe([(r * 0.28, 0.066), (r * 0.2, 0.076), (0, 0.078)], (s * 0.305, y, z), "laiton_t", seg=6, axis=ax)
    K.strip_x([(-0.47, 0.13), (-0.42, 0.172), (0.4, 0.172), (0.47, 0.14)], s * 0.225, s * 0.385, 0.012, "fer")
    rivets_e(K, (s * 0.37, -0.4, 0.184), (s * 0.37, 0.38, 0.184), 12)

# ---------------------------------------------------- l'affût et sa plaque de couleur
K.box(0.5, 0.88, 0.15, (0, 0, 0.125), "fer", top=(0.48, 0.86))
K.box(0.66, 0.62, 0.035, (0, 0.08, 0.268), "team", top=(0.64, 0.6))
for s in (1, -1):
    rivets_e(K, (s * 0.3, 0.36, 0.303), (s * 0.3, -0.2, 0.303), 9)
    rivets_e(K, (s * 0.251, 0.38, 0.19), (s * 0.251, -0.38, 0.19), 10, (s, 0, 0))
    K.box(0.006, 0.8, 0.03, (s * 0.2505, 0, 0.225), "team", detail=True)
    # un râtelier d'obus de chaque côté de la plaque tournante : corps de fer, ceinture de laiton
    for y in (0.3, 0.22):
        K.lathe([(0.03, 0), (0.03, 0.012), (0.032, 0.014), (0.032, 0.026), (0.03, 0.028), (0.03, 0.09), (0.022, 0.12), (0.008, 0.14), (0, 0.142)], (s * 0.26, y, 0.303), "fer_m", seg=8)
        K.lathe([(0.033, 0.014), (0.033, 0.026), (0.03, 0.026), (0.03, 0.014)], (s * 0.26, y, 0.303), "laiton_t", seg=8, closed=True, detail=True)
    e_lamp(K, (s * 0.22, 0.42, 0.33), 0.04)
rivets_e(K, (-0.28, 0.375, 0.303), (0.28, 0.375, 0.303), 8)
rivets_e(K, (-0.28, -0.215, 0.303), (0.28, -0.215, 0.303), 8)
# à l'arrière : la chaudière, sa cheminée, la soute à charbon
boiler(K, (0.14, -0.33, 0.27), 0.1, 0.26, face=(0, -1))
e_stack(K, (0.14, -0.33, 0.55), 0.035, 0.24)
K.pipe([(0.07, -0.3, 0.46), (0.05, -0.24, 0.42), (0.05, -0.2, 0.3)], 0.012, "laiton_t", seg=5, round_=0.03)
for sx, sy, w, d in ((1, 0, 0.014, 0.2), (-1, 0, 0.014, 0.2), (0, 1, 0.18, 0.014), (0, -1, 0.18, 0.014)):
    K.box(w, d, 0.125, (-0.15 + sx * 0.083, -0.33 + sy * 0.093, 0.27), "fer_m")
rivets_e(K, (-0.241, -0.25, 0.37), (-0.241, -0.41, 0.37), 5, (-1, 0, 0))
coal_heap(K, -0.21, -0.09, -0.39, -0.27, 0.36, 9, 0.024)

# --------------------------------------------------------------------- le mortier
K.use("turret")
C = (0.0, 0.06, 0.3)
at = lambda x, y, z: (C[0] + x, C[1] + y, C[2] + z)  # noqa: E731
K.lathe([(0.225, 0), (0.225, 0.04), (0.2, 0.062), (0, 0.064)], C, "fer_m", seg=14)
K.rivet_ring(at(0, 0, 0.052), 0.205, 18, r=0.007, mat="rivet_e")
K.rivet_ring(at(0, 0, 0.02), 0.2265, 18, r=0.007, mat="rivet_e", radial=True)
for s in (1, -1):
    K.rings([[(s * 0.13 - 0.026, y, z) for y, z in ((-0.15, 0.05), (0.11, 0.05), (0.07, 0.24), (-0.07, 0.26))],
             [(s * 0.13 + 0.026, y, z) for y, z in ((-0.15, 0.05), (0.11, 0.05), (0.07, 0.24), (-0.07, 0.26))]], "fer", at=C)
    rivets_e(K, at(s * 0.157, -0.12, 0.09), at(s * 0.157, 0.08, 0.09), 5, (s, 0, 0))
    K.lathe([(0.05, 0), (0.05, 0.014), (0.03, 0.022), (0, 0.023)], at(s * 0.156, -0.02, 0.17), "fer_m", seg=8, axis="x" if s > 0 else "-x")
K.cyl(0.035, 0.33, at(-0.165, -0.02, 0.17), "laiton_t", seg=8, axis="x")
K.torus(0.045, 0.007, at(0.185, -0.1, 0.11), "laiton_t", seg=10, tseg=4, axis="x")
for a in (0.0, PI / 2):
    K.box(0.008, 0.085, 0.008, at(0.185, -0.1, 0.11), "laiton_t", rot=(a, 0, 0), center=True)
PITCH = 1.0
G = at(0, -0.02 - 0.12 * math.cos(PITCH), 0.17 - 0.12 * math.sin(PITCH))
with K.on(xf(G, (PITCH, 0, 0))):
    K.lathe([(0, -0.05), (0.07, -0.045), (0.088, -0.02), (0.1, 0.0), (0.1, 0.36), (0.108, 0.36), (0.12, 0.38), (0.12, 0.41), (0.108, 0.42), (0.078, 0.42), (0.075, 0.38), (0, 0.38)], (0, 0, 0), "fer", seg=14, axis="y")
    K.lathe([(0.091, -0.04), (0.091, 0.02), (0.07, 0.02), (0.07, -0.04)], (0, 0, 0), "laiton_t", seg=12, axis="y", closed=True, detail=True)
    for k in (0.1, 0.22):
        K.lathe([(0.109, k), (0.109, k + 0.035), (0.098, k + 0.035), (0.098, k)], (0, 0, 0), "fer_m", seg=14, axis="y", closed=True)
    for i in range(10):
        a = 2 * PI * i / 10
        K.rivet((0.121 * math.cos(a), 0.395, 0.121 * math.sin(a)), (math.cos(a), 0, math.sin(a)), 0.008, "rivet_e")
    K.lathe([(0.075, 0.381), (0, 0.381)], (0, 0, 0), "soot", seg=14, axis="y", detail=True)
MUZZLE = (0, G[1] - C[1] + 0.42 * math.cos(PITCH), G[2] - C[2] + 0.42 * math.sin(PITCH))

finish(K, "mortier-280", {"turret": C})
print("[mortier-280] bouche", MUZZLE)
