"""Le Pasteur (Mender) : un petit ballon-atelier.

Sphère de toile à calotte et ceinture aux couleurs du camp, un engrenage et une clé d'ivoire sur la
calotte (lus d'en haut), cercle de charge de laiton et suspentes jusqu'à la nacelle-atelier de bois,
deux bras articulés de laiton (une clé, une perceuse), la lampe de travail dessous, une petite hélice
propulsive. Modelé à l'échelle 2.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, lamp, prop, start  # noqa: E402
from kit import toward, xf  # noqa: E402
from mathutils import Vector  # noqa: E402

import kit as kitmod  # noqa: E402

K = start()
kitmod.GRADE[:] = [-0.42, 0.47]
K.use("hull")
Y, R = 0.2, 0.27  # le centre et le rayon du ballon

# -------------------------------------------------------------------- le ballon
N = 12
ang = [PI * (-0.5 + k / N) for k in range(N + 1)]
prof = [(max(0.0, R * math.cos(a)), R * math.sin(a)) for a in ang]
CAP = 8  # (les quatre anneaux du haut : la calotte de couleur)
K.lathe([(0.0, prof[0][1])] + prof[1:CAP + 1], (0, 0, Y), "canvas", seg=16, fix=True)
K.lathe(prof[CAP:-1] + [(0.0, prof[-1][1])], (0, 0, Y), "team", seg=16)
on = lambda rr: Y + math.sqrt(R * R - rr * rr)  # noqa: E731
# la ceinture de couleur, deux cercles de laiton, les coutures des fuseaux
K.lathe([(R + 0.004, -0.028), (R + 0.012, -0.02), (R + 0.012, 0.02), (R + 0.004, 0.028)], (0, 0, Y), "team", seg=16, closed=True, detail=True)
for zz in (-0.16, 0.16):
    K.torus(math.sqrt(R * R - zz * zz) + 0.003, 0.009, (0, 0, Y + zz), "brass", seg=16, tseg=4, detail=True)
for k in range(8):
    a = PI / 8 + 2 * PI * k / 8
    K.pipe([(R * 1.003 * math.cos(b) * math.cos(a), R * 1.003 * math.cos(b) * math.sin(a), Y + R * 1.003 * math.sin(b)) for b in [PI * (-0.42 + 0.56 * i / 8) for i in range(9)]], 0.004, "soot", seg=3, detail=True)
# l'emblème sur la calotte : un engrenage d'ivoire, une clé en travers
K.torus(0.08, 0.018, (0, 0, on(0.08) - 0.006), "enamel", seg=12, tseg=4, detail=True)
for i in range(8):
    a = 2 * PI * i / 8
    K.box(0.036, 0.03, 0.022, (0.106 * math.cos(a), 0.106 * math.sin(a), on(0.106) - 0.012), "enamel", rot=(0, 0, a), detail=True)
K.box(0.03, 0.2, 0.018, (0, 0, on(0.0) - 0.008), "enamel", rot=(0, 0, PI / 4), detail=True)
for k in (1, -1):
    c = k * 0.116 * math.sqrt(0.5)
    K.torus(0.03, 0.012, (-c, c, on(0.116) - 0.004), "enamel", seg=8, tseg=4, detail=True)
K.lathe([(0.03, 0), (0.03, 0.01), (0.012, 0.022), (0, 0.024)], (0, 0, Y + R - 0.004), "brass", seg=8)

# ------------------------------------------------- le cercle de charge et la nacelle
RING = Y - R - 0.02
G = -0.34
K.torus(0.14, 0.012, (0, 0, RING), "brass", seg=14, tseg=5)
for sx in (1, -1):
    for sy in (1, -1):
        K.pipe([(sx * 0.132, sy * 0.13, RING), (sx * 0.11, sy * 0.13, G + 0.075)], 0.006, "iron", seg=3)
        K.pipe([(sx * 0.165, sy * 0.19, Y - 0.16), (sx * 0.132, sy * 0.13, RING)], 0.005, "iron", seg=3)
K.box(0.3, 0.34, 0.15, (0, 0, G - 0.075), "wood", top=(0.3, 0.34))
K.box(0.316, 0.356, 0.016, (0, 0, G + 0.068), "brass")
for s in (1, -1):
    # l'engrenage du camp sur le flanc, un hublot allumé, les planches
    with K.on(xf((s * 0.151, 0.04, G), (0, 0, 0)) @ toward((s, 0, 0))):
        K.torus(0.04, 0.014, (0, 0, 0), "team", seg=10, tseg=4, detail=True)
        for i in range(6):
            a = 2 * PI * i / 6
            K.box(0.022, 0.02, 0.012, (0.058 * math.cos(a), 0.058 * math.sin(a), 0), "team", rot=(0, 0, a), detail=True)
    K.torus(0.026, 0.008, (s * 0.151, -0.09, G + 0.01), "brass", seg=10, tseg=4, axis="x", detail=True)
    K.lathe([(0.024, 0), (0.014, 0.008), (0, 0.01)], (s * 0.15, -0.09, G + 0.01), "amber", seg=8, axis="x" if s > 0 else "-x", detail=True)
    for z in (-0.04, 0.02):
        K.box(0.004, 0.34, 0.004, (s * 0.151, 0, G + z), "soot", detail=True)
    K.rivets((s * 0.152, -0.15, G - 0.06), (s * 0.152, 0.15, G - 0.06), 7, n=(s, 0, 0), r=0.006)
# la lampe de travail dessous
K.lathe([(0.04, 0), (0.06, -0.04), (0.05, -0.04)], (0, 0, G - 0.075), "brass", seg=10, fix=True)
K.lathe([(0.05, -0.036), (0, -0.04)], (0, 0, G - 0.075), "amber", seg=10, fix=True)
# deux bras articulés de laiton qui passent devant le ballon : une clé, une perceuse
for s in (1, -1):
    sh, el, wr = Vector((s * 0.15, 0.08, G + 0.02)), Vector((s * 0.34, 0.18, G + 0.06)), Vector((s * 0.38, 0.3, G - 0.06))
    K.sphere(0.028, sh, "brass", seg=6, rings=4)
    K.pipe([sh, el], 0.016, "brass", seg=6, r1=0.014)
    K.pipe([el, wr], 0.014, "brass", seg=6, r1=0.012)
    K.sphere(0.026, el, "gun", seg=6, rings=4)
    K.sphere(0.022, wr, "gun", seg=6, rings=4)
    K.pipe([sh + Vector((0, 0.02, -0.03)), el + Vector((0, 0, -0.035))], 0.006, "copper", seg=4)
    if s > 0:
        K.box(0.028, 0.09, 0.024, (wr.x, wr.y + 0.06, wr.z - 0.012), "enamel", center=False)
        for dx in (-0.026, 0.026):
            K.box(0.016, 0.052, 0.024, (wr.x + dx, wr.y + 0.124, wr.z - 0.012), "enamel")
        K.box(0.068, 0.016, 0.024, (wr.x, wr.y + 0.1, wr.z - 0.012), "enamel")
    else:
        K.cyl(0.032, 0.04, (wr.x, wr.y + 0.012, wr.z), "gun", seg=8, axis="y")
        K.lathe([(0.024, 0), (0.016, 0.05), (0, 0.1)], (wr.x, wr.y + 0.052, wr.z), "enamel", seg=6, axis="y")
# le petit moteur et son échappement
K.lathe([(0.044, 0), (0.048, 0.02), (0.048, 0.09), (0.03, 0.1), (0, 0.1)], (0, -0.17, G), "brass", seg=8, axis="-y")
K.cyl(0.02, 0.08, (0, -0.1, G + 0.076), "iron", seg=6, r1=0.024)

PROP = prop(K, "rotor0", (0, -0.29, G), 0.13, 4, axis="y", tip="team", width=0.24)
finish(K, "pasteur", {"rotor0": PROP})
print("[pasteur] hélice", PROP)
