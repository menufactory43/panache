"""L'Hydroglisseur (Lancer) : le glisseur du comte de Lambert.

Coque de bois verni et pont aux couleurs du camp sur une jupe de toile sombre, moteur à quatre cylindres
de laiton, grande hélice aérienne dans sa cage à la poupe ; à l'avant, la tourelle de la lance
électrique : bobines de cuivre et de laiton, isolateurs de porcelaine, bouteilles de Leyde, l'étincelle au bout.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, lamp, start  # noqa: E402
from kit import xf  # noqa: E402

K = start()
K.use("hull")

# ------------------------------------------------------------------ la jupe
def oval(w, l, z, n=18):
    return [(w * math.copysign(abs(math.cos(a)) ** 0.75, math.cos(a)), 0.02 + l * math.copysign(abs(math.sin(a)) ** 0.75, math.sin(a)), z) for a in [2 * PI * i / n for i in range(n)]]


K.rings([oval(0.3, 0.47, 0.0), oval(0.335, 0.5, 0.045), oval(0.33, 0.495, 0.09), oval(0.29, 0.46, 0.135)], "skirt")
K.rings([oval(0.345, 0.51, 0.0), oval(0.35, 0.515, 0.018)], "canvas")
for p in oval(0.312, 0.478, 0.118, 26):
    K.rivet(p, (p[0], p[1] - 0.02, 0.25), 0.007)
# la corde de laçage, en haut de la jupe
K.pipe(oval(0.3, 0.468, 0.132, 18) + [oval(0.3, 0.468, 0.132, 18)[0]], 0.008, "canvas", seg=4)

# ------------------------------------------------------------------ la coque
SEC = [(0.54, 0.025, 0.24, 0.18), (0.44, 0.16, 0.252, 0.13), (0.24, 0.265, 0.262, 0.115), (-0.28, 0.28, 0.262, 0.115), (-0.43, 0.25, 0.26, 0.125), (-0.5, 0.2, 0.256, 0.15)]


def section(y, w, top, bot, inset=0.0, lift=0.0):
    w = max(0.012, w - inset)
    c = min(0.06, w * 0.6, (top - bot) * 0.45)
    return [(-w, y, top + lift), (w, y, top + lift), (w, y, bot + c + lift), (w - c, y, bot + lift), (-(w - c), y, bot + lift), (-w, y, bot + c + lift)]


K.rings([section(*s) for s in SEC], "wood")
# le pont aux couleurs du camp, dans son plat-bord de laiton ; les joints du bordé
K.rings([[(x, y * 0.95, z) for x, y, z in section(y, w, top + 0.016, top - 0.02, inset=0.04)] for y, w, top, bot in SEC], "team")
for s in (1, -1):
    K.pipe([(s * (w - 0.012), y, top + 0.006) for y, w, top, bot in SEC], 0.011, "brass", seg=5)
    for k in (0.35, 0.7):
        K.pipe([(s * (w + 0.002), y, bot + (top - bot) * k + min(0.06, w * 0.6) * (1 - k)) for y, w, top, bot in SEC[1:]], 0.003, "soot", seg=3, detail=True)
    K.rivets((s * 0.2, 0.2, 0.28), (s * 0.215, -0.4, 0.28), 9, r=0.006)
for x in (-0.12, -0.04, 0.04, 0.12):
    K.box(0.005, 0.66, 0.004, (x, -0.06, 0.277), "soot", detail=True)
# l'étrave ferrée de laiton, deux fanaux, un taquet
K.rings([[(-0.03, 0.5, 0.17), (0.03, 0.5, 0.17), (0.03, 0.5, 0.25), (-0.03, 0.5, 0.25)], [(-0.008, 0.56, 0.19), (0.008, 0.56, 0.19), (0.008, 0.56, 0.245), (-0.008, 0.56, 0.245)]], "brass")
for s in (1, -1):
    K.box(0.012, 0.012, 0.04, (s * 0.1, 0.4, 0.27), "iron")
    lamp(K, (s * 0.1, 0.41, 0.335), 0.028)
K.box(0.07, 0.016, 0.012, (0, 0.33, 0.29), "brass")
K.box(0.016, 0.016, 0.014, (0, 0.33, 0.278), "brass")

# ------------------------------------------------------------------ le moteur
EY = -0.25
K.box(0.2, 0.2, 0.085, (0, EY, 0.275), "iron", top=(0.17, 0.18))
K.rivets((-0.085, EY - 0.09, 0.36), (0.085, EY - 0.09, 0.36), 5, r=0.006)
for s in (1, -1):
    for y in (EY - 0.05, EY + 0.05):
        K.lathe([(0.03, 0), (0.03, 0.07), (0.022, 0.082), (0, 0.084)], (s * 0.062, y, 0.355), "brass", seg=8)
        for z in (0.015, 0.032, 0.049):
            K.torus(0.031, 0.005, (s * 0.062, y, 0.355 + z), "brass", seg=8, tseg=4, detail=True)
        # échappements de cuivre
        K.pipe([(s * 0.09, y, 0.4), (s * 0.14, y, 0.41), (s * 0.17, y - 0.04, 0.38)], 0.009, "copper", seg=5, round_=0.02)
# le réservoir de laiton en travers, devant le moteur ; la magnéto
K.lathe([(0, -0.11), (0.035, -0.1), (0.04, -0.08), (0.04, 0.08), (0.035, 0.1), (0, 0.11)], (0, EY + 0.14, 0.32), "brass", seg=10, axis="x")
for x in (-0.06, 0.06):
    K.torus(0.041, 0.005, (x, EY + 0.14, 0.32), "iron", seg=10, tseg=4, axis="x", detail=True)
K.cyl(0.012, 0.014, (0, EY + 0.14, 0.355), "brass", seg=6)
for s in (1, -1):
    K.box(0.02, 0.05, 0.05, (s * 0.07, EY + 0.14, 0.275), "iron")
K.box(0.05, 0.05, 0.05, (0, EY - 0.13, 0.275), "armor_d")

# ------------------------------------------------------- la cage de l'hélice
PC = (0.0, -0.45, 0.47)
for dy, R in ((0.035, 0.205), (-0.045, 0.19)):
    K.torus(R, 0.011, (PC[0], PC[1] + dy, PC[2]), "brass", seg=18, tseg=4, axis="y")
for i in range(8):
    a = 2 * PI * i / 8
    K.pipe([(0.205 * math.cos(a), PC[1] + 0.035, PC[2] + 0.205 * math.sin(a)), (0.19 * math.cos(a), PC[1] - 0.045, PC[2] + 0.19 * math.sin(a))], 0.005, "iron", seg=3)
for i in range(4):
    a = PI * i / 4
    K.box(0.38, 0.006, 0.006, (PC[0], PC[1] - 0.045, PC[2]), "iron", rot=(0, a, 0), center=True)
for s in (1, -1):
    K.pipe([(s * 0.17, -0.4, 0.26), (s * 0.16, PC[1] + 0.035, 0.345)], 0.012, "iron", seg=4)
K.pipe([(0, EY - 0.06, 0.34), (0, PC[1] + 0.06, PC[2] - 0.01)], 0.016, "iron", seg=5)
K.lathe([(0.03, 0), (0.03, 0.07), (0.02, 0.08), (0, 0.08)], (0, PC[1] + 0.085, PC[2]), "iron", seg=8, axis="-y")

# ------------------------------------------------------------------ l'hélice
K.use("rotor0")
RP = (PC[0], PC[1] + 0.012, PC[2])
for s in (1, -1):
    K.box(0.05, 0.014, 0.175, (RP[0], RP[1], RP[2] + s * 0.005), "wood_l", rot=(0, 0, 0.35 * s) if s > 0 else (PI, 0, -0.35), top=(0.03, 0.01))
K.lathe([(0.032, 0), (0.032, 0.012), (0.02, 0.035), (0, 0.05)], RP, "brass", seg=8, axis="-y")
K.lathe([(0.036, 0), (0.036, 0.01), (0, 0.012)], RP, "brass", seg=8, axis="y")

# ---------------------------------------------------------------- la tourelle
K.use("turret")
C = (0.0, 0.1, 0.274)
at = lambda x, y, z: (C[0] + x, C[1] + y, C[2] + z)  # noqa: E731
K.lathe([(0.135, 0.0), (0.138, 0.012), (0.134, 0.06), (0.118, 0.08), (0.08, 0.088), (0, 0.09)], C, "armor", seg=14)
K.rivet_ring(at(0, 0, 0.01), 0.1385, 22, radial=True, r=0.006)
K.lathe([(0.118, 0.079), (0.118, 0.092), (0.09, 0.1), (0.09, 0.088)], C, "brass", seg=14, closed=True, detail=True)
K.lathe([(0.075, 0.089), (0.075, 0.1), (0.045, 0.106), (0, 0.108)], C, "team", seg=12)
# le masque, puis la lance : trois isolateurs de porcelaine, la tige, ses bobines, l'éclateur et l'étincelle
LZ = 0.05
K.box(0.11, 0.09, 0.085, at(0, 0.115, 0.008), "armor_d", top=(0.09, 0.06), shift=(0, -0.01))
for k in range(3):
    K.lathe([(0.02, 0), (0.042, 0.004), (0.042, 0.012), (0.02, 0.024)], at(0, 0.16 + k * 0.026, LZ), "enamel", seg=10, axis="y")
K.cyl(0.016, 0.38, at(0, 0.24, LZ), "gun", seg=6, axis="y")
for k in range(5):
    K.torus(0.034, 0.012, at(0, 0.27 + k * 0.062, LZ), "copper" if k % 2 else "brass", seg=10, tseg=5, axis="y")
K.lathe([(0.016, 0), (0.026, 0.01), (0.026, 0.022), (0.012, 0.035), (0.012, 0.05)], at(0, 0.6, LZ), "brass", seg=8, axis="y")
K.sphere(0.032, at(0, 0.668, LZ), "spark", seg=8, rings=5)
# deux bouteilles de Leyde sur la nuque, leurs fils de cuivre jusqu'à la lance
for s in (1, -1):
    J = at(s * 0.07, -0.075, 0.085)
    K.lathe([(0.028, 0), (0.028, 0.006), (0.025, 0.012), (0.025, 0.07), (0.016, 0.082), (0.016, 0.09)], J, "jar", seg=8)
    K.lathe([(0.027, 0.02), (0.027, 0.045), (0.0255, 0.045), (0.0255, 0.02)], J, "brass", seg=8, closed=True, detail=True)
    K.lathe([(0.018, 0.09), (0.018, 0.098), (0.006, 0.102), (0.006, 0.115), (0, 0.116)], J, "brass", seg=6)
    K.sphere(0.011, (J[0], J[1], J[2] + 0.122), "brass", seg=6, rings=4)
    K.pipe([(J[0], J[1], J[2] + 0.122), (J[0] * 0.6, J[1] + 0.09, J[2] + 0.1), (s * 0.03, C[1] + 0.2, C[2] + LZ + 0.03)], 0.005, "copper", seg=4, round_=0.03)
K.box(0.2, 0.07, 0.012, at(0, -0.075, 0.075), "wood")

finish(K, "hydroglisseur", {"turret": C, "rotor0": RP})
print("[hydroglisseur] pivot", C, "hélice", RP, "bouche", (0, 0.668, LZ))
