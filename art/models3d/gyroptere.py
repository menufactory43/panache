"""Le Gyroptère : un autogire à vapeur.

Une chaudière ovale en guise de cellule (fer de suie, le dessus aux couleurs du camp, cercles de laiton,
coutures rivetées, hublots éclairés par le foyer), le pilote dans son puits derrière un pare-brise, une
haute cheminée derrière le pylône, un rotor libre à trois pales de couleur (un disque de couleur vu d'en
haut), un canon antichar sous le menton, une poutre de queue jusqu'à la dérive de couleur et l'hélice
propulsive, des patins. Modelé à l'échelle 2.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit as kitmod  # noqa: E402
from common import PI, finish, lamp, prop, start  # noqa: E402
from emp import EMP, e_stack  # noqa: E402
from kit import xf  # noqa: E402
from mathutils import Matrix  # noqa: E402

K = start(EMP)
kitmod.GRADE[:] = [-0.34, 0.5]
K.use("hull")
SC = Matrix.Diagonal((2, 2, 2, 1))
RX, RY, RL = 0.109, 0.101, 0.208  # demi-largeur, demi-hauteur, demi-longueur de la chaudière

with K.on(SC):
    # ------------------------------------------------------------- la cellule
    N = 10
    PROF = [(math.sin(PI * k / N), -RL * math.cos(PI * k / N)) for k in range(N + 1)]
    PROF[0], PROF[-1] = (0.0, -RL), (0.0, RL)
    ENV = xf((0, 0, 0), (-PI / 2, 0, 0), (RX, RY, 1))
    TOP = (PI * 1.5 - PI * 5 / 14, PI * 1.5 + PI * 5 / 14)
    K.lathe(PROF[:3], (0, 0, 0), "fer_m", seg=14, M=ENV, fix=True)
    K.lathe(PROF[-3:], (0, 0, 0), "fer_m", seg=14, M=ENV, fix=True)
    K.lathe(PROF[2:-2][::-1], (0, 0, 0), "team", seg=5, hs=15, M=ENV, arc=TOP, fix=False)
    K.lathe(PROF[2:-2][::-1], (0, 0, 0), "fer_m", seg=9, hs=27, M=ENV, arc=(TOP[1], TOP[0] + 2 * PI), fix=False)
    for y in (0.12, -0.07):
        k = math.sqrt(1 - (y / RL) ** 2)
        K.lathe([(1.04, -0.01), (1.08, -0.008), (1.08, 0.008), (1.04, 0.01)], (0, 0, 0), "laiton_t", seg=14, closed=True, detail=True, M=xf((0, y, 0), (-PI / 2, 0, 0), (RX * k, RY * k, 1)))
        for i in range(14):
            a = 2 * PI * i / 14
            K.rivet(((RX * k + 0.004) * math.cos(a), y - 0.018, (RY * k + 0.004) * math.sin(a)), (math.cos(a), 0, math.sin(a)), 0.005, "rivet_e")
    for s in (1, -1):
        K.rivets((s * RX * 0.99, 0.1, 0.01), (s * RX * 0.99, -0.06, 0.01), 7, n=(s, 0, 0), r=0.005, mat="rivet_e")
        K.torus(0.02, 0.006, (s * (RX - 0.002), 0.03, -0.02), "laiton_t", seg=8, tseg=3, axis="x", detail=True)
        K.lathe([(0.018, 0), (0.01, 0.006), (0, 0.007)], (s * (RX - 0.004), 0.03, -0.02), "amber", seg=8, axis="x" if s > 0 else "-x", detail=True)
    K.sphere(0.03, (0, RL - 0.012, -0.005), "laiton_t", seg=8, rings=5)
    lamp(K, (0, RL + 0.008, -0.005), 0.02)
    K.box(0.06, 0.07, 0.012, (0, -0.05, -RY), "fire", detail=True)
    # le puits du pilote et son pare-brise, la casquette et les lunettes, la trémie à charbon derrière
    K.torus(0.04, 0.007, (0, 0.1, RY + 0.002), "laiton_t", seg=10, tseg=4, scale=(1, 0.9, 1))
    K.box(0.07, 0.065, 0.006, (0, 0.1, RY - 0.006), "soot", detail=True)
    K.sphere(0.024, (0, 0.095, RY + 0.03), "leather", seg=8, rings=5)
    K.box(0.04, 0.01, 0.008, (0, 0.118, RY + 0.03), "laiton_t")
    K.box(0.085, 0.005, 0.042, (0, 0.14, RY + 0.012), "jar", rot=(0.4, 0, 0))
    K.box(0.09, 0.008, 0.006, (0, 0.149, RY + 0.05), "laiton_t", rot=(0.4, 0, 0))
    K.box(0.07, 0.05, 0.035, (0, -0.07, RY - 0.008), "fer", top=(0.06, 0.04))
    for x, y in ((-0.015, -0.06), (0.015, -0.075), (0.0, -0.085)):
        K.box(0.022, 0.02, 0.016, (x, y, RY + 0.026), "coal", rot=(x * 20, 0, y * 10))
    # le pylône du rotor : un mât sur quatre jambes, ses colliers de laiton, le tambour du moyeu
    K.cyl(0.018, 0.17, (0, 0, 0.085), "fer", seg=8, r1=0.012)
    for z in (0.13, 0.22):
        K.torus(0.018, 0.006, (0, 0, z), "laiton_t", seg=8, tseg=3, detail=True)
    for x, y in ((0.05, 0.04), (-0.05, 0.04), (0.05, -0.04), (-0.05, -0.04)):
        K.pipe([(x, y, RY - 0.01), (0, 0, 0.21)], 0.005, "fer_m", seg=4)
    K.lathe([(0.022, 0), (0.026, 0.005), (0.026, 0.025), (0.012, 0.03)], (0, 0, 0.228), "fer_m", seg=8)
    # la cheminée derrière le pylône, un tuyau de cuivre vers la chaudière
    e_stack(K, (0, -0.11, 0.06), 0.02, 0.15, seg=8)
    K.pipe([(0.03, -0.1, 0.08), (0.03, -0.06, 0.11), (0.03, -0.02, 0.1)], 0.006, "copper", seg=4, round_=0.02)
    # le canon sous le menton : la culasse, son tambour de munitions, un long tube bagué, le frein de bouche
    K.box(0.06, 0.1, 0.045, (0, 0.11, -0.122), "fer", top=(0.05, 0.09))
    K.lathe([(0, -0.016), (0.03, -0.014), (0.031, 0.014), (0.02, 0.018), (0, 0.019)], (0.045, 0.09, -0.1), "fer_m", seg=10, axis="x")
    K.cyl(0.016, 0.22, (0, 0.14, -0.11), "gun", seg=8, axis="y", r1=0.014)
    for y in (0.18, 0.2):
        K.torus(0.018, 0.005, (0, y, -0.11), "laiton_t", seg=8, tseg=3, axis="y", detail=True)
    K.lathe([(0.014, 0), (0.024, 0.008), (0.024, 0.036), (0.016, 0.04)], (0, 0.35, -0.11), "gun", seg=8, axis="y")
    # la poutre de queue, baguée ; dérive et plan fixe de couleur, gouvernes sombres ; le palier de l'hélice, un feu
    K.cyl(0.034, 0.34, (0, -0.18, 0.03), "fer", seg=8, axis="-y", r1=0.014)
    for y in (-0.25, -0.36, -0.46):
        K.torus(0.031 - (-y - 0.2) * 0.058, 0.004, (0, y, 0.03), "laiton_t", seg=8, tseg=3, axis="y", detail=True)
    K.rings([[(-0.005, -0.38, 0.03), (0.005, -0.38, 0.03), (0.005, -0.5, 0.03), (-0.005, -0.5, 0.03)],
             [(-0.004, -0.43, 0.16), (0.004, -0.43, 0.16), (0.004, -0.5, 0.17), (-0.004, -0.5, 0.17)]], "team")
    K.rings([[(-0.005, -0.5, 0.03), (0.005, -0.5, 0.03), (0.005, -0.535, 0.03), (-0.005, -0.535, 0.03)],
             [(-0.004, -0.5, 0.17), (0.004, -0.5, 0.17), (0.004, -0.535, 0.165), (-0.004, -0.535, 0.165)]], "fer")
    for s in (1, -1):
        K.prism([(s * x, y) for x, y in ([(0, -0.4), (0.13, -0.44), (0.13, -0.49), (0, -0.5)] if s < 0 else [(0, -0.5), (0.13, -0.49), (0.13, -0.44), (0, -0.4)])], 0.026, 0.034, "team")
        K.box(0.006, 0.05, 0.012, (s * 0.13, -0.465, 0.024), "fer_m")
    K.sphere(0.012, (0, -0.47, 0.18), "fire", seg=6, rings=4)
    # les patins, relevés du bec, sur leurs traverses
    for s in (1, -1):
        K.pipe([(s * 0.09, 0.23, -0.13), (s * 0.09, 0.19, -0.16), (s * 0.09, -0.15, -0.16)], 0.007, "fer_m", seg=4, round_=0.02)
        K.pipe([(s * 0.05, 0.08, -0.08), (s * 0.09, 0.1, -0.155)], 0.006, "fer", seg=4)
        K.pipe([(s * 0.05, -0.07, -0.08), (s * 0.09, -0.08, -0.155)], 0.006, "fer", seg=4)
    for y in (0.1, -0.08):
        K.pipe([(-0.09, y, -0.15), (0.09, y, -0.15)], 0.004, "fer", seg=3)

ROTOR = prop(K, "rotor0", (6, 0, 0), 0.8, 3, axis="z", blade="team", tip="team", width=0.11, hub="fer_m", hub_r=0.06)
SCREW = prop(K, "rotor1", (-6, 0, 0), 0.17, 3, axis="y", width=0.2, hub="laiton_t")
finish(K, "gyroptere", {"rotor0": ROTOR, "rotor1": SCREW})
