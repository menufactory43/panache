"""Le Fourgon Jeantaud (l'ouvrier de la République) : un fourgon de livraison électrique.

Caisse ivoire capitonnée à filets noirs et glaces biseautées, le cocher sur sa banquette à boutons, un
toit aux couleurs du camp sous sa galerie nickelée, les coffres d'accumulateurs de cuivre sur le plateau
arrière, des lanternes de voiture, et une perche de trolley sur isolateurs dont le frotteur crépite.
`cargo` : le charbon et le radium sur le plateau.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, start  # noqa: E402
from kit import frame, xf  # noqa: E402
from rep import REP, carriage_lamp, coal, driver, insulator, wire_wheel  # noqa: E402

K = start(REP)
K.use("hull")

# ---------------------------------------------------------------- le châssis
for s in (1, -1):
    K.box(0.04, 0.88, 0.05, (s * 0.12, -0.02, 0.135), "laque")
    wire_wheel(K, (s * 0.215, 0.28, 0.1), 0.1, 0.045, side=s, n=10)
    wire_wheel(K, (s * 0.225, -0.25, 0.13), 0.13, 0.05, side=s, n=12)
    # ressorts à lames, garde-boue de laque qui enveloppent les roues, le marchepied nickelé
    for y, z in ((0.28, 0.125), (-0.25, 0.15)):
        K.strip_x([(y - 0.1, z + 0.03), (y - 0.04, z), (y + 0.04, z), (y + 0.1, z + 0.03)], s * 0.1, s * 0.14, 0.012, "nickel_d")
    for y, r, z in ((0.28, 0.1, 0.1), (-0.25, 0.13, 0.13)):
        arc = [(y + (r + 0.03) * math.cos(a), z + (r + 0.03) * math.sin(a)) for a in [PI * (0.95 - 0.9 * i / 7) for i in range(8)]]
        K.strip_x(arc, s * 0.175, s * 0.26, 0.011, "laque")
        K.strip_x([(a, b + 0.002) for a, b in arc], s * 0.252, s * 0.265, 0.011, "nickel", detail=True)
    K.box(0.075, 0.3, 0.012, (s * 0.21, 0.02, 0.165), "nickel_d")
    K.rivets((s * 0.24, -0.1, 0.177), (s * 0.24, 0.14, 0.177), 6, r=0.005, mat="nickel")
for y, z in ((0.28, 0.1), (-0.25, 0.13)):
    K.cyl(0.012, 0.44, (-0.22, y, z), "nickel_d", seg=6, axis="x")

# ----------------------------------------------- le tablier et le siège du cocher
K.box(0.32, 0.12, 0.125, (0, 0.37, 0.16), "ivoire", top=(0.3, 0.09), shift=(0, -0.01))
K.box(0.33, 0.014, 0.014, (0, 0.415, 0.278), "nickel")
K.box(0.3, 0.1, 0.008, (0, 0.36, 0.284), "laque", detail=True)
K.pipe([(0.05, 0.33, 0.25), (0.05, 0.29, 0.335)], 0.006, "nickel", seg=4)
K.torus(0.032, 0.006, (0.05, 0.285, 0.34), "laque", seg=10, tseg=4, axis="y", scale=(1, 1, 1))
K.box(0.32, 0.11, 0.05, (0, 0.22, 0.235), "leather", top=(0.31, 0.1))
K.box(0.32, 0.03, 0.11, (0, 0.165, 0.26), "leather", top=(0.31, 0.02))
for x in (-0.12, -0.04, 0.12):
    for z in (0.3, 0.34):
        K.rivet((x, 0.181, z), (0, 1, 0), 0.007)
driver(K, (0.05, 0.23, 0.345), "laque", "team")
for s in (1, -1):
    K.box(0.03, 0.012, 0.012, (s * 0.167, 0.4, 0.262), "nickel")
    carriage_lamp(K, (s * 0.188, 0.42, 0.275), 0.034)
    K.cyl(0.008, 0.215, (s * 0.19, 0.44, 0.275), "nickel", seg=5)

# -------------------------------------------------------------------- la caisse
K.box(0.36, 0.4, 0.3, (0, -0.06, 0.19), "ivoire")
K.box(0.366, 0.406, 0.034, (0, -0.06, 0.2), "ivoire_d", detail=True)
for s in (1, -1):
    with K.on(frame((s * 0.1805, -0.06, 0.34), (s, 0, 0))):
        # la glace biseautée dans son cadre de nickel, ses montants
        u0 = -s * 0.02
        K.box(0.25, 0.11, 0.005, (u0, 0.06, 0), "verre", detail=True)
        for v in (0.0, 0.12):
            K.box(0.27, 0.012, 0.008, (u0, v, 0), "nickel", detail=True)
        for u in (-0.13, 0.0, 0.13):
            K.box(0.012, 0.12, 0.008, (u0 + u, 0.06, 0), "nickel", detail=True)
        # les filets noirs du panneau bas, le médaillon aux couleurs du camp
        K.box(0.36, 0.006, 0.004, (0, -0.02, 0), "laque", detail=True)
        K.box(0.32, 0.005, 0.004, (0, -0.105, 0), "laque", detail=True)
        for u in (-0.16, 0.16):
            K.box(0.005, 0.085, 0.004, (u, -0.062, 0), "laque", detail=True)
        K.lathe([(0.03, 0), (0.03, 0.006), (0.024, 0.008), (0.024, 0)], (0, -0.065, 0), "brass", seg=12, closed=True, detail=True)
        K.lathe([(0.024, 0.006), (0, 0.008)], (0, -0.065, 0), "team", seg=12, detail=True)
with K.on(frame((0, 0.1405, 0.4), (0, 1, 0))):
    K.box(0.24, 0.11, 0.005, (0, 0, 0), "verre", detail=True)
    for v in (-0.06, 0.06):
        K.box(0.26, 0.012, 0.008, (0, v, 0), "nickel", detail=True)
with K.on(frame((0, -0.2605, 0.34), (0, -1, 0))):
    K.box(0.005, 0.25, 0.004, (0, 0, 0), "laque", detail=True)
    for u in (-0.17, 0.17):
        K.box(0.005, 0.25, 0.004, (u, 0, 0), "laque", detail=True)
    for u in (-0.025, 0.025):
        K.box(0.01, 0.04, 0.012, (u, 0, 0), "brass", detail=True)
    for u in (-0.09, 0.09):
        K.box(0.1, 0.07, 0.004, (u, 0.06, 0), "verre", detail=True)

# ----------------------------------------------------------------------- le toit
def camber(y, w, z):
    return [(-w, y, z), (w, y, z), (w, y, z + 0.02), (w * 0.6, y, z + 0.05), (-w * 0.6, y, z + 0.05), (-w, y, z + 0.02)]


K.rings([camber(0.47, 0.21, 0.488), camber(-0.33, 0.21, 0.488)], "team")
K.box(0.43, 0.81, 0.012, (0, 0.07, 0.478), "nickel")
K.box(0.016, 0.74, 0.008, (0, 0.07, 0.538), "nickel", detail=True)
for s in (1, -1):
    K.pipe([(s * 0.195, 0.45, 0.556), (s * 0.195, -0.31, 0.556)], 0.005, "nickel", seg=4)
    for y in (0.43, 0.2, -0.06, -0.29):
        K.cyl(0.004, 0.05, (s * 0.195, y, 0.508), "nickel", seg=4)
    K.rivets((s * 0.15, 0.42, 0.53), (s * 0.15, -0.28, 0.53), 9, r=0.005, n=(s * 0.3, 0, 1), mat="nickel")
for y in (0.45, -0.31):
    K.pipe([(-0.195, y, 0.556), (0.195, y, 0.556)], 0.005, "nickel", seg=4)
# la perche de trolley, penchée vers l'arrière sur son isolateur, le frotteur qui crépite
TP = (0.08, -0.12, 0.538)
K.lathe([(0.04, 0), (0.04, 0.012), (0.03, 0.03), (0.02, 0.03)], TP, "laque", seg=8)
insulator(K, (TP[0], TP[1], TP[2] + 0.03), 0.024)
K.pipe([(0.08, -0.12, 0.61), (0.08, -0.42, 0.86)], 0.009, "nickel", seg=5)
K.pipe([(0.08, -0.135, 0.625), (0.08, -0.175, 0.658)], 0.016, "copper", seg=6)
K.box(0.05, 0.03, 0.02, (0.08, -0.425, 0.855), "nickel_d")
K.sphere(0.022, (0.08, -0.43, 0.885), "spark", seg=8, rings=5)
K.sphere(0.012, (0.105, -0.41, 0.905), "arc", seg=6, rings=4)

# ------------------------------------------- le plateau arrière et ses accumulateurs
K.box(0.38, 0.2, 0.03, (0, -0.36, 0.195), "laque")
for s in (1, -1):
    K.box(0.1, 0.18, 0.12, (s * 0.13, -0.36, 0.225), "copper", top=(0.095, 0.17))
    for y in (-0.31, -0.36, -0.41):
        K.box(0.104, 0.006, 0.124, (s * 0.13, y, 0.225), "laque", detail=True)
    for y in (-0.31, -0.41):
        K.cyl(0.01, 0.022, (s * 0.13, y, 0.345), "brass", seg=6)
    K.box(0.07, 0.05, 0.03, (s * 0.13, -0.36, 0.345), "verre")
    K.pipe([(s * 0.13, -0.31, 0.365), (s * 0.15, -0.27, 0.42), (s * 0.15, -0.262, 0.44)], 0.005, "laque", seg=4)
    K.rivets((s * 0.182, -0.44, 0.24), (s * 0.182, -0.28, 0.24), 5, n=(s, 0, 0), r=0.005)
carriage_lamp(K, (0.17, -0.47, 0.25), 0.024, axis="-y")

K.use("cargo")
coal(K, [(-0.03, -0.3, 0.04, 0.055), (0.035, -0.42, 0.035, 0.055), (-0.035, -0.41, 0.035, 0.06), (0.01, -0.36, 0.045, 0.085),
         (0.03, -0.31, 0.03, 0.065), (-0.02, -0.36, 0.03, 0.115), (0.0, -0.44, 0.03, 0.055)],
     [(0.03, -0.34, 0.02), (-0.03, -0.39, 0.018), (0.0, -0.31, 0.015)], 0.225)

finish(K, "fourgon")
