"""L'Estafette : une motocyclette à vapeur et son side-car.

Chaudière rivetée sous la selle avec son foyer, petite cheminée derrière le pilote (casque à pointe et
lunettes), réservoir aux couleurs du camp sur le cadre, lampe à acétylène sur la fourche, et le baquet
du side-car aux couleurs du camp, ourlé de laiton, son sac de charbon et sa roue à lui.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, start  # noqa: E402
from emp import EMP, coal_heap, e_lamp, e_stack, iron_wheel, rivets_e  # noqa: E402
from kit import xf  # noqa: E402

K = start(EMP)
K.use("hull")
X = -0.09

# ----------------------------------------------------------------- la motocyclette
iron_wheel(K, (X, 0.3, 0.12), 0.12, 0.045, side=-1, n=8)
iron_wheel(K, (X, -0.24, 0.12), 0.12, 0.05, side=-1, n=8)
for y, m in ((0.3, "team"), (-0.25, "fer_m")):
    arc = [(y + 0.15 * math.cos(a), 0.12 + 0.15 * math.sin(a)) for a in [PI * (0.85 - 0.7 * i / 5) for i in range(6)]]
    K.strip_x(arc, X - 0.03, X + 0.03, 0.008, m)
for s in (1, -1):
    K.pipe([(X + s * 0.032, 0.3, 0.12), (X + s * 0.026, 0.24, 0.34)], 0.009, "fer_m", seg=5)
    K.pipe([(X + s * 0.026, 0.24, 0.34), (X + s * 0.11, 0.22, 0.345)], 0.007, "fer_m", seg=4)
    K.cyl(0.012, 0.045, (X + (0.09 if s > 0 else -0.135), 0.22, 0.345), "wood", seg=6, axis="x")
K.rings([[(X - 0.018, 0.2, 0.25), (X + 0.018, 0.2, 0.25), (X + 0.018, 0.2, 0.285), (X - 0.018, 0.2, 0.285)],
         [(X - 0.018, -0.26, 0.215), (X + 0.018, -0.26, 0.215), (X + 0.018, -0.26, 0.25), (X - 0.018, -0.26, 0.25)]], "fer")
e_lamp(K, (X, 0.33, 0.305), 0.04)
# la chaudière sous la selle : cerclée, rivetée, son foyer vers l'avant, la cheminée derrière le pilote
K.lathe([(0, -0.1), (0.055, -0.095), (0.07, -0.08), (0.07, 0.08), (0.055, 0.095), (0, 0.1)], (X, -0.06, 0.2), "fer", seg=10, axis="y")
for y in (0.02, -0.06, -0.14):
    K.lathe([(0.075, -0.007), (0.075, 0.007), (0.069, 0.007), (0.069, -0.007)], (X, y, 0.2), "laiton_t", seg=10, axis="y", closed=True, detail=True)
K.box(0.06, 0.012, 0.04, (X, 0.043, 0.15), "fire", detail=True)
for s in (1, -1):
    rivets_e(K, (X + s * 0.071, 0.02, 0.22), (X + s * 0.071, -0.14, 0.22), 5, (s, 0, 0.3))
K.pipe([(X + 0.05, -0.1, 0.22), (X + 0.06, -0.24, 0.16), (X + 0.06, -0.34, 0.12)], 0.008, "laiton_t", seg=4, round_=0.03)
e_stack(K, (X, -0.2, 0.27), 0.022, 0.26)
# le réservoir de couleur sur le cadre, la selle, le pilote au casque à pointe
K.lathe([(0, -0.09), (0.04, -0.085), (0.055, -0.06), (0.055, 0.06), (0.04, 0.085), (0, 0.09)], (X, 0.12, 0.32), "team", seg=10, axis="y", M=xf((X, 0.12, 0.32), (-PI / 2, 0, 0), (1, 0.75, 1)))
for y in (0.07, 0.17):
    K.box(0.114, 0.012, 0.012, (X, y, 0.279), "laiton_t", detail=True)
K.cyl(0.015, 0.018, (X, 0.14, 0.358), "laiton_t", seg=6)
K.lathe([(0, 0), (0.045, 0.005), (0.05, 0.02), (0.025, 0.03), (0, 0.031)], (X, -0.04, 0.285), "leather", seg=8, M=xf((X, -0.04, 0.285), (0, 0, 0), (1, 1.15, 1)))
K.box(0.12, 0.085, 0.14, (X, 0.0, 0.31), "fer_m", rot=(0.3, 0, 0), top=(0.11, 0.07))
for s in (1, -1):
    K.box(0.026, 0.13, 0.026, (X + s * 0.062, 0.075, 0.385), "fer_m", rot=(-0.5, 0, 0), center=True)
K.box(0.08, 0.06, 0.02, (X, 0.03, 0.44), "team")
K.sphere(0.032, (X, 0.03, 0.485), "peau", seg=8, rings=5)
K.lathe([(0.042, 0), (0.044, 0.008), (0.036, 0.03), (0.016, 0.042), (0.008, 0.048), (0.004, 0.09), (0, 0.092)], (X, 0.03, 0.497), "soot", seg=8)
K.torus(0.043, 0.005, (X, 0.03, 0.502), "laiton_t", seg=8, tseg=3, detail=True)
K.cyl(0.006, 0.05, (X, 0.03, 0.54), "laiton_t", seg=5, r1=0.001)
K.box(0.06, 0.012, 0.016, (X, 0.062, 0.486), "fire")

# ---------------------------------------------------------------------- le side-car
SX = 0.16
TUB = [(0.25, 0.02, 0.22, 0.14), (0.2, 0.07, 0.26, 0.11), (0.12, 0.09, 0.275, 0.1), (-0.06, 0.095, 0.28, 0.1), (-0.15, 0.075, 0.27, 0.12)]


def sec(y, w, top, bot):
    c = min(0.03, w * 0.5, (top - bot) * 0.35)
    return [(SX - w, y, top - c), (SX - w + c, y, top), (SX + w - c, y, top), (SX + w, y, top - c), (SX + w, y, bot + c), (SX + w - c, y, bot), (SX - w + c, y, bot), (SX - w, y, bot + c)]


K.rings([sec(*s) for s in TUB], "team")
K.box(0.13, 0.16, 0.006, (SX, -0.03, 0.278), "soot", detail=True)
for s in (1, -1):
    K.pipe([(SX + s * 0.07, 0.2, 0.262), (SX + s * 0.09, 0.12, 0.278), (SX + s * 0.094, -0.06, 0.283), (SX + s * 0.075, -0.15, 0.273)], 0.008, "laiton_t", seg=4)
rivets_e(K, (SX + 0.096, 0.15, 0.2), (SX + 0.096, -0.12, 0.2), 6, (1, 0, 0))
K.lathe([(0, 0), (0.04, 0.006), (0.048, 0.04), (0.03, 0.07), (0.012, 0.085), (0, 0.086)], (SX, -0.08, 0.28), "sac", seg=7)
coal_heap(K, SX - 0.03, SX + 0.03, -0.1, -0.06, 0.365, 4, 0.016)
iron_wheel(K, (0.275, 0.0, 0.1), 0.1, 0.04, side=1, n=8)
for y in (0.12, -0.12):
    K.pipe([(X, y, 0.2), (0.25, y * 0.4, 0.13)], 0.011, "fer_m", seg=4)
e_lamp(K, (SX, 0.24, 0.25), 0.026)

finish(K, "estafette")
