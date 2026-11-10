"""Le Panhard (Stinger) : une automitrailleuse de 1905.

Long capot à persiennes derrière un radiateur de laiton, phares à acétylène, caisse blindée rivetée sur
quatre roues d'artillerie, garde-boue aux couleurs du camp, roue de secours à l'arrière ; tourelle ronde
à toit de couleur et sa mitrailleuse Hotchkiss aux ailettes de laiton.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, lamp, start, wheel
from kit import frame, quad_frame, xf

K = start()
K.use("hull")
R, WX, WY = 0.125, 0.235, 0.3  # les roues

# ---------------------------------------------------------------- châssis
K.box(0.3, 0.92, 0.05, (0, 0, 0.13), "iron")
for s in (1, -1):
    K.box(0.035, 0.96, 0.045, (s * 0.135, 0, 0.115), "armor_d")
for y in (WY, -WY):
    K.cyl(0.02, 0.5, (-0.25, y, R), "iron", seg=6, axis="x")
    for s in (1, -1):
        wheel(K, (s * WX, y, R), R, 0.07, side=s, spokes=10)
        # ressort à lames
        K.strip_x([(y - 0.11, 0.2), (y - 0.05, 0.165), (y + 0.05, 0.165), (y + 0.11, 0.2)], s * 0.15, s * 0.185, 0.014, "iron")
        # le garde-boue, aux couleurs du camp : il enveloppe le haut de la roue, ourlé de laiton
        arc = [(y + (R + 0.035) * math.cos(a), R + (R + 0.035) * math.sin(a)) for a in [PI * (0.98 - 0.86 * i / 7) for i in range(8)]]
        if y > 0:
            arc = arc[:-1] + [(y - R - 0.07, R + 0.035)]
        else:
            arc = [(y + R + 0.07, R + 0.035)] + arc[1:]
        K.strip_x(arc, s * (WX - 0.055), s * (WX + 0.055), 0.012, "team")
        K.strip_x([(a, b + 0.003) for a, b in arc], s * (WX + 0.047), s * (WX + 0.06), 0.012, "brass", detail=True)
for s in (1, -1):
    # le marchepied entre les deux garde-boue, un coffre à outils dessus
    K.box(0.11, 0.26, 0.014, (s * WX, 0, 0.155), "armor_d")
    K.rivets((s * (WX + 0.04), -0.11, 0.169), (s * (WX + 0.04), 0.11, 0.169), 5, r=0.006)
K.box(0.085, 0.15, 0.06, (WX, -0.02, 0.169), "wood", top=(0.08, 0.145))
for y in (-0.06, 0.02):
    K.box(0.09, 0.014, 0.064, (WX, y, 0.169), "brass", detail=True)
# un bidon et une pelle de l'autre côté
K.lathe([(0.034, 0), (0.036, 0.01), (0.036, 0.075), (0.02, 0.088), (0.012, 0.1), (0, 0.1)], (-WX, 0.04, 0.169), "brass", seg=8)
K.box(0.012, 0.16, 0.012, (-WX - 0.03, -0.05, 0.175), "wood_l")
K.box(0.045, 0.05, 0.008, (-WX - 0.03, -0.145, 0.172), "iron")

# ------------------------------------------------------------------ capot
# (section en pan coupé, effilée vers le radiateur)
def hood(y, w, h):
    return [(-w, y, 0.18), (w, y, 0.18), (w, y, 0.18 + h * 0.62), (w * 0.62, y, 0.18 + h), (-w * 0.62, y, 0.18 + h), (-w, y, 0.18 + h * 0.62)]


K.rings([hood(0.1, 0.15, 0.175), hood(0.455, 0.118, 0.155)], "armor")
for s in (1, -1):
    with K.on(quad_frame((s * 0.15, 0.1, 0.18), (s * 0.118, 0.455, 0.18), (s * 0.118, 0.455, 0.276), (s * 0.15, 0.1, 0.288)) if s > 0 else
              quad_frame((s * 0.118, 0.455, 0.18), (s * 0.15, 0.1, 0.18), (s * 0.15, 0.1, 0.288), (s * 0.118, 0.455, 0.276))):
        # les persiennes
        for u in (-0.11, -0.07, -0.03, 0.01, 0.05, 0.09):
            K.box(0.022, 0.07, 0.008, (u, 0, 0), "armor", detail=True, rot=(0, 0.5, 0))
            K.box(0.01, 0.062, 0.003, (u + 0.012, 0, 0), "soot", detail=True)
        K.rivets((-0.15, 0.045, 0), (0.14, 0.045, 0), 8, r=0.0055)
        K.rivets((-0.15, -0.045, 0), (0.14, -0.045, 0), 8, r=0.0055)
# la charnière de laiton sur l'arête du capot, deux sangles de cuir
K.box(0.016, 0.37, 0.008, (0, 0.28, 0.345), "brass", rot=(-0.056, 0, 0), detail=True)
for y in (0.19, 0.37):
    hgt = 0.355 - (y - 0.1) * 0.056
    K.box(0.2, 0.022, 0.007, (0, y, hgt - 0.004), "leather", detail=True)
    for s in (1, -1):
        K.box(0.03, 0.026, 0.01, (s * 0.06, y, hgt - 0.004), "brass", detail=True)
# le radiateur : cadre de laiton, faisceau sombre, bouchon
K.box(0.26, 0.04, 0.2, (0, 0.475, 0.165), "brass", top=(0.2, 0.04))
with K.on(frame((0, 0.4955, 0.262), (0, 1, 0))):
    K.box(0.19, 0.15, 0.006, (0, 0, 0), "soot", detail=True)
    for u in (-0.075, -0.045, -0.015, 0.015, 0.045, 0.075):
        K.box(0.008, 0.15, 0.011, (u, 0, 0), "brass", detail=True)
    K.box(0.2, 0.012, 0.012, (0, 0, 0), "brass", detail=True)
K.lathe([(0.022, 0), (0.022, 0.012), (0.03, 0.016), (0.03, 0.028), (0.012, 0.036), (0, 0.037)], (0, 0.475, 0.365), "brass", seg=8)
# phares sur leurs pattes, manivelle
for s in (1, -1):
    K.box(0.014, 0.02, 0.09, (s * 0.165, 0.455, 0.2), "iron")
    lamp(K, (s * 0.165, 0.47, 0.32), 0.04)
K.pipe([(0, 0.49, 0.15), (0, 0.54, 0.15), (0.05, 0.54, 0.15), (0.05, 0.57, 0.15)], 0.008, "iron", seg=5)
K.box(0.36, 0.022, 0.03, (0, 0.5, 0.115), "iron")

# ------------------------------------------------------- caisse blindée
B = [(-0.2, -0.43), (0.2, -0.43), (0.2, 0.06), (0.15, 0.13), (-0.15, 0.13), (-0.2, 0.06)]
T = [(-0.165, -0.38), (0.165, -0.38), (0.165, -0.02), (0.12, 0.02), (-0.12, 0.02), (-0.165, -0.02)]
Z0, Z1 = 0.17, 0.4
K.prism(B, Z0, Z1, "armor", top=T)


def side(i, j):
    return quad_frame((*B[i], Z0), (*B[j], Z0), (*T[j], Z1), (*T[i], Z1))


for s, (i, j) in ((1, (1, 2)), (-1, (5, 0))):
    with K.on(side(i, j)):
        # la plaque rapportée et ses rivets, la portière, une fente de vision, une lanterne
        K.box(0.4, 0.17, 0.005, (0, 0, 0), "armor", detail=True)
        for v in (-0.07, 0.07):
            K.rivets((-0.185, v, 0.005), (0.185, v, 0.005), 11, r=0.006)
        for u in (-0.185, 0.185):
            K.rivets((u, -0.045, 0.005), (u, 0.045, 0.005), 3, r=0.006)
        K.box(0.15, 0.13, 0.004, (-s * 0.06, -0.005, 0.005), "armor_d", detail=True)
        K.box(0.02, 0.008, 0.012, (-s * 0.115, -0.02, 0.008), "brass", detail=True)
        K.box(0.09, 0.03, 0.006, (s * 0.1, 0.035, 0.005), "brass", detail=True)
        K.box(0.07, 0.012, 0.009, (s * 0.1, 0.035, 0.005), "soot", detail=True)
# le glacis vers le capot : la fente du conducteur, éclairée
with K.on(side(3, 4)):
    K.box(0.2, 0.07, 0.006, (0, 0.03, 0), "armor_d", detail=True)
    K.box(0.13, 0.016, 0.009, (0, 0.035, 0), "amber", detail=True)
    K.rivets((-0.11, -0.06, 0), (0.11, -0.06, 0), 6, r=0.006)
    for u in (-0.085, 0.085):
        K.rivets((u, 0.01, 0.006), (u, 0.055, 0.006), 2, r=0.006)
for i, j in ((2, 3), (4, 5)):
    with K.on(side(i, j)):
        K.rivets((-0.03, -0.08, 0), (-0.03, 0.08, 0), 5, r=0.006)
        K.rivets((0.03, -0.08, 0), (0.03, 0.08, 0), 5, r=0.006)
# l'arrière : la roue de secours sanglée, deux lanternes rouges
with K.on(side(0, 1)):
    K.rivets((-0.16, 0.085, 0), (0.16, 0.085, 0), 9, r=0.006)
    K.rivets((-0.17, -0.085, 0), (0.17, -0.085, 0), 9, r=0.006)
with K.on(xf((0, -0.435, 0.29), (0.15, 0, PI / 2))):
    wheel(K, (0.0, 0, 0), 0.105, 0.05, side=-1, spokes=8, seg=12)
for s in (1, -1):
    K.box(0.03, 0.025, 0.04, (s * 0.17, -0.43, 0.2), "brass")
    K.box(0.02, 0.006, 0.024, (s * 0.17, -0.444, 0.208), "fire", detail=True)
# le toit : rivets en bordure, l'anneau de la tourelle
for a, b in zip(T, T[1:] + T[:1]):
    ax_, ay_, bx_, by_ = a[0] * 0.92, a[1] * 0.94 - 0.012, b[0] * 0.92, b[1] * 0.94 - 0.012
    K.rivets((ax_, ay_, Z1), (bx_, by_, Z1), max(2, int(math.hypot(bx_ - ax_, by_ - ay_) / 0.038)), r=0.006)
TC = (0.0, -0.17)
K.lathe([(0.158, 0), (0.158, 0.012), (0.146, 0.02), (0.11, 0.02)], (*TC, Z1), "iron", seg=16)

# ---------------------------------------------------------------- tourelle
K.use("turret")
C = (TC[0], TC[1], Z1 + 0.012)
at = lambda x, y, z: (C[0] + x, C[1] + y, C[2] + z)  # noqa: E731
K.lathe([(0.14, 0.0), (0.144, 0.012), (0.141, 0.085), (0.13, 0.108), (0.105, 0.124), (0.06, 0.132), (0.0, 0.135)], C, "armor", seg=16)
K.rivet_ring(at(0, 0, 0.01), 0.1445, 26, radial=True)
K.rivet_ring(at(0, 0, 0.1), 0.133, 22, r=0.006, radial=True)
# le toit de couleur, deux plaques de couleur sur les flancs, la trappe de laiton
K.lathe([(0.128, 0.109), (0.13, 0.117), (0.105, 0.131), (0.045, 0.1395), (0.045, 0.132), (0.105, 0.124)], C, "team", seg=16, closed=True, detail=True)
for a in (0.0, PI):
    K.lathe([(0.141, 0.025), (0.149, 0.028), (0.148, 0.08), (0.141, 0.083)], C, "team", seg=5, hs=10, arc=(a - 0.5, a + 0.5), closed=True, detail=True)
    for da in (-0.42, 0.42):
        for z in (0.036, 0.072):
            K.rivet(at(0.1485 * math.cos(a + da), 0.1485 * math.sin(a + da), z), (math.cos(a + da), math.sin(a + da), 0), 0.0055)
K.lathe([(0.05, 0), (0.05, 0.016), (0.042, 0.026), (0.02, 0.032), (0, 0.033)], at(0.03, -0.045, 0.126), "brass", seg=10)
K.box(0.012, 0.04, 0.01, at(0.03, -0.045, 0.158), "gun")
# le masque et la Hotchkiss : boîte de culasse, manchon à ailettes de laiton, canon, cache-flamme
K.box(0.11, 0.07, 0.09, at(0, 0.13, 0.02), "armor_d", top=(0.09, 0.045), shift=(0, -0.008))
K.rivets(at(-0.045, 0.167, 0.03), at(-0.038, 0.158, 0.1), 3, n=(-0.3, 0.9, 0.3), r=0.0055)
K.rivets(at(0.045, 0.167, 0.03), at(0.038, 0.158, 0.1), 3, n=(0.3, 0.9, 0.3), r=0.0055)
GZ = 0.066
K.box(0.045, 0.1, 0.05, at(0, 0.19, GZ - 0.025), "gun")
K.cyl(0.027, 0.17, at(0, 0.22, GZ), "brass", seg=8, axis="y")
for k in range(7):
    K.lathe([(0.036, 0), (0.036, 0.008), (0.027, 0.008), (0.027, 0)], at(0, 0.232 + k * 0.022, GZ), "brass", seg=8, axis="y", closed=True, detail=True)
K.cyl(0.015, 0.16, at(0, 0.39, GZ), "gun", seg=6, axis="y", r1=0.013)
K.lathe([(0.013, 0), (0.024, 0.012), (0.026, 0.045), (0.017, 0.045), (0.015, 0.02), (0, 0.02)], at(0, 0.54, GZ), "gun", seg=8, axis="y")
# la bande de cartouches (laiton) qui sort de la culasse, un projecteur
K.box(0.06, 0.03, 0.012, at(0.05, 0.2, GZ - 0.005), "brass", rot=(0, 0.5, 0))
K.box(0.016, 0.025, 0.04, at(-0.085, 0.05, 0.118), "gun")
lamp(K, at(-0.085, 0.06, 0.178), 0.03)

finish(K, "panhard", {"turret": C})
print("[panhard] pivot", C, "bouche", (0, 0.585, GZ))
