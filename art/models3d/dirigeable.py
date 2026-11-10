"""Le dirigeable d'observation (Scout) : une petite « Patrie ».

Enveloppe de toile vernie cerclée de laiton, bande et empennage aux couleurs du camp, nacelle de bois
suspendue dessous avec ses fenêtres au gaz, son projecteur, ses sacs de lest et son hélice propulsive.
Modelé à l'échelle 2 (le jeu ramène chaque unité à sa taille).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, lamp, prop, start  # noqa: E402
from kit import xf  # noqa: E402

import kit as kitmod  # noqa: E402

K = start()
kitmod.GRADE[:] = [-0.33, 0.27]
K.use("hull")
L, R = 0.5, 0.18  # demi-longueur et rayon de l'enveloppe

# ---------------------------------------------------------------- l'enveloppe
N = 14
PROF = [(R * math.sin(PI * k / N), -L * math.cos(PI * k / N)) for k in range(N + 1)]
PROF[0], PROF[-1] = (0.0, -L), (0.0, L)
ENV = xf((0, 0, 0), (-PI / 2, 0, 0), (1, 0.92, 1))
# (le dessus, au milieu : la bande aux couleurs du camp, entre deux coutures)
TOP = (PI * 1.5 - PI * 3 / 16, PI * 1.5 + PI * 3 / 16)  # (trois des seize fuseaux)
K.lathe(PROF[:4], (0, 0, 0), "canvas", seg=16, M=ENV, fix=True)
K.lathe(PROF[-4:], (0, 0, 0), "canvas", seg=16, M=ENV, fix=True)
K.lathe(PROF[3:-3][::-1], (0, 0, 0), "team", seg=3, hs=9, M=ENV, arc=TOP, fix=False)
K.lathe(PROF[3:-3][::-1], (0, 0, 0), "canvas", seg=13, hs=39, M=ENV, arc=(TOP[1], TOP[0] + 2 * PI), fix=False)
rad = lambda y: R * math.sqrt(max(0.0, 1 - (y / L) ** 2))  # noqa: E731
# les fuseaux : huit coutures le long de l'enveloppe ; quatre cercles de laiton
for k in range(8):
    a = PI / 8 + 2 * PI * k / 8
    K.pipe([(rad(y) * math.cos(a) * 1.002, y, rad(y) * math.sin(a) * 0.922) for y in [L * (-0.94 + 1.88 * i / 14) for i in range(15)]], 0.004, "soot", seg=3, detail=True)
for y in (-0.3, -0.1, 0.12, 0.32):
    K.torus(rad(y) + 0.004, 0.011, (0, y, 0), "brass", seg=16, tseg=5, axis="y", scale=(1, 0.92, 1), detail=True)
# la bande du camp sur le dos, la coiffe de laiton du nez et son anneau d'amarrage
K.lathe([(0, 0.0), (0.028, 0.004), (0.05, 0.02), (0.066, 0.05), (0.07, 0.075), (0.06, 0.075)], (0, L + 0.006, 0), "brass", seg=10, axis="-y", fix=True)
# l'empennage : dérive et plans aux couleurs du camp, la quille sombre, leurs nervures
TY = -0.43
K.rings([[(-0.008, TY + 0.1, 0.09), (0.008, TY + 0.1, 0.09), (0.008, TY - 0.09, 0.07), (-0.008, TY - 0.09, 0.07)],
         [(-0.005, TY + 0.02, 0.26), (0.005, TY + 0.02, 0.26), (0.005, TY - 0.1, 0.25), (-0.005, TY - 0.1, 0.25)]], "team")
for s in (1, -1):
    K.rings([[(s * 0.06, TY + 0.1, -0.008), (s * 0.06, TY + 0.1, 0.008), (s * 0.06, TY - 0.09, 0.008), (s * 0.06, TY - 0.09, -0.008)],
             [(s * 0.23, TY + 0.02, -0.005), (s * 0.23, TY + 0.02, 0.005), (s * 0.23, TY - 0.1, 0.005), (s * 0.23, TY - 0.1, -0.005)]], "team")
    for u in (0.1, 0.16):
        K.box(0.006, 0.15, 0.005, (s * u, TY - 0.02, 0.006), "wood", detail=True)
K.rings([[(-0.008, TY + 0.1, -0.09), (0.008, TY + 0.1, -0.09), (0.008, TY - 0.09, -0.07), (-0.008, TY - 0.09, -0.07)],
         [(-0.005, TY + 0.03, -0.2), (0.005, TY + 0.03, -0.2), (0.005, TY - 0.1, -0.19), (-0.005, TY - 0.1, -0.19)]], "armor_d")

# ------------------------------------------------------------------ la nacelle
GZ = -0.3
K.rings([[(-0.035, 0.17, GZ + 0.02), (0.035, 0.17, GZ + 0.02), (0.035, 0.17, GZ + 0.065), (-0.035, 0.17, GZ + 0.065)],
         [(-0.06, 0.1, GZ), (0.06, 0.1, GZ), (0.06, 0.1, GZ + 0.075), (-0.06, 0.1, GZ + 0.075)],
         [(-0.06, -0.14, GZ), (0.06, -0.14, GZ), (0.06, -0.14, GZ + 0.075), (-0.06, -0.14, GZ + 0.075)],
         [(-0.04, -0.18, GZ + 0.015), (0.04, -0.18, GZ + 0.015), (0.04, -0.18, GZ + 0.07), (-0.04, -0.18, GZ + 0.07)]], "wood")
K.box(0.132, 0.3, 0.012, (0, -0.02, GZ + 0.072), "brass")
for s in (1, -1):
    for y in (-0.09, -0.01, 0.07):
        K.box(0.006, 0.045, 0.03, (s * 0.061, y, GZ + 0.028), "amber", detail=True)
        K.box(0.008, 0.055, 0.006, (s * 0.061, y, GZ + 0.058), "brass", detail=True)
    K.rivets((s * 0.061, -0.13, GZ + 0.012), (s * 0.061, 0.09, GZ + 0.012), 8, n=(s, 0, 0), r=0.005)
    # les suspentes, les sacs de lest
    for y in (-0.1, 0.08):
        K.pipe([(s * 0.05, y, GZ + 0.08), (s * 0.085, y * 1.5, -0.145)], 0.005, "iron", seg=3)
        K.pipe([(s * 0.05, y, GZ + 0.08), (s * 0.03, y * 2.6, -0.14)], 0.004, "iron", seg=3)
    K.lathe([(0.0, 0), (0.02, 0.008), (0.024, 0.03), (0.012, 0.05), (0, 0.052)], (s * 0.075, -0.05, GZ + 0.0), "canvas", seg=6)
    K.lathe([(0.0, 0), (0.02, 0.008), (0.024, 0.03), (0.012, 0.05), (0, 0.052)], (s * 0.075, 0.03, GZ - 0.005), "canvas", seg=6)
# le projecteur sous l'avant, le moteur de laiton à l'arrière
K.box(0.012, 0.012, 0.03, (0, 0.12, GZ - 0.03), "iron")
lamp(K, (0, 0.13, GZ - 0.045), 0.032)
K.lathe([(0.04, 0), (0.046, 0.02), (0.046, 0.07), (0.03, 0.085), (0, 0.086)], (0, -0.17, GZ + 0.04), "brass", seg=8, axis="-y")
K.cyl(0.012, 0.06, (0, -0.2, GZ + 0.07), "iron", seg=5)
PROP = prop(K, "rotor0", (0, -0.275, GZ + 0.04), 0.1, 2, axis="y")

finish(K, "dirigeable", {"rotor0": PROP})
print("[dirigeable] hélice", PROP, "bouche", (0, 0.18, GZ + 0.04))
