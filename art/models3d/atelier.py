"""L'Atelier roulant : une locomobile de route qui porte un atelier.

Chaudière verticale cerclée et haute cheminée à l'avant, l'atelier sous un toit riveté aux couleurs du
camp et son lanterneau, des fenêtres qui rougeoient, l'établi à l'arrière avec enclume, étau et forge
allumée, coffres à outils, et une grue en treillis (la pièce tournante) qui balance lentement sa flèche,
un chalumeau crachant au crochet.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, start  # noqa: E402
from emp import EMP, boiler, e_lamp, e_stack, iron_wheel, rivets_e  # noqa: E402
from kit import frame, xf  # noqa: E402

K = start(EMP)
K.use("hull")

# ------------------------------------------------------------------------ le châssis
K.box(0.36, 0.88, 0.05, (0, 0, 0.135), "fer")
for s in (1, -1):
    rivets_e(K, (s * 0.181, 0.4, 0.16), (s * 0.181, -0.4, 0.16), 10, (s, 0, 0))
    iron_wheel(K, (s * 0.21, 0.3, 0.1), 0.1, 0.06, side=s, n=8)
    iron_wheel(K, (s * 0.25, -0.27, 0.15), 0.15, 0.07, side=s, n=10, seg=14)
    arc = [(-0.27 + 0.18 * math.cos(a), 0.15 + 0.18 * math.sin(a)) for a in [PI * (0.85 - 0.7 * i / 6) for i in range(7)]]
    K.strip_x(arc, s * 0.205, s * 0.295, 0.01, "fer_m")
    # coffres à outils de chêne sur les marchepieds
    K.box(0.055, 0.18, 0.055, (s * 0.215, 0.06, 0.185), "wood", top=(0.05, 0.175))
    for y in (0.0, 0.12):
        K.box(0.059, 0.012, 0.058, (s * 0.215, y, 0.185), "laiton_t", detail=True)
    e_lamp(K, (s * 0.15, 0.42, 0.24), 0.036)
# la chaudière, sa cheminée, un sifflet de laiton
boiler(K, (0, 0.3, 0.18), 0.11, 0.3, face=(0, 1))
e_stack(K, (0, 0.3, 0.5), 0.035, 0.3)
K.lathe([(0.008, 0), (0.012, 0.03), (0.016, 0.034), (0.016, 0.05), (0, 0.056)], (0.07, 0.28, 0.48), "laiton_t", seg=6)
K.pipe([(0.06, 0.24, 0.4), (0.1, 0.18, 0.4), (0.1, 0.14, 0.36)], 0.01, "laiton_t", seg=4, round_=0.03)

# ------------------------------------------------------------------------- l'atelier
K.box(0.4, 0.42, 0.25, (0, -0.07, 0.185), "fer_m", top=(0.39, 0.41))
for s in (1, -1):
    with K.on(frame((s * 0.2, -0.07, 0.31), (s, 0, 0))):
        for u in (-0.07, 0.07):
            K.box(0.09, 0.07, 0.005, (u, 0.03, 0), "fire", detail=True)
            K.box(0.1, 0.012, 0.008, (u, 0.07, 0), "fer", detail=True)
            K.box(0.1, 0.012, 0.008, (u, -0.01, 0), "fer", detail=True)
            K.box(0.008, 0.08, 0.008, (u, 0.03, 0), "soot", detail=True)
        K.box(0.36, 0.2, 0.004, (0, 0.0, 0), "fer_m", detail=True)
        K.rivets((-0.17, -0.085, 0.004), (0.17, -0.085, 0.004), 10, r=0.006, mat="rivet_e")
        K.rivets((-0.17, 0.1, 0.004), (0.17, 0.1, 0.004), 10, r=0.006, mat="rivet_e")
# le toit à deux pentes aux couleurs du camp, débordant, riveté ; le lanterneau sur le faîte
for s in (1, -1):
    with K.on(xf((s * 0.118, -0.06, 0.462), (0, s * 0.22, 0))):
        K.box(0.27, 0.54, 0.03, (0, 0, -0.015), "team", top=(0.265, 0.535))
        K.rivets((s * 0.11, -0.25, 0.015), (s * 0.11, 0.25, 0.015), 9, r=0.006, mat="rivet_e")
        for y in (-0.13, 0.0, 0.13):
            K.box(0.25, 0.008, 0.005, (0, y, 0.015), "fer", detail=True)
K.box(0.08, 0.4, 0.045, (0, -0.06, 0.49), "team", top=(0.06, 0.38))
for y in (0.06, -0.06, -0.18):
    K.box(0.09, 0.022, 0.012, (0, y, 0.532), "fer")
# l'établi à l'arrière : la planche de chêne, l'enclume, l'étau, la forge qui rougeoie sous sa hotte
K.box(0.34, 0.12, 0.03, (0, -0.38, 0.255), "wood_l")
for s in (1, -1):
    K.box(0.02, 0.02, 0.08, (s * 0.15, -0.42, 0.18), "wood")
K.box(0.1, 0.08, 0.06, (-0.1, -0.38, 0.285), "fer_m", top=(0.09, 0.07))
K.box(0.07, 0.06, 0.012, (-0.1, -0.38, 0.345), "fire")
K.lathe([(0.055, 0), (0.03, 0.05), (0.014, 0.07), (0.012, 0.16)], (-0.1, -0.38, 0.38), "fer", seg=6)
K.rings([[(0.03, -0.4, 0.285), (0.09, -0.4, 0.285), (0.09, -0.36, 0.285), (0.03, -0.36, 0.285)],
         [(0.04, -0.395, 0.3), (0.08, -0.395, 0.3), (0.08, -0.365, 0.3), (0.04, -0.365, 0.3)],
         [(0.02, -0.4, 0.32), (0.13, -0.385, 0.32), (0.13, -0.375, 0.32), (0.02, -0.36, 0.32)]], "acier")
K.box(0.026, 0.03, 0.035, (0.14, -0.42, 0.285), "fer")
K.box(0.012, 0.09, 0.012, (0.02, -0.36, 0.29), "wood_l", rot=(0, 0, 0.5))
K.box(0.03, 0.03, 0.02, (-0.005, -0.325, 0.29), "acier")
# le mât de la grue et sa couronne de laiton
K.lathe([(0.042, 0), (0.032, 0.07), (0.046, 0.072), (0.046, 0.086), (0.03, 0.088)], (0.12, -0.24, 0.47), "fer", seg=8)
K.torus(0.046, 0.006, (0.12, -0.24, 0.552), "laiton_t", seg=10, tseg=4, detail=True)

# ---------------------------------------------------------------------------- la grue
K.use("rotor0")
P = (0.12, -0.24, 0.57)
at = lambda x, y, z: (P[0] + x, P[1] + y, P[2] + z)  # noqa: E731
K.cyl(0.022, 0.16, P, "fer_m", seg=6)
K.pipe([at(0, 0, 0.06), at(0.28, 0, 0.16)], 0.012, "fer", seg=4)
K.pipe([at(0, 0, 0.16), at(0.28, 0, 0.17)], 0.01, "fer", seg=4)
for i in range(4):
    x0 = 0.03 + i * 0.065
    K.pipe([at(x0, 0, 0.07 + x0 * 0.36), at(x0 + 0.065, 0, 0.16 + (x0 + 0.065) * 0.035)], 0.005, "fer_m", seg=3)
K.cyl(0.02, 0.024, at(0.28, -0.012, 0.165), "laiton_t", seg=8, axis="y")
K.pipe([at(0.28, 0, 0.15), at(0.28, 0, 0.05)], 0.003, "rivet_e", seg=3)
K.torus(0.014, 0.004, at(0.28, 0, 0.04), "acier", seg=8, tseg=3, axis="y")
K.sphere(0.018, at(0.28, -0.02, 0.03), "fire", seg=6, rings=4)
K.box(0.04, 0.004, 0.004, at(0.28, -0.02, 0.03), "spark", rot=(0, 0.4, 0.6), center=True)
K.box(0.06, 0.04, 0.04, at(-0.05, 0, 0.1), "fer_m")

finish(K, "atelier", {"rotor0": P})
