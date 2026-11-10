"""Le Creusot (Mastodon) en haute fidélité : un cuirassé terrestre.

  /Applications/Blender.app/Contents/MacOS/Blender -b --python art/models3d/creusot.py -- [--res 2048] [--fast]
  python3 art/models3d/pack.py creusot

Coque rivetée sur deux chenilles, éperon de laiton à la proue, hublots au gaz,
chaudière de cuivre et deux cheminées à la poupe ; grande tourelle à deux
canons, coupole de laiton, télémètre, projecteur et flamme aux couleurs du camp.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit as kitmod  # noqa: E402
from kit import PI, Kit, frame, quad_frame  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
FAST = "--fast" in args
RES = int(args[args.index("--res") + 1]) if "--res" in args else (1024 if FAST else 2048)
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "out", "creusot")  # les passes brutes (pack.py en fait les textures)
OUT = os.path.join(HERE, "..", "..", "public", "assets", "models", "creusot")

STEEL = 0x9a968e
MATERIALS = {
    # la tôle peinte, kaki bronze ; sous la peinture, l'acier
    "armor": dict(color=0x80602f, under=STEEL, rough=0.6, mud=0.16, bump=0.35, edge_paint=0.5),
    "armor_d": dict(color=0x3f3024, under=STEEL, rough=0.62, mud=0.2, bump=0.35, edge_paint=0.6),
    "team": dict(color=0xdcdcdc, under=STEEL, rough=0.5, team=1.0, chips=0.3, vary=0.1, streaks=0.35, edge_paint=0.3),
    # les métaux nus
    "iron": dict(color=0x2c2723, under=0x9c978f, metal=0.75, rough=0.55, wear=0.0, edge_light=0.3, mud=0.14, dirt_color=0x3a2c1e),
    "track": dict(color=0x3d352d, under=0xb5aea2, metal=0.7, rough=0.55, wear=0.0, edge_light=0.9, mud=0.3, dirt=1.3, dirt_color=0x4b3a27),
    "gun": dict(color=0x25252b, under=0xa6a6b0, metal=0.9, rough=0.36, wear=0.0, edge_light=0.7, streaks=0.2, dirt=0.6),
    "brass": dict(color=0xd9ad55, under=0xffe6a8, metal=1.0, rough=0.3, wear=0.0, edge_light=0.5, dirt_color=0x3b2a12, streaks=0.3, bump=0.15),
    "rivet": dict(color=0xcfa552, under=0xffe6a8, metal=1.0, rough=0.32, wear=0.0, edge_light=0.4, dirt=0.5, dirt_color=0x3b2a12, streaks=0.0, bump=0.0),
    "copper": dict(color=0xbd6c3c, under=0xf0a070, metal=1.0, rough=0.34, wear=0.0, edge_light=0.5, dirt=1.1, dirt_color=0x3f7566, streaks=0.5, bump=0.2),
    "wood": dict(color=0x7a5230, under=0xb08a58, under_metal=0.0, under_rough=0.8, rough=0.75, wear=0.6, wood=True, bump=0.2),
    "canvas": dict(color=0xb7a57a, rough=0.95, wear=0.0, bump=0.9, bump_scale=320.0, streaks=0.6),
    "soot": dict(color=0x120e0b, rough=0.95, wear=0.0, dirt=0.3),
    "amber": dict(color=0xffab3d, glow=1.0, wear=0.0, dirt=0.0, streaks=0.0, vary=0.0),
    "fire": dict(color=0xff7a22, glow=1.0, wear=0.0, dirt=0.0, streaks=0.0, vary=0.0),
}

kitmod.reset_scene()
K = Kit(MATERIALS)

# ====================================================================== coque
K.use("hull")
ROADS = [-0.36, -0.18, 0.0, 0.18, 0.36]
WHEELS = [(-0.50, 0.215, 0.10), (0.53, 0.20, 0.09)] + [(y, 0.087, 0.065) for y in ROADS]

for s in (1, -1):
    ax = "x" if s > 0 else "-x"
    K.track(s * 0.27, s * 0.53, WHEELS, "track", th=0.022, links=40)
    # galets, barbotin (à l'arrière), roue folle : la jante, le voile en creux, un moyeu de laiton
    for y, z, r in WHEELS:
        big = r > 0.08
        K.lathe([(0, -0.09), (r, -0.09), (r, 0.068), (r * 0.86, 0.074), (r * 0.8, 0.05), (r * 0.42, 0.05), (r * 0.34, 0.078), (0, 0.078)],
                (s * 0.42, y, z), "iron", seg=12, axis=ax)
        K.lathe([(r * 0.3, 0.078), (r * 0.26, 0.092), (0, 0.095)], (s * 0.42, y, z), "brass", seg=8, axis=ax)
        for i in range(6 if big else 5):
            a = 2 * PI * i / (6 if big else 5)
            K.rivet((s * (0.42 + 0.05), y + r * 0.62 * math.cos(a), z + r * 0.62 * math.sin(a)), (s, 0, 0), 0.008)
        if big:
            # les dents
            for i in range(10):
                a = 2 * PI * (i + 0.5) / 10
                K.box(0.03, 0.03, 0.025, (s * 0.5, y + (r + 0.004) * math.cos(a), z + (r + 0.004) * math.sin(a)), "iron",
                      rot=(a - PI / 2 if s > 0 else PI / 2 - a, 0, 0), center=True, detail=True)
    # balanciers de suspension entre les galets
    for y in (-0.27, 0.09):
        K.box(0.03, 0.22, 0.035, (s * 0.51, y, 0.1), "iron")
        K.box(0.034, 0.06, 0.07, (s * 0.51, y, 0.1), "iron")
    K.box(0.03, 0.04, 0.035, (s * 0.51, 0.36, 0.1), "iron")
    # le garde-boue : une tôle qui suit la chenille, ourlée de laiton
    prof = [(-0.6, 0.345), (0.50, 0.345), (0.62, 0.30), (0.67, 0.235)]
    K.strip_x(prof, s * 0.255, s * 0.455, 0.014, "armor_d")
    K.strip_x([(y, z + 0.004) for y, z in prof], s * 0.443, s * 0.461, 0.014, "brass", detail=True)
    K.rivets((s * 0.425, -0.57, 0.359), (s * 0.425, 0.48, 0.359), 18)
    # le panneau aux couleurs du camp, riveté aux angles
    K.box(0.105, 0.5, 0.011, (s * 0.355, 0.03, 0.359), "team", detail=True)
    for dx in (-0.04, 0.04):
        K.rivets((s * 0.355 + dx, -0.2, 0.37), (s * 0.355 + dx, 0.26, 0.37), 5, r=0.006)
    # phare de laiton sur l'avant du garde-boue
    K.box(0.02, 0.03, 0.03, (s * 0.37, 0.565, 0.33), "iron")
    K.lathe([(0, -0.04), (0.022, -0.036), (0.034, 0.0), (0.034, 0.012), (0.029, 0.012)], (s * 0.37, 0.6, 0.38), "brass", seg=10, axis="y")
    K.lathe([(0.029, 0.008), (0.018, 0.016), (0, 0.018)], (s * 0.37, 0.6, 0.38), "amber", seg=10, axis="y")
    # lanterne arrière
    K.box(0.03, 0.03, 0.04, (s * 0.4, -0.6, 0.31), "brass")
    K.box(0.02, 0.006, 0.024, (s * 0.4, -0.617, 0.318), "fire", detail=True)

# la caisse entre les chenilles, et sa proue en éperon coiffée de laiton
K.box(0.56, 1.07, 0.24, (0, 0, 0.075), "armor_d")
K.prism([(-0.28, 0.50), (0.28, 0.50), (0.0, 0.80)], 0.10, 0.30, "armor_d", top=[(-0.28, 0.50), (0.28, 0.50), (0.0, 0.83)])
K.prism([(-0.085, 0.725), (0.085, 0.725), (0.0, 0.82)], 0.09, 0.312, "brass", top=[(-0.085, 0.74), (0.085, 0.74), (0.0, 0.852)])
for s in (1, -1):
    K.rivets((s * 0.25, 0.545, 0.30), (s * 0.1, 0.705, 0.30), 6)
    for z in (0.14, 0.26):
        K.rivets((s * 0.262, 0.53, z), (s * 0.1, 0.705 + (z - 0.1) * 0.1, z), 6, n=(s * 0.73, 0.68, 0))
    # anneaux de remorquage
    K.torus(0.022, 0.007, (s * 0.2, 0.585, 0.2), "iron", seg=8, tseg=4, axis="x")

# le compartiment de combat : flancs en pente, glacis en étrave
B = [(-0.29, -0.20), (0.29, -0.20), (0.29, 0.30), (0.17, 0.52), (0.0, 0.62), (-0.17, 0.52), (-0.29, 0.30)]
T = [(-0.255, -0.17), (0.255, -0.17), (0.255, 0.26), (0.13, 0.40), (0.0, 0.45), (-0.13, 0.40), (-0.255, 0.26)]
Z0, Z1 = 0.31, 0.475
K.prism(B, Z0, Z1, "armor", top=T)


def side(i, j):
    """Repère de la face du compartiment entre les sommets i et j."""
    return quad_frame((*B[i], Z0), (*B[j], Z0), (*T[j], Z1), (*T[i], Z1))


for s, (i, j) in ((1, (1, 2)), (-1, (6, 0))):
    with K.on(side(i, j)):
        # la plaque de blindage rapportée, ses rivets, trois hublots au gaz
        K.box(0.46, 0.125, 0.006, (0, 0.0, 0), "armor", detail=True)
        for v in (-0.05, 0.05):
            K.rivets((-0.215, v, 0.006), (0.215, v, 0.006), 12, r=0.0062)
        for u in (-0.15, 0.0, 0.15):
            K.torus(0.026, 0.008, (u, 0, 0.008), "brass", seg=12, tseg=5, detail=True)
            K.lathe([(0.024, 0), (0.016, 0.008), (0, 0.01)], (u, 0, 0.004), "amber", seg=10, detail=True)
# le glacis : une fente de vision éclairée dans son cadre de laiton, de chaque côté de l'étrave
for i, j in ((3, 4), (4, 5)):
    with K.on(side(i, j)):
        K.box(0.15, 0.06, 0.008, (0, 0.012, 0), "armor_d", detail=True)
        K.box(0.085, 0.012, 0.011, (0, 0.012, 0), "amber", detail=True)
        for u in (-0.062, 0.062):
            K.rivets((u, -0.008, 0.008), (u, 0.032, 0.008), 2, r=0.006)
        K.rivets((-0.07, -0.05, 0), (0.07, -0.05, 0), 5)
for i, j in ((2, 3), (5, 6)):
    with K.on(side(i, j)):
        K.rivets((-0.1, 0.055, 0), (0.1, 0.055, 0), 6)
        K.rivets((-0.1, -0.055, 0), (0.1, -0.055, 0), 6)
        # un maillon de rechange boulonné
        for u in (-0.05, 0.0, 0.05):
            K.box(0.04, 0.07, 0.01, (u, 0, 0), "track", detail=True)
            K.box(0.036, 0.02, 0.014, (u, 0, 0), "track", detail=True)
# rivets autour du toit, l'anneau de la tourelle
for a, b in zip(T, T[1:] + T[:1]):
    ax_, ay_ = a[0] * 0.95, a[1] * 0.95 + 0.006
    bx_, by_ = b[0] * 0.95, b[1] * 0.95 + 0.006
    n = max(2, int(math.hypot(bx_ - ax_, by_ - ay_) / 0.04))
    K.rivets((ax_, ay_, Z1), (bx_, by_, Z1), n, r=0.006)
TC = (0.0, 0.10)  # l'axe de la tourelle
K.lathe([(0.268, 0), (0.268, 0.014), (0.25, 0.024), (0.2, 0.024)], (*TC, Z1), "iron", seg=18)

# la plage arrière : la machine. Grilles, chaudière de cuivre en travers, deux cheminées
D0, D1 = 0.31, 0.415
K.prism([(-0.29, -0.585), (0.29, -0.585), (0.29, -0.20), (-0.29, -0.20)], D0, D1, "armor",
        top=[(-0.262, -0.555), (0.262, -0.555), (0.262, -0.20), (-0.262, -0.20)])
for s in (1, -1):
    K.box(0.15, 0.13, 0.006, (s * 0.15, -0.275, D1), "soot", detail=True)
    for k in range(6):
        K.box(0.15, 0.009, 0.011, (s * 0.15, -0.325 + k * 0.02, D1), "iron", detail=True, rot=(0.5, 0, 0))
    K.box(0.17, 0.15, 0.004, (s * 0.15, -0.275, D1), "armor_d", detail=True)
    K.rivets((s * 0.15 - 0.078, -0.34, D1 + 0.004), (s * 0.15 - 0.078, -0.21, D1 + 0.004), 4, r=0.006)
    K.rivets((s * 0.15 + 0.078, -0.34, D1 + 0.004), (s * 0.15 + 0.078, -0.21, D1 + 0.004), 4, r=0.006)
BY, BZ, BR = -0.45, 0.455, 0.092
K.lathe([(0, -0.25), (BR * 0.6, -0.245), (BR * 0.92, -0.225), (BR, -0.2), (BR, 0.2), (BR * 0.92, 0.225), (BR * 0.6, 0.245), (0, 0.25)],
        (0, BY, BZ), "copper", seg=14, axis="x")
for x in (-0.19, -0.07, 0.07, 0.19):
    K.torus(BR + 0.002, 0.008, (x, BY, BZ), "brass", seg=14, tseg=5, axis="x", detail=True)
    for k in range(10):
        a = PI * k / 9
        K.rivet((x + 0.018, BY + (BR + 0.001) * math.cos(a), BZ + (BR + 0.001) * math.sin(a)), (0, math.cos(a), math.sin(a)), 0.005)
for s in (1, -1):
    K.rivet_ring((s * 0.249, BY, BZ), 0.0, 1)
    for k in range(8):
        a = 2 * PI * k / 8
        K.rivet((s * 0.238, BY + 0.062 * math.cos(a), BZ + 0.062 * math.sin(a)), (s, 0, 0), 0.006)
    # berceaux
    K.box(0.03, 0.2, 0.05, (s * 0.13, BY, D1 - 0.005), "iron")
    # cheminée : fût de fer noirci, bagues de laiton, couronne évasée pleine de suie
    sx, sy = s * 0.15, BY - 0.005
    K.lathe([(0.05, 0.0), (0.05, 0.02), (0.04, 0.035), (0.037, 0.2), (0.04, 0.215), (0.058, 0.265), (0.06, 0.285), (0.05, 0.29)],
            (sx, sy, BZ + BR - 0.02), "iron", seg=12)
    K.lathe([(0.049, 0.288), (0.03, 0.262), (0, 0.26)], (sx, sy, BZ + BR - 0.02), "soot", seg=12, fix=True)
    for z in (0.075, 0.2):
        K.torus(0.041, 0.007, (sx, sy, BZ + BR - 0.02 + z), "brass", seg=12, tseg=5, detail=True)
    K.torus(0.06, 0.006, (sx, sy, BZ + BR - 0.02 + 0.28), "brass", seg=12, tseg=5, detail=True)
# dôme de vapeur, soupape, et le tuyau de cuivre qui plonge dans le pont
K.lathe([(0.045, 0), (0.045, 0.03), (0.036, 0.052), (0.018, 0.064), (0, 0.066)], (0, BY, BZ + BR - 0.012), "brass", seg=10)
K.cyl(0.008, 0.035, (0, BY, BZ + BR + 0.05), "brass", seg=6)
K.box(0.012, 0.07, 0.008, (0, BY - 0.02, BZ + BR + 0.08), "iron")
K.pipe([(0.0, BY + 0.03, BZ + BR + 0.02), (0.0, BY + 0.12, BZ + BR + 0.035), (0.0, BY + 0.17, BZ + 0.04), (0.0, BY + 0.17, D1 - 0.01)],
       0.014, "copper", seg=6, round_=0.04)
for s in (1, -1):
    K.pipe([(s * 0.215, BY + 0.06, BZ + 0.02), (s * 0.235, BY + 0.14, BZ + 0.0), (s * 0.235, BY + 0.23, BZ - 0.02), (s * 0.235, BY + 0.23, D1 - 0.01)],
           0.011, "copper", seg=5, round_=0.03)
# la porte du foyer, à l'arrière : le feu derrière ses barreaux
with K.on(frame((0, -0.536, 0.2), (0, -1, 0))):
    K.box(0.2, 0.11, 0.008, (0, 0, 0), "iron", detail=True)
    K.box(0.15, 0.065, 0.011, (0, 0, 0), "fire", detail=True)
    for u in (-0.05, -0.025, 0.0, 0.025, 0.05):
        K.box(0.008, 0.075, 0.016, (u, 0, 0), "iron", detail=True)
    for u in (-0.09, 0.09):
        K.rivets((u, -0.04, 0.008), (u, 0.04, 0.008), 3, r=0.006)
K.torus(0.025, 0.008, (0, -0.55, 0.11), "iron", seg=8, tseg=4, axis="x")

# le barda, sur les garde-boue : caisse cerclée de fer, tonneau, rouleau de cordage, coffre à outils
K.box(0.13, 0.17, 0.09, (-0.37, -0.44, 0.359), "wood")
for y in (-0.49, -0.39):
    K.box(0.136, 0.016, 0.094, (-0.37, y, 0.359), "iron", detail=True)
K.lathe([(0.045, 0), (0.056, 0.03), (0.06, 0.065), (0.056, 0.1), (0.045, 0.13)], (0.37, -0.46, 0.359), "wood", seg=10)
for z in (0.025, 0.105):
    K.torus(0.056, 0.006, (0.37, -0.46, 0.359 + z), "brass", seg=10, tseg=4, detail=True)
K.torus(0.045, 0.016, (-0.365, 0.41, 0.372), "canvas", seg=12, tseg=5)
K.torus(0.03, 0.014, (-0.365, 0.41, 0.392), "canvas", seg=10, tseg=5)
K.box(0.12, 0.11, 0.055, (0.365, 0.4, 0.359), "armor_d", top=(0.12, 0.1))
K.box(0.03, 0.006, 0.02, (0.365, 0.343, 0.385), "brass", detail=True)
K.box(0.126, 0.012, 0.004, (0.365, 0.4, 0.414), "brass", detail=True)

# ==================================================================== tourelle
K.use("turret")
TZ = Z1 + 0.014
C = (TC[0], TC[1], TZ)
at = lambda x, y, z: (C[0] + x, C[1] + y, C[2] + z)  # noqa: E731
# le corps : tambour de fonte, épaule arrondie, toit bombé
K.lathe([(0.243, 0.0), (0.248, 0.015), (0.244, 0.1), (0.232, 0.128), (0.2, 0.15), (0.15, 0.162), (0.0, 0.17)], C, "armor", seg=18)
K.rivet_ring(at(0, 0, 0.012), 0.249, 36, radial=True)
K.rivet_ring(at(0, 0, 0.142), 0.215, 30, r=0.006)
# plaques cintrées rapportées, deux aux couleurs du camp ; l'avant reste au masque
for k in range(6):
    a = PI / 2 + PI * 2 * (k + 1) / 7
    team = k in (1, 4)
    K.lathe([(0.244, 0.03), (0.254, 0.034), (0.252, 0.1), (0.242, 0.104)], C, "team" if team else "armor", seg=5, hs=10,
            arc=(a - 0.36, a + 0.36), closed=True, detail=True)
    for da in (-0.3, 0.3):
        for z in (0.044, 0.09):
            K.rivet(at(0.253 * math.cos(a + da), 0.253 * math.sin(a + da), z), (math.cos(a + da), math.sin(a + da), 0), 0.006)
# l'anneau de couleur du toit, et le champignon d'aération au centre
K.lathe([(0.198, 0.147), (0.2, 0.155), (0.15, 0.167), (0.06, 0.1735), (0.06, 0.165), (0.15, 0.158)], C, "team", seg=18, closed=True, detail=True)
K.lathe([(0.022, 0), (0.022, 0.02), (0.05, 0.022), (0.044, 0.036), (0, 0.042)], at(0, 0, 0.166), "brass", seg=10)
# le masque et les deux canons : manchon de culasse, frein en laiton, tube, bourrelet de bouche
K.box(0.37, 0.13, 0.15, at(0, 0.215, 0.006), "armor_d", top=(0.33, 0.09), shift=(0, -0.012))
K.rivets(at(-0.17, 0.283, 0.03), at(-0.155, 0.268, 0.145), 4, n=(-0.4, 0.9, 0.2))
K.rivets(at(0.17, 0.283, 0.03), at(0.155, 0.268, 0.145), 4, n=(0.4, 0.9, 0.2))
GZ = 0.08
for x in (-0.098, 0.098):
    y0 = 0.26
    K.lathe([(0.06656, 0), (0.06656, 0.1), (0.05888, 0.115), (0.05888, 0.15)], at(x, y0, GZ), "gun", seg=10, axis="y")
    K.lathe([(0.07168, 0.02), (0.07168, 0.04), (0.064, 0.04), (0.064, 0.02)], at(x, y0, GZ), "brass", seg=10, axis="y", closed=True, detail=True)
    K.lathe([(0.06272, 0.115), (0.06272, 0.14), (0.05632, 0.14), (0.05632, 0.115)], at(x, y0, GZ), "brass", seg=10, axis="y", closed=True, detail=True)
    K.cyl(0.045, 0.37, at(x, y0 + 0.15, GZ), "gun", seg=10, axis="y", r1=0.0385)
    K.lathe([(0.04992, 0.3), (0.04992, 0.32), (0.0384, 0.32), (0.0384, 0.3)], at(x, y0, GZ), "brass", seg=10, axis="y", closed=True, detail=True)
    K.lathe([(0.0384, 0.5), (0.05504, 0.515), (0.0576, 0.56), (0.0512, 0.575), (0.03072, 0.575), (0.02816, 0.54), (0, 0.54)], at(x, y0, GZ), "gun", seg=10, axis="y")
    K.lathe([(0.02816, 0.541), (0, 0.541)], at(x, y0, GZ), "soot", seg=10, axis="y", detail=True)
    # cylindre de recul, au-dessus
    K.cyl(0.018, 0.2, at(x, y0 - 0.01, GZ + 0.078), "brass", seg=6, axis="y")
    K.cyl(0.008, 0.08, at(x, y0 + 0.19, GZ + 0.078), "gun", seg=5, axis="y")
    K.box(0.02, 0.02, 0.05, at(x, y0 + 0.26, GZ + 0.02), "gun")
# la coupole du chef : laiton, une fente éclairée tout autour
CU = at(0.115, -0.085, 0.152)
K.lathe([(0.066, 0), (0.066, 0.034), (0.058, 0.05), (0.036, 0.062), (0, 0.066)], CU, "brass", seg=12)
K.lathe([(0.0672, 0.014), (0.0672, 0.026), (0.06, 0.026), (0.06, 0.014)], CU, "amber", seg=12, closed=True, detail=True)
K.rivet_ring((CU[0], CU[1], CU[2] + 0.048), 0.05, 10, r=0.005, mat="gun")
K.box(0.012, 0.05, 0.012, (CU[0], CU[1], CU[2] + 0.064), "gun")
# le projecteur
SL = at(-0.125, 0.07, 0.15)
K.box(0.016, 0.03, 0.05, SL, "gun")
K.lathe([(0, -0.03), (0.03, -0.026), (0.045, 0.02), (0.045, 0.034), (0.038, 0.034)], (SL[0], SL[1], SL[2] + 0.075), "brass", seg=10, axis="y")
K.lathe([(0.038, 0.03), (0.022, 0.04), (0, 0.042)], (SL[0], SL[1], SL[2] + 0.075), "amber", seg=10, axis="y")
# le télémètre : un tube en travers, deux boîtiers à lentille qui dépassent de la tourelle
K.cyl(0.019, 0.62, at(-0.31, -0.165, 0.2), "gun", seg=8, axis="x")
for s in (1, -1):
    K.box(0.05, 0.06, 0.055, at(s * 0.305, -0.16, 0.172), "brass", top=(0.042, 0.05))
    K.lathe([(0.017, 0), (0.01, 0.006), (0, 0.007)], at(s * 0.305, -0.13, 0.2), "amber", seg=8, axis="y", detail=True)
    K.box(0.02, 0.03, 0.075, at(s * 0.14, -0.165, 0.125), "gun")
    K.torus(0.021, 0.006, at(s * 0.2, -0.165, 0.2), "brass", seg=8, tseg=4, axis="x", detail=True)
# la nuque : un coffre, la bâche roulée sanglée dessus
K.box(0.28, 0.11, 0.09, at(0, -0.275, 0.02), "armor", top=(0.26, 0.09), shift=(0, 0.008))
K.rivets(at(-0.12, -0.331, 0.035), at(0.12, -0.331, 0.035), 7, n=(0, -1, 0))
K.rivets(at(-0.12, -0.329, 0.095), at(0.12, -0.329, 0.095), 7, n=(0, -1, 0))
K.lathe([(0, -0.125), (0.03, -0.12), (0.034, 0), (0.03, 0.12), (0, 0.125)], at(0, -0.275, 0.142), "canvas", seg=8, axis="x")
for x in (-0.07, 0.07):
    K.torus(0.034, 0.006, at(x, -0.275, 0.142), "armor_d", seg=8, tseg=4, axis="x", detail=True)
# trappe du chargeur
K.lathe([(0.055, 0), (0.055, 0.008), (0.045, 0.012), (0, 0.013)], at(-0.1, -0.085, 0.156), "armor_d", seg=10, detail=True)
K.rivet_ring(at(-0.1, -0.085, 0.165), 0.046, 8, r=0.005)
K.box(0.012, 0.04, 0.012, at(-0.1, -0.085, 0.168), "gun", detail=True)
# la flamme du camp, au bout de sa hampe
MX, MY = 0.2, -0.23
K.cyl(0.006, 0.34, at(MX, MY, 0.1), "brass", seg=5)
K.sphere(0.012, at(MX, MY, 0.445), "brass", seg=6, rings=4)
f0, f1, f2 = at(MX, MY, 0.43), at(MX, MY, 0.33), at(MX + 0.02, MY - 0.2, 0.37)
K.rings([[(p[0] - 0.003, p[1], p[2]) for p in (f0, f1, f2)], [(p[0] + 0.003, p[1], p[2]) for p in (f0, f1, f2)]], "team")

# ====================================================================== sortie
tris = K.build()
kitmod.unwrap(K.low)
os.makedirs(OUT, exist_ok=True)
kitmod.bake(K, RAW, res=RES, samples=8 if FAST else 32, extrusion=0.02, ray=0.05)
kitmod.export(K, os.path.join(OUT, "creusot.glb"), {"turret": C})
MUZZLE = (0.0, 0.26 + 0.575, GZ)
print(f"[creusot] {tris} triangles ; pivot tourelle (Blender) {C} ; bouche {MUZZLE}")
