"""Le Canon de 75 (Mortar) : une lourde pièce de campagne sur son affût.

Deux hautes roues d'artillerie sur un essieu de fer, coffres d'essieu aux couleurs du camp, flèche à
bêche, caisson à obus ; la pièce (la « tourelle ») pivote dessus : bouclier de couleur riveté, berceau,
frein de recul et long tube pointé haut.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, start, wheel  # noqa: E402
from kit import frame, xf  # noqa: E402

K = start()
K.use("hull")
R, WX, AY = 0.19, 0.285, 0.06  # les roues, l'essieu

# ------------------------------------------------------------------ l'affût
K.cyl(0.026, 0.6, (-0.3, AY, R), "iron", seg=8, axis="x")
for s in (1, -1):
    wheel(K, (s * WX, AY, R), R, 0.065, side=s, spokes=12, felloe="wood", seg=16)
    # coffres d'essieu aux couleurs du camp, cerclés de laiton, et le siège du servant dessus
    K.box(0.11, 0.14, 0.085, (s * 0.165, AY, 0.2), "team", top=(0.1, 0.13))
    for y in (AY - 0.045, AY + 0.045):
        K.box(0.114, 0.014, 0.088, (s * 0.165, y, 0.2), "brass", detail=True)
    K.box(0.02, 0.03, 0.014, (s * 0.165, AY - 0.072, 0.245), "brass", detail=True)
    K.strip_x([(AY - 0.14, 0.3), (AY - 0.1, 0.29), (AY - 0.04, 0.29), (AY - 0.01, 0.345)], s * 0.12, s * 0.21, 0.01, "iron")
    for u in (-0.03, 0.0, 0.03):
        K.rivets((s * 0.165 + u, AY - 0.09, 0.3), (s * 0.165 + u, AY - 0.045, 0.3), 3, r=0.0045, mat="soot")
# la flèche : deux longerons de fer rivetés qui descendent vers la bêche, leurs entretoises
for s in (1, -1):
    for (y0, z0, x0), (y1, z1, x1) in (((AY - 0.02, 0.2, 0.08), (-0.25, 0.14, 0.055)), ((-0.25, 0.14, 0.055), (-0.52, 0.06, 0.04))):
        K.rings([[(s * x0 - 0.016, y0, z0 - 0.028), (s * x0 + 0.016, y0, z0 - 0.028), (s * x0 + 0.016, y0, z0 + 0.028), (s * x0 - 0.016, y0, z0 + 0.028)],
                 [(s * x1 - 0.016, y1, z1 - 0.028), (s * x1 + 0.016, y1, z1 - 0.028), (s * x1 + 0.016, y1, z1 + 0.028), (s * x1 - 0.016, y1, z1 + 0.028)]], "armor_d")
        for k in range(5):
            f = (k + 0.5) / 5
            K.rivet((s * (x0 + (x1 - x0) * f + 0.016), y0 + (y1 - y0) * f, z0 + (z1 - z0) * f), (s, 0, 0), 0.006)
            K.rivet((s * (x0 + (x1 - x0) * f), y0 + (y1 - y0) * f, z0 + (z1 - z0) * f + 0.028), (0, 0.25, 1), 0.006)
for y, z, w in ((-0.14, 0.168, 0.15), (-0.38, 0.105, 0.11)):
    K.box(w, 0.03, 0.04, (0, y, z - 0.02), "iron")
# la bêche et l'anneau d'attelage
K.box(0.24, 0.022, 0.13, (0, -0.535, 0.0), "iron", rot=(-0.35, 0, 0), top=(0.2, 0.022))
K.box(0.25, 0.012, 0.03, (0, -0.512, 0.115), "brass", rot=(-0.35, 0, 0), detail=True)
K.torus(0.03, 0.009, (0, -0.585, 0.09), "iron", seg=8, tseg=4)
K.box(0.02, 0.06, 0.02, (0, -0.55, 0.08), "iron")
# le caisson à obus sur la flèche, couvercle ouvert sur trois obus de laiton
K.box(0.2, 0.13, 0.09, (0, -0.24, 0.165), "team", top=(0.19, 0.12))
for x in (-0.07, 0.07):
    K.box(0.014, 0.134, 0.094, (x, -0.24, 0.165), "brass", detail=True)
K.box(0.16, 0.09, 0.004, (0, -0.24, 0.255), "soot", detail=True)
for x in (-0.05, 0.0, 0.05):
    K.lathe([(0.02, 0), (0.02, 0.03), (0.017, 0.05), (0.008, 0.066), (0, 0.07)], (x, -0.24, 0.24), "brass", seg=8)
K.box(0.2, 0.012, 0.125, (0, -0.31, 0.25), "team", rot=(-0.5, 0, 0))
# le pivot : un tambour riveté sur l'essieu, sa couronne dentée de laiton
PIV = (0.0, AY, 0.25)
K.lathe([(0.12, 0), (0.12, 0.05), (0.105, 0.075), (0.06, 0.075)], (0, AY, 0.175), "armor", seg=14)
K.rivet_ring((0, AY, 0.2), 0.121, 18, r=0.006, radial=True)
K.torus(0.112, 0.01, (0, AY, 0.228), "brass", seg=14, tseg=5, detail=True)

# ---------------------------------------------------------------- la pièce
K.use("turret")
at = lambda x, y, z: (PIV[0] + x, PIV[1] + y, PIV[2] + z)  # noqa: E731
PITCH = 0.9
K.lathe([(0.085, 0), (0.085, 0.02), (0.06, 0.03), (0, 0.03)], at(0, 0, 0), "iron", seg=12)
# le berceau : deux flasques rivetés, les tourillons de laiton
for s in (1, -1):
    K.rings([[(s * 0.062 - 0.014, y, z) for y, z in ((-0.1, 0.02), (0.1, 0.02), (0.07, 0.17), (-0.03, 0.2))],
             [(s * 0.062 + 0.014, y, z) for y, z in ((-0.1, 0.02), (0.1, 0.02), (0.07, 0.17), (-0.03, 0.2))]], "armor", at=at(0, 0, 0))
    K.lathe([(0.03, 0), (0.03, 0.012), (0.018, 0.02), (0, 0.021)], at(s * 0.076, 0.01, 0.14), "brass", seg=8, axis="x" if s > 0 else "-x")
    K.rivets(at(s * 0.077, -0.08, 0.04), at(s * 0.077, 0.08, 0.04), 5, n=(s, 0, 0), r=0.006)
# le volant de pointage et son secteur denté
K.torus(0.04, 0.007, at(0.105, -0.02, 0.1), "brass", seg=10, tseg=4, axis="x")
K.cyl(0.006, 0.03, at(0.076, -0.02, 0.1), "gun", seg=5, axis="x")
# le bouclier : deux volets aux couleurs du camp de part et d'autre du tube, inclinés, ourlés de laiton
RAKE = 0.3
for s in (1, -1):
    with K.on(xf(at(s * 0.15, 0.13, 0.03), (RAKE, 0, 0))):
        K.box(0.21, 0.022, 0.36, (0, 0, 0), "team", top=(0.19, 0.022), shift=(-s * 0.01, 0))
        K.box(0.2, 0.026, 0.02, (-s * 0.005, 0, 0.345), "brass", detail=True)
        K.box(0.016, 0.026, 0.33, (s * 0.098, 0, 0.01), "brass", detail=True)
        for x in (-0.08, 0.075):
            K.rivets((x, 0.011, 0.03), (x * 0.95, 0.011, 0.32), 6, n=(0, 1, 0), r=0.007)
        # la lucarne de visée du pointeur
        if s < 0:
            K.box(0.06, 0.026, 0.035, (0.0, 0, 0.22), "brass", detail=True)
            K.box(0.045, 0.03, 0.02, (0.0, 0, 0.227), "soot", detail=True)
with K.on(xf(at(0, 0.13, 0.03), (RAKE, 0, 0))):
    K.box(0.1, 0.02, 0.1, (0, 0, 0), "armor_d")
# le tube, pointé haut : culasse, frette de laiton, volée effilée, bourrelet de bouche ; le frein de recul dessous
G = at(0, -0.1, 0.14)
with K.on(xf(G, (PITCH, 0, 0))):
    K.lathe([(0, -0.07), (0.05, -0.065), (0.058, -0.04), (0.058, 0.05), (0.05, 0.07), (0.05, 0.16)], (0, 0, 0), "gun", seg=12, axis="y")
    K.box(0.07, 0.05, 0.02, (0, -0.03, 0.05), "gun")
    K.lathe([(0.062, 0.05), (0.062, 0.085), (0.054, 0.085), (0.054, 0.05)], (0, 0, 0), "brass", seg=12, axis="y", closed=True, detail=True)
    K.cyl(0.046, 0.4, (0, 0.16, 0), "gun", seg=12, axis="y", r1=0.036)
    K.lathe([(0.047, 0.3), (0.047, 0.32), (0.04, 0.32), (0.04, 0.3)], (0, 0, 0), "brass", seg=12, axis="y", closed=True, detail=True)
    K.lathe([(0.036, 0.56), (0.048, 0.575), (0.05, 0.62), (0.044, 0.635), (0.028, 0.635), (0.026, 0.6), (0, 0.6)], (0, 0, 0), "gun", seg=12, axis="y")
    K.lathe([(0.026, 0.601), (0, 0.601)], (0, 0, 0), "soot", seg=12, axis="y", detail=True)
    # frein de recul et récupérateur
    K.lathe([(0, 0.0), (0.03, 0.005), (0.034, 0.02), (0.034, 0.3), (0.026, 0.315), (0, 0.32)], (0, 0.02, -0.075), "armor_d", seg=10, axis="y")
    for y in (0.06, 0.28):
        K.torus(0.035, 0.007, (0, y, -0.075), "brass", seg=10, tseg=4, axis="y", detail=True)
    K.cyl(0.012, 0.12, (0, 0.33, -0.075), "gun", seg=6, axis="y")
    K.box(0.03, 0.03, 0.05, (0, 0.44, -0.07), "gun")
    # la hausse
    K.box(0.012, 0.012, 0.05, (-0.062, 0.0, 0.02), "brass")
    K.cyl(0.01, 0.05, (-0.062, -0.01, 0.075), "brass", seg=6, axis="y")
MUZZLE = (0, -0.1 + 0.635 * math.cos(PITCH), 0.14 + 0.635 * math.sin(PITCH))

finish(K, "canon75", {"turret": PIV})
print("[canon75] pivot", PIV, "bouche", MUZZLE)
