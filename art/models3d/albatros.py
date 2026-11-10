"""L'Albatros de Robur (Hornet), d'après Jules Verne.

Longue coque de navire en bois verni, pont aux couleurs du camp sous deux rangs de mâts, chacun coiffé
d'une hélice sustentatrice sur son moyeu de couleur (à des hauteurs décalées), une hélice de propulsion
à la proue et à la poupe, roufs aux fenêtres éclairées, râteliers de bombes sous la quille.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, lamp, prop, start  # noqa: E402
from kit import xf  # noqa: E402

import kit as kitmod  # noqa: E402

K = start()
kitmod.GRADE[:] = [-0.18, 0.3]
K.use("hull")
TOP = 0.03


def sec(y, w, top, bot, c=0.02, belly=0.05):
    c = min(c, w * 0.5, (top - bot) * 0.3)
    d = min(belly, w * 0.6, (top - bot) * 0.5)
    return [(-w, y, top - c), (-w + c, y, top), (w - c, y, top), (w, y, top - c), (w, y, bot + d), (w - d, y, bot), (-w + d, y, bot), (-w, y, bot + d)]


# -------------------------------------------------------------------- la coque
HULL = [(0.7, 0.008, TOP + 0.02, 0.0), (0.6, 0.075, TOP + 0.008, -0.07), (0.44, 0.13, TOP, -0.11), (-0.34, 0.13, TOP, -0.11), (-0.54, 0.095, TOP, -0.085), (-0.64, 0.035, TOP, -0.045)]
K.rings([sec(*s) for s in HULL], "wood")
# la ligne de flottaison d'ivoire, les joints du bordé, la quille de laiton
K.rings([sec(y, w + 0.004, 0.002, -0.018, c=0.002, belly=0.002) for y, w, t, b in HULL[1:]], "enamel", detail=True)
for s in (1, -1):
    for k in (-0.035, -0.06):
        K.pipe([(s * (w + 0.001), y, k * (w / 0.13)) for y, w, t, b in HULL[1:]], 0.0025, "soot", seg=3, detail=True)
    K.rivets((s * 0.131, 0.4, 0.012), (s * 0.131, -0.32, 0.012), 14, n=(s, 0, 0), r=0.005)
K.box(0.014, 1.1, 0.014, (0, 0.04, -0.122), "brass")
# le pont aux couleurs du camp, bordé ; les lisses de laiton sur leurs chandeliers
DECK = [(0.6, 0.05), (0.44, 0.115), (-0.34, 0.115), (-0.53, 0.08), (-0.6, 0.03)]
K.rings([sec(y, w, TOP + 0.013, TOP - 0.004, c=0.004, belly=0.002) for y, w in DECK], "team")
for x in (-0.07, -0.025, 0.025, 0.07):
    K.box(0.004, 0.86, 0.003, (x, 0.05, TOP + 0.013), "soot", detail=True)
RAIL = [(0.0, 0.68), (0.07, 0.58), (0.122, 0.44), (0.122, -0.34), (0.088, -0.53), (0.03, -0.62)]
for s in (1, -1):
    K.pipe([(s * x, y, TOP + 0.045) for x, y in RAIL], 0.0045, "brass", seg=4)
    for y in (0.44, 0.24, 0.05, -0.15, -0.34):
        K.pipe([(s * 0.122, y, TOP), (s * 0.122, y, TOP + 0.045)], 0.003, "brass", seg=3)
# les roufs : murs d'ivoire, fenêtres au gaz, toit sombre riveté
for y, ln in ((0.29, 0.1), (-0.29, 0.12)):
    K.box(0.1, ln, 0.052, (0, y, TOP + 0.012), "enamel")
    K.box(0.114, ln + 0.016, 0.012, (0, y, TOP + 0.064), "armor_d", top=(0.1, ln))
    for s in (1, -1):
        for dy in (-ln / 4, ln / 4):
            K.box(0.006, 0.02, 0.022, (s * 0.05, y + dy, TOP + 0.03), "amber", detail=True)
            K.box(0.007, 0.028, 0.004, (s * 0.05, y + dy, TOP + 0.054), "brass", detail=True)
    K.rivets((-0.04, y - ln / 2, TOP + 0.077), (0.04, y - ln / 2, TOP + 0.077), 4, r=0.004)
# la roue du timonier à l'arrière, l'ancre à l'étrave, deux fanaux, la flamme du camp
K.torus(0.026, 0.005, (0, -0.47, TOP + 0.05), "brass", seg=10, tseg=4, axis="y")
K.box(0.01, 0.01, 0.045, (0, -0.47, TOP + 0.012), "wood")
K.pipe([(0.05, 0.62, TOP + 0.01), (0.07, 0.6, -0.03)], 0.005, "iron", seg=3)
K.torus(0.018, 0.005, (0.07, 0.6, -0.045), "iron", seg=6, tseg=3, axis="x")
lamp(K, (0, 0.63, TOP + 0.05), 0.02)
lamp(K, (0, -0.61, TOP + 0.04), 0.02, axis="-y")
K.pipe([(0, -0.6, TOP), (0, -0.62, TOP + 0.16)], 0.004, "brass", seg=3)
K.rings([[(-0.002, -0.62, TOP + 0.155), (0.002, -0.62, TOP + 0.155), (0.002, -0.62, TOP + 0.105), (-0.002, -0.62, TOP + 0.105)],
         [(-0.002, -0.73, TOP + 0.13), (0.002, -0.73, TOP + 0.13), (0.002, -0.73, TOP + 0.125), (-0.002, -0.73, TOP + 0.125)]], "team")
# les mâts : deux rangs, un collier de laiton au pont, un moyeu de couleur sous chaque hélice
LIFTS = []
YS = [0.43, 0.145, -0.14, -0.43]
for si, s in ((0, 1), (1, -1)):
    for i, y in enumerate(YS):
        x = s * 0.075
        h = 0.22 if (i + si) % 2 else 0.3
        K.cyl(0.01, h - TOP, (x, y, TOP), "wood", seg=6, r1=0.008)
        K.lathe([(0.018, 0), (0.018, 0.012), (0.012, 0.02), (0.01, 0.02)], (x, y, TOP + 0.012), "brass", seg=8)
        K.lathe([(0.02, -0.03), (0.026, -0.022), (0.026, -0.004), (0.016, 0.0), (0, 0.0)], (x, y, h), "team", seg=8, fix=True)
        LIFTS.append((x, y, h + 0.006))
        # les haubans
        K.pipe([(x, y, h - 0.04), (s * 0.12, y + 0.05, TOP + 0.04)], 0.0018, "iron", seg=3)
        K.pipe([(x, y, h - 0.04), (s * 0.12, y - 0.05, TOP + 0.04)], 0.0018, "iron", seg=3)
# les arbres des hélices de proue et de poupe
K.cyl(0.008, 0.08, (0, 0.69, 0.01), "brass", seg=6, axis="y")
K.cyl(0.008, 0.08, (0, -0.63, 0.0), "brass", seg=6, axis="-y")
# les râteliers sous la quille : bombes de fer, nez de couleur, empennage de laiton
for x in (-0.05, 0.05):
    K.box(0.012, 0.5, 0.016, (x, 0.02, -0.128), "iron")
    for y in (0.18, 0.02, -0.14):
        K.lathe([(0.0, -0.045), (0.016, -0.035), (0.023, -0.01), (0.023, 0.02)], (x, y, -0.152), "iron", seg=8, axis="y", fix=True)
        K.lathe([(0.023, 0.02), (0.018, 0.04), (0, 0.052)], (x, y, -0.152), "team", seg=8, axis="y")
        K.box(0.05, 0.018, 0.004, (x, y - 0.045, -0.154), "brass")
        K.box(0.004, 0.018, 0.05, (x, y - 0.045, -0.177), "brass")

# (les deux hélices types sont modelées à l'écart, pour que la cuisson ne les confonde pas avec la coque)
LIFT = prop(K, "lift", (3, 0, 0), 0.13, 3, axis="z", blade="canvas", tip="team", width=0.22)
SCREW = prop(K, "screw", (-3, 0, 0), 0.1, 4, axis="y", width=0.22)
finish(K, "albatros", {"lift": LIFT, "screw": SCREW})
print("[albatros] hélices", LIFTS)
