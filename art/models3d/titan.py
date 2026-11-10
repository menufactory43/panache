"""Le Titan : un long dirigeable cargo ventru et cuirassé.

Tout le ballon aux couleurs du camp, sanglé de fer dans sa longueur, une coiffe de suie et un cône de
queue riveté, un empennage en caisson à deux dérives de fer ; suspendue dessous, la nacelle est la soute
du Condor (CONDOR_BAY de models.ts : pont, bancs, parois blindées, la rampe de poupe) avec une proue
rivetée. Un treuil à vapeur au milieu (là où pendent les câbles d'un Gargantua soulevé) et son crochet
sous la quille ; deux poutres portent quatre moteurs à hélices tractives ; une cheminée à la proue.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit as kitmod  # noqa: E402
from common import PI, finish, lamp, prop, start  # noqa: E402
from emp import EMP, e_stack  # noqa: E402
from kit import frame, xf  # noqa: E402

K = start({**EMP,
           "soute": dict(color=0x4a423b, under=0xa09a92, metal=0.4, rough=0.65, wear=0.0, edge_light=0.4, dirt=0.15, bump=0.4),
           "banc": dict(color=0xa65a32, under=0xe0a070, metal=0.8, rough=0.4, wear=0.0, edge_light=0.4, dirt=0.15)})
kitmod.GRADE[:] = [-0.3, 0.7]
K.use("hull")
FLOOR, BENCH, WALL, BW, Z0, Z1, RAMP, RAMPW = -0.1, -0.064, 0.0, 0.34, -0.31, 0.17, 0.34, 0.27
W = BW / 2 + 0.03
CY, CZ, RX, RZ, L = 0.04, 0.44, 0.26, 0.229, 0.598

# -------------------------------------------------------------------- le ballon
N = 12
PROF = [(math.sin(PI * k / N), -L * math.cos(PI * k / N)) for k in range(N + 1)]
PROF[0], PROF[-1] = (0.0, -L), (0.0, L)
ENV = xf((0, CY, CZ), (-PI / 2, 0, 0), (RX, RZ, 1))
K.lathe(PROF[:2], (0, 0, 0), "fer", seg=14, M=ENV, fix=True)
K.lathe(PROF[1:-1], (0, 0, 0), "team", seg=14, M=ENV)
K.lathe(PROF[-2:], (0, 0, 0), "soot", seg=14, M=ENV, fix=True)
# les sangles de fer dans la longueur : une sur la crête, deux sur les épaules, une par flanc ; leurs rivets
ENV2 = xf((0, CY, CZ), (-PI / 2, 0, 0), (RX * 1.02, RZ * 1.02, 1))
for phi in (1.5 * PI, 1.5 * PI - 0.95, 1.5 * PI + 0.95, PI, 2 * PI):
    K.lathe(PROF[1:-1][::-1], (0, 0, 0), "fer", seg=1, hs=2, M=ENV2, arc=(phi - 0.055, phi + 0.055), fix=False, detail=True)
for i in range(9):
    y = -0.46 + i * 0.115
    k = math.sqrt(max(0.0, 1 - (y / L) ** 2))
    K.rivet((0, CY + y, CZ + RZ * k * 1.03), (0, 0, 1), 0.008, "rivet_e")
    for s in (1, -1):
        K.rivet((s * RX * k * 1.03, CY + y, CZ), (s, 0, 0), 0.008, "rivet_e")
K.torus(0.1, 0.01, (0, CY + L - 0.085, CZ), "laiton_t", seg=12, tseg=4, axis="y", scale=(1, 1, 0.88), detail=True)
K.lathe([(0.07, 0), (0.05, 0.04), (0, 0.1)], (0, CY - L + 0.03, CZ), "fer", seg=10, axis="-y")
# l'empennage en caisson : un plan de couleur entre deux dérives de fer ourlées de laiton, une quille
K.prism([(-0.26, -0.6), (0.26, -0.6), (0.26, -0.42), (-0.26, -0.42)], CZ - 0.007, CZ + 0.007, "team")
for x in (-0.13, 0.0, 0.13):
    K.box(0.006, 0.17, 0.004, (x, -0.51, CZ + 0.007), "fer", detail=True)
for s in (1, -1):
    K.rings([[(s * 0.26 - 0.007, -0.4, CZ - 0.07), (s * 0.26 + 0.007, -0.4, CZ - 0.07), (s * 0.26 + 0.007, -0.62, CZ - 0.08), (s * 0.26 - 0.007, -0.62, CZ - 0.08)],
             [(s * 0.26 - 0.006, -0.45, CZ + 0.14), (s * 0.26 + 0.006, -0.45, CZ + 0.14), (s * 0.26 + 0.006, -0.62, CZ + 0.16), (s * 0.26 - 0.006, -0.62, CZ + 0.16)]], "fer")
    K.box(0.018, 0.012, 0.24, (s * 0.26, -0.625, CZ - 0.08), "laiton_t")
    K.pipe([(s * 0.12, -0.4, CZ - 0.06), (s * 0.26, -0.45, CZ)], 0.006, "fer_m", seg=4)
    K.sphere(0.011, (s * 0.26, -0.62, CZ + 0.17), "fire", seg=6, rings=4)
K.rings([[(-0.007, -0.38, CZ - 0.1), (0.007, -0.38, CZ - 0.1), (0.007, -0.6, CZ - 0.1), (-0.007, -0.6, CZ - 0.1)],
         [(-0.006, -0.46, CZ - 0.21), (0.006, -0.46, CZ - 0.21), (0.006, -0.6, CZ - 0.22), (-0.006, -0.6, CZ - 0.22)]], "fer")

# --------------------------------------------------------------------- la nacelle
def sec(y, w, top, bot):
    c = min(0.03, w * 0.5, (top - bot) * 0.3)
    return [(-w, y, top - c), (-w + c, y, top), (w - c, y, top), (w, y, top - c), (w, y, bot + c), (w - c, y, bot), (-w + c, y, bot), (-w, y, bot + c)]


K.rings([sec(0.5, 0.03, 0.02, -0.08), sec(0.42, 0.13, 0.02, -0.17), sec(-Z0, W, 0.02, -0.19)], "fer_m")
ZR, ZC = (Z0 + RAMP) / 2, (Z0 + Z1) / 2
K.box(2 * W, RAMP - Z0, 0.09, (0, -ZR, -0.19), "soute")
for x in (-0.085, 0.0, 0.085):
    K.box(0.004, RAMP - Z0, 0.003, (x, -ZR, FLOOR), "soot", detail=True)
for s in (1, -1):
    K.box(0.03, RAMP - Z0, WALL - FLOOR + 0.02, (s * (BW / 2 + 0.015), -ZR, FLOOR), "soute")
    K.box(0.034, Z1 - Z0 - 0.02, BENCH - FLOOR, (s * (BW / 2 - 0.017), -ZC, FLOOR), "banc")
    K.box(0.04, RAMP - Z0 + 0.01, 0.014, (s * (BW / 2 + 0.015), -ZR, WALL + 0.02), "team")
    for z in (-0.06, -0.15):
        K.rivets((s * (W + 0.001), -Z0 - 0.02, z), (s * (W + 0.001), -RAMP + 0.02, z), 10, n=(s, 0, 0), r=0.006, mat="rivet_e")
    K.torus(0.02, 0.006, (s * 0.148, 0.37, -0.08), "laiton_t", seg=8, tseg=3, axis="x", detail=True)
    K.lathe([(0.016, 0), (0, 0.005)], (s * 0.146, 0.37, -0.08), "amber", seg=8, axis="x" if s > 0 else "-x", detail=True)
    for zz in (Z0 + 0.06, Z1 - 0.04):
        K.box(0.008, 0.02, 0.014, (s * (W + 0.002), -zz, WALL - 0.03), "amber", detail=True)
    # les câbles jusqu'au ballon
    for yy, x2, y2, dz in ((0.36, 0.15, 0.34, 0.17), (-0.3, 0.15, -0.26, 0.17), (0.04, 0.2, 0.04, 0.14)):
        K.pipe([(s * W, yy, WALL), (s * x2, y2, CZ - dz)], 0.004, "fer_m", seg=3)
lamp(K, (0, 0.5, -0.05), 0.022)
# la soute à charbon sur le gaillard, le treuil au milieu (cuivre, flasques de laiton), le crochet sous la quille
K.box(0.16, 0.08, 0.05, (0, 0.4, 0.02), "fer", top=(0.15, 0.07))
for x, y in ((-0.03, 0.4), (0.03, 0.405)):
    K.box(0.035, 0.03, 0.02, (x, y, 0.075), "coal", rot=(x * 20, 0, y * 8))
K.cyl(0.04, 0.1, (-0.05, 0.0, -0.055), "copper", seg=10, axis="x")
for s in (1, -1):
    K.lathe([(0.052, -0.005), (0.052, 0.005), (0.02, 0.008), (0.02, -0.008)], (s * 0.055, 0.0, -0.055), "laiton_t", seg=10, axis="x", closed=True)
K.pipe([(0, 0, -0.19), (0, 0, -0.235)], 0.006, "fer", seg=4)
K.torus(0.022, 0.006, (0, 0.0, -0.255), "fer_m", seg=8, tseg=4, axis="x")
e_stack(K, (0, 0.38, 0.02), 0.022, 0.14, seg=8)
# deux poutres, quatre moteurs
PROPS = []
for y in (0.2, -0.18):
    K.box(0.84, 0.036, 0.03, (0, y, -0.075), "fer")
    for s in (1, -1):
        x = s * 0.42
        K.pipe([(s * W, y, WALL), (s * 0.36, y, -0.06)], 0.004, "fer_m", seg=3)
        r, ln = 0.048, 0.16
        K.lathe([(r * 0.8, -ln / 2 - 0.004), (r, -ln / 2), (r, ln / 2), (r * 0.5, ln / 2 + r * 0.8), (0, ln / 2 + r * 1.3)], (x, y, -0.06), "fer_m", seg=10, axis="y")
        K.lathe([(r * 1.05, -ln * 0.07), (r * 1.05, ln * 0.23), (r, ln * 0.23), (r, -ln * 0.07)], (x, y, -0.06), "team", seg=10, axis="y", closed=True, detail=True)
        K.torus(r * 1.03, r * 0.1, (x, y - ln * 0.35, -0.06), "laiton_t", seg=10, tseg=3, axis="y", detail=True)
        K.lathe([(r * 0.78, 0), (0, 0.002)], (x, y - ln / 2 - 0.005, -0.06), "fire", seg=10, axis="-y", detail=True)
        PROPS.append((x, y + 0.15, -0.06))

SCREW = prop(K, "screw", (4, 0, 0), 0.12, 2, axis="y", blade="wood", tip="laiton_t", width=0.2, hub="laiton_t", hub_r=0.022)

# ----------------------------------------------------------------------- la rampe
K.use("ramp")
H = (0.0, -RAMP, FLOOR)
RL = WALL + 0.02 - FLOOR
K.box(RAMPW - 0.004, 0.02, RL, (0, -RAMP, FLOOR), "soute")
K.box(RAMPW - 0.06, 0.005, RL * 0.62, (0, -RAMP - 0.0115, FLOOR + RL * 0.19), "team", detail=True)
for i in range(3):
    K.box(RAMPW - 0.06, 0.009, 0.007, (0, -RAMP + 0.0125, FLOOR + 0.017 + i * 0.03), "fer_m", detail=True)
for sx in (1, -1):
    K.box(0.011, 0.013, RL, (sx * (RAMPW / 2 - 0.01), -RAMP - 0.012, FLOOR), "laiton_t")
    K.rivets((sx * 0.09, -RAMP - 0.0105, FLOOR + 0.015), (sx * 0.09, -RAMP - 0.0105, FLOOR + RL - 0.015), 4, n=(0, -1, 0), r=0.006, mat="rivet_e")

finish(K, "titan", {"screw": SCREW, "ramp": H})
print("[titan] hélices", PROPS)
