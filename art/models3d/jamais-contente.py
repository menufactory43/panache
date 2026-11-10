"""La Jamais-Contente : la voiture électrique de record de Jenatzy, en torpille, devenue coureuse légère.

Une torpille de nickel riveté sur quatre roues à rayons, sa moitié avant aux couleurs du camp, le pilote
à lunettes assis haut dedans, les bobinages de cuivre du moteur à l'essieu arrière, et sur le capot une
petite tourelle à arc : bouteilles de Leyde et deux cornes de cuivre autour d'une étincelle bleue.
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

# --------------------------------------------------------------------- la torpille
BODY = [(-0.47, 0.012, 0.2, 0.18), (-0.42, 0.045, 0.235, 0.145), (-0.36, 0.075, 0.265, 0.115), (-0.26, 0.095, 0.29, 0.1), (-0.1, 0.103, 0.3, 0.098),
        (0.02, 0.102, 0.3, 0.098), (0.12, 0.1, 0.3, 0.1), (0.28, 0.085, 0.285, 0.11), (0.38, 0.06, 0.26, 0.13), (0.47, 0.012, 0.21, 0.18)]


def hoop(z, w, top, bot, grow=0.0, n=12):
    cz, hz = (top + bot) / 2, (top - bot) / 2 + grow
    return [((w + grow) * math.cos(2 * PI * k / n), -z, cz + hz * math.sin(2 * PI * k / n)) for k in range(n)]


K.rings([hoop(*s) for s in BODY[:6]], "team")
K.rings([hoop(*s) for s in BODY[5:]], "nickel")
# le joint riveté entre la peinture et le nickel, les rivets des flancs, le filet de couleur sur la queue
K.rings([hoop(0.01, 0.102, 0.3, 0.098, grow=0.004), hoop(0.035, 0.102, 0.3, 0.098, grow=0.004)], "nickel", detail=True)
for k in range(14):
    a = PI * (-0.15 + 1.3 * k / 13)
    K.rivet((0.108 * math.cos(a), -0.022, 0.199 + 0.107 * math.sin(a)), (math.cos(a), 0, math.sin(a)), 0.006, "brass")
for s in (1, -1):
    K.rivets((s * 0.106, 0.2, 0.2), (s * 0.103, -0.02, 0.2), 6, n=(s, 0, 0), r=0.005, mat="nickel")
    K.rivets((s * 0.1, -0.08, 0.2), (s * 0.085, -0.3, 0.2), 6, n=(s, 0, 0), r=0.005, mat="brass")
K.box(0.05, 0.3, 0.008, (0, -0.22, 0.288), "team", rot=(0.08, 0, 0), detail=True)
# quatre roues à rayons sur leurs essieux nickelés, de petits garde-boue de couleur sur l'avant
for y in (0.26, -0.26):
    K.cyl(0.009, 0.34, (-0.17, y, 0.11), "nickel", seg=5, axis="x")
    for s in (1, -1):
        wire_wheel(K, (s * 0.175, y, 0.11), 0.11, 0.032, side=s, n=12)
        K.pipe([(s * 0.09, y, 0.14), (s * 0.15, y, 0.11)], 0.007, "nickel_d", seg=4)
for s in (1, -1):
    arc = [(0.26 + 0.135 * math.cos(a), 0.11 + 0.135 * math.sin(a)) for a in [PI * (0.85 - 0.7 * i / 5) for i in range(6)]]
    K.strip_x(arc, s * 0.152, s * 0.198, 0.009, "team")
# le moteur électrique à l'essieu arrière : un tambour de laque bobiné de cuivre
K.lathe([(0, -0.075), (0.04, -0.07), (0.046, -0.05), (0.046, 0.05), (0.04, 0.07), (0, 0.075)], (0, -0.26, 0.11), "laque", seg=10, axis="x")
for x in (-0.045, 0.0, 0.045):
    K.lathe([(0.05, -0.012), (0.05, 0.012), (0.044, 0.012), (0.044, -0.012)], (x, -0.26, 0.11), "copper", seg=10, axis="x", closed=True, detail=True)
# l'habitacle : un bourrelet de cuir, le pilote à lunettes, un saute-vent de verre, le volant nickelé
K.torus(0.07, 0.012, (0, -0.12, 0.296), "leather", seg=10, tseg=5, scale=(1, 1.3, 1))
driver(K, (0, -0.13, 0.275), "laque", "leather", goggles=True)
K.box(0.13, 0.006, 0.058, (0, -0.035, 0.305), "verre", rot=(0.45, 0, 0))
K.box(0.136, 0.01, 0.01, (0, -0.048, 0.355), "nickel", rot=(0.45, 0, 0))
K.torus(0.028, 0.005, (0, -0.062, 0.312), "nickel", seg=8, tseg=4, axis="y")
# un phare dans le nez, la grille d'où fuient les étincelles à la queue
carriage_lamp(K, (0, 0.455, 0.19), 0.03)
K.box(0.06, 0.07, 0.025, (0, -0.45, 0.19), "laque")
for x in (-0.02, 0.0, 0.02):
    K.box(0.008, 0.06, 0.02, (x, -0.46, 0.204), "spark")

# ---------------------------------------------------------------- la tourelle à arc
K.use("turret")
C = (0.0, 0.22, 0.3)
at = lambda x, y, z: (C[0] + x, C[1] + y, C[2] + z)  # noqa: E731
K.lathe([(0.085, -0.02), (0.085, 0.01), (0.072, 0.024), (0.04, 0.03), (0, 0.031)], C, "nickel", seg=12)
K.lathe([(0.087, -0.012), (0.087, 0.004), (0.083, 0.004), (0.083, -0.012)], C, "brass", seg=12, closed=True, detail=True)
K.rivet_ring(at(0, 0, 0.017), 0.078, 12, r=0.005, mat="brass")
for s in (1, -1):
    J = at(s * 0.042, -0.035, 0.022)
    K.lathe([(0.024, 0), (0.024, 0.06), (0.014, 0.07), (0.014, 0.076)], J, "jar", seg=8)
    K.lathe([(0.0255, 0.012), (0.0255, 0.036), (0.0235, 0.036), (0.0235, 0.012)], J, "brass", seg=8, closed=True, detail=True)
    K.sphere(0.012, (J[0], J[1], J[2] + 0.085), "brass", seg=6, rings=4)
    # la corne de cuivre, bobinée, jusqu'à sa boule de laiton
    K.pipe([at(s * 0.03, 0.02, 0.03), at(s * 0.045, 0.1, 0.06), at(s * 0.04, 0.17, 0.07)], 0.009, "copper", seg=5, round_=0.03)
    for k in (0.35, 0.7):
        K.torus(0.015, 0.005, at(s * (0.032 + 0.012 * k), 0.02 + 0.15 * k, 0.032 + 0.036 * k), "copper", seg=6, tseg=3, axis="y")
    K.sphere(0.014, at(s * 0.04, 0.17, 0.07), "brass", seg=6, rings=4)
    K.pipe([(J[0], J[1], J[2] + 0.085), at(s * 0.03, 0.02, 0.03)], 0.004, "copper", seg=3)
K.sphere(0.024, at(0, 0.17, 0.07), "spark", seg=8, rings=5)
K.box(0.07, 0.008, 0.008, at(0, 0.17, 0.07), "arc", rot=(0, 0.3, 0), center=True)

finish(K, "jamais-contente", {"turret": C})
