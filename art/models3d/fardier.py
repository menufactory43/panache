"""Le Fardier (Harvester) : le chariot à vapeur de Cugnot devenu locomotive routière.

Chaudière verticale de cuivre et sa haute cheminée au-dessus de l'unique roue directrice, plate-forme
du chauffeur sous un dais aux couleurs du camp, tender à charbon entre deux grandes roues à rais, soc
de fer à dents de laiton. `cargo` : le tas de charbon, quelques braises, le radium qui luit.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, lamp, stack, start, wheel  # noqa: E402
from kit import frame, xf  # noqa: E402

K = start()
K.use("hull")
RW, RX, RY = 0.185, 0.27, -0.24  # les grandes roues arrière
BY = 0.3  # l'axe de la chaudière

# ------------------------------------------------- le châssis et les roues
for s in (1, -1):
    # longerons de chêne, leurs ferrures
    K.box(0.055, 0.96, 0.065, (s * 0.115, 0.0, 0.17), "wood")
    for y in (-0.42, -0.24, -0.05, 0.14, 0.33):
        K.box(0.062, 0.03, 0.07, (s * 0.115, y, 0.168), "iron", detail=True)
        K.rivet((s * 0.146, y, 0.205), (s, 0, 0), 0.006)
    wheel(K, (s * RX, RY, RW), RW, 0.075, side=s, spokes=12, felloe="team", seg=16)
K.cyl(0.022, 0.56, (-0.28, RY, RW), "iron", seg=6, axis="x")
for y in (-0.44, 0.1):
    K.box(0.3, 0.05, 0.05, (0, y, 0.175), "wood")
# la roue directrice sous la chaudière, dans sa fourche de fer ; deux cylindres de laiton l'entraînent
wheel(K, (0, BY + 0.07, 0.105), 0.105, 0.065, side=1, spokes=8, seg=12)
for s in (1, -1):
    K.box(0.014, 0.03, 0.16, (s * 0.05, BY + 0.07, 0.1), "iron")
    K.cyl(0.024, 0.11, (s * 0.085, BY - 0.02, 0.2), "brass", seg=8, axis="y")
    K.cyl(0.007, 0.07, (s * 0.085, BY + 0.085, 0.2), "gun", seg=5, axis="y")
    K.box(0.01, 0.014, 0.1, (s * 0.085, BY + 0.11, 0.105), "gun")
    K.pipe([(s * 0.085, BY - 0.02, 0.222), (s * 0.085, BY - 0.02, 0.26), (s * 0.06, BY - 0.02, 0.29)], 0.009, "copper", seg=5, round_=0.02)
K.box(0.13, 0.03, 0.02, (0, BY + 0.07, 0.255), "iron")

# -------------------------------------------------------------- la chaudière
BZ = 0.235
K.lathe([(0.1, 0), (0.138, 0.012), (0.138, 0.255), (0.128, 0.285), (0.09, 0.31), (0.0, 0.325)], (0, BY, BZ), "copper", seg=16)
K.lathe([(0.145, 0), (0.145, 0.03), (0.138, 0.036), (0.1, 0.036), (0.1, 0)], (0, BY, BZ - 0.012), "iron", seg=16, closed=True)
for z, m in ((0.06, "team"), (0.145, "brass"), (0.23, "team")):
    K.lathe([(0.138, z - 0.014), (0.146, z - 0.01), (0.146, z + 0.01), (0.138, z + 0.014)], (0, BY, BZ), m, seg=16, closed=True, detail=True)
    K.rivet_ring((0, BY, BZ + z), 0.1465, 20, r=0.0055, radial=True, phase=0.5)
K.rivet_ring((0, BY, BZ + 0.273), 0.132, 18, r=0.0055, radial=True)
# la porte du foyer côté chauffeur (le feu derrière ses barreaux), le manomètre, le niveau d'eau
with K.on(frame((0, BY - 0.139, BZ + 0.07), (0, -1, 0))):
    K.box(0.1, 0.085, 0.01, (0, 0, 0), "iron", detail=True)
    K.box(0.07, 0.05, 0.013, (0, 0, 0), "fire", detail=True)
    for u in (-0.02, 0.0, 0.02):
        K.box(0.007, 0.06, 0.017, (u, 0, 0), "iron", detail=True)
    for u in (-0.042, 0.042):
        K.rivets((u, -0.03, 0.01), (u, 0.03, 0.01), 2, r=0.0055)
with K.on(frame((0.06, BY - 0.127, BZ + 0.19), (0.42, -0.9, 0))):
    K.lathe([(0.026, 0), (0.026, 0.01), (0.02, 0.012), (0.02, 0)], (0, 0, 0), "brass", seg=10, closed=True, detail=True)
    K.lathe([(0.02, 0.008), (0, 0.008)], (0, 0, 0), "enamel", seg=10, detail=True)
    K.box(0.003, 0.016, 0.011, (0.003, 0.006, 0), "soot", detail=True, rot=(0, 0, 0.6))
K.cyl(0.006, 0.08, (-0.06, BY - 0.128, BZ + 0.15), "enamel", seg=5)
for z in (0.15, 0.23):
    K.box(0.02, 0.02, 0.012, (-0.06, BY - 0.13, BZ + z - 0.006), "brass")
# le dôme de vapeur, la soupape, la cheminée (son sommet : là où le jeu fait fumer le Fardier)
K.lathe([(0.06, 0), (0.06, 0.02), (0.05, 0.045), (0.03, 0.06), (0, 0.064)], (0.0, BY - 0.045, BZ + 0.3), "brass", seg=10)
K.cyl(0.007, 0.04, (0.0, BY - 0.045, BZ + 0.36), "brass", seg=5)
K.box(0.01, 0.07, 0.008, (0.0, BY - 0.06, BZ + 0.395), "iron")
stack(K, (0, BY + 0.045, BZ + 0.3), 0.036, 0.3)
K.pipe([(0.03, BY - 0.045, BZ + 0.33), (0.1, BY - 0.045, BZ + 0.33), (0.115, BY - 0.02, BZ + 0.2), (0.105, BY - 0.02, BZ + 0.08)], 0.01, "copper", seg=5, round_=0.03)
# lanternes de part et d'autre
for s in (1, -1):
    K.box(0.012, 0.012, 0.07, (s * 0.165, BY + 0.06, 0.24), "iron")
    lamp(K, (s * 0.165, BY + 0.075, 0.335), 0.03)

# ------------------------------------------------- la plate-forme et le dais
PY = 0.03
K.box(0.4, 0.27, 0.03, (0, PY, 0.235), "wood_l")
for x in (-0.15, -0.1, -0.05, 0.0, 0.05, 0.1, 0.15):
    K.box(0.004, 0.26, 0.004, (x + 0.025, PY, 0.262), "soot", detail=True)
K.rivets((-0.185, PY - 0.11, 0.265), (0.185, PY - 0.11, 0.265), 8, r=0.005, mat="iron")
K.rivets((-0.185, PY + 0.11, 0.265), (0.185, PY + 0.11, 0.265), 8, r=0.005, mat="iron")
# le siège de cuir, la barre de direction et son volant, le régulateur
K.box(0.2, 0.09, 0.05, (0, PY - 0.08, 0.265), "wood")
K.box(0.19, 0.085, 0.022, (0, PY - 0.08, 0.315), "leather", top=(0.17, 0.07))
K.pipe([(0.0, PY + 0.09, 0.265), (0.0, PY + 0.055, 0.4)], 0.008, "brass", seg=5)
K.torus(0.04, 0.008, (0.0, PY + 0.05, 0.41), "brass", seg=10, tseg=4, axis="y", scale=(1, 1, 1))
K.pipe([(0.13, PY + 0.07, 0.265), (0.13, PY + 0.03, 0.38)], 0.006, "iron", seg=4)
K.sphere(0.014, (0.13, PY + 0.026, 0.39), "brass", seg=6, rings=4)
# quatre montants de fer, le toit cambré aux couleurs du camp, ourlé de laiton
for x in (-0.18, 0.18):
    for y in (PY - 0.115, PY + 0.115):
        K.cyl(0.009, 0.325, (x, y, 0.262), "iron", seg=5)
        K.cyl(0.014, 0.02, (x, y, 0.262), "brass", seg=6)


def roof(y, w):
    return [(-w, y, 0.585), (w, y, 0.585), (w, y, 0.6), (w * 0.55, y, 0.625), (-w * 0.55, y, 0.625), (-w, y, 0.6)]


K.rings([roof(PY - 0.165, 0.225), roof(PY + 0.165, 0.225)], "team")
K.box(0.47, 0.35, 0.012, (0, PY, 0.577), "brass")
for s in (1, -1):
    K.rivets((s * 0.2, PY - 0.15, 0.606), (s * 0.2, PY + 0.15, 0.606), 7, r=0.006, n=(s * 0.3, 0, 1))
K.box(0.012, 0.33, 0.01, (0, PY, 0.622), "brass", detail=True)

# ------------------------------------------------------------- le tender
TY, TZ = -0.31, 0.2
K.box(0.4, 0.4, 0.035, (0, TY, TZ), "wood")
for sx, sy, w, d in ((1, 0, 0.028, 0.4), (-1, 0, 0.028, 0.4), (0, 1, 0.4, 0.028), (0, -1, 0.4, 0.028)):
    K.box(w, d, 0.19, (sx * 0.186, TY + sy * 0.186, TZ + 0.03), "armor")
    # la lisse de couleur sur le dessus
    K.box(w + 0.02 if sx else w + 0.02, d + 0.02 if sy else d + 0.02, 0.022, (sx * 0.186, TY + sy * 0.186, TZ + 0.218), "team")
K.box(0.34, 0.34, 0.004, (0, TY, TZ + 0.036), "soot", detail=True)
for s in (1, -1):
    with K.on(frame((s * 0.2005, TY, TZ + 0.125), (s, 0, 0))):
        K.box(0.32, 0.12, 0.005, (0, 0, 0), "armor", detail=True)
        K.rivets((-0.15, 0.05, 0.005), (0.15, 0.05, 0.005), 8, r=0.006)
        K.rivets((-0.15, -0.05, 0.005), (0.15, -0.05, 0.005), 8, r=0.006)
with K.on(frame((0, TY - 0.2005, TZ + 0.125), (0, -1, 0))):
    K.box(0.34, 0.12, 0.005, (0, 0, 0), "armor", detail=True)
    K.rivets((-0.16, 0.05, 0.005), (0.16, 0.05, 0.005), 8, r=0.006)
    K.rivets((-0.16, -0.05, 0.005), (0.16, -0.05, 0.005), 8, r=0.006)
    K.torus(0.022, 0.007, (0, -0.02, 0.012), "iron", seg=8, tseg=4, detail=True)
# la pelle du chauffeur, accrochée au flanc ; une lanterne rouge à l'arrière
K.box(0.01, 0.24, 0.012, (0.212, TY + 0.02, TZ + 0.19), "wood_l", rot=(0.15, 0, 0))
K.box(0.012, 0.07, 0.06, (0.212, TY - 0.13, TZ + 0.13), "iron", rot=(0.15, 0, 0))
K.box(0.03, 0.025, 0.04, (-0.15, TY - 0.212, TZ + 0.05), "brass")
K.box(0.02, 0.006, 0.024, (-0.15, TY - 0.226, TZ + 0.058), "fire", detail=True)

# ------------------------------------------------------------------ le soc
SY = BY + 0.2
K.strip_x([(SY - 0.03, 0.2), (SY + 0.02, 0.12), (SY + 0.07, 0.06), (SY + 0.13, 0.03)], -0.23, 0.23, 0.016, "iron")
K.strip_x([(SY - 0.034, 0.212), (SY - 0.01, 0.175)], -0.235, 0.235, 0.018, "brass", detail=True)
for x in (-0.19, -0.095, 0.0, 0.095, 0.19):
    K.lathe([(0.02, 0), (0.014, 0.03), (0, 0.065)], (x, SY + 0.12, 0.035), "brass", seg=4, rot=(-PI / 2 - 0.2, 0, 0))
for s in (1, -1):
    K.pipe([(s * 0.115, BY - 0.02, 0.19), (s * 0.15, SY - 0.02, 0.17)], 0.013, "iron", seg=5)
    K.rivets((s * 0.2, SY - 0.01, 0.18), (s * 0.2, SY + 0.06, 0.085), 3, n=(0, 0.6, 0.8), r=0.007)

# ------------------------------------------------------------ le chargement
K.use("cargo")
COAL = [(-0.1, -0.2, 0.05, 0.0), (0.08, -0.22, 0.055, 0.01), (-0.04, -0.31, 0.062, 0.03), (0.1, -0.37, 0.05, 0.0), (0.0, -0.43, 0.045, 0.0),
        (-0.11, -0.41, 0.045, 0.0), (0.02, -0.24, 0.05, 0.05), (-0.08, -0.29, 0.04, 0.07), (0.06, -0.31, 0.045, 0.07), (0.12, -0.19, 0.04, 0.0),
        (-0.12, -0.31, 0.045, 0.01), (0.12, -0.29, 0.042, 0.02), (0.03, -0.37, 0.05, 0.04), (-0.05, -0.38, 0.04, 0.05), (0.0, -0.3, 0.04, 0.1)]
for i, (x, y, s, up) in enumerate(COAL):
    K.box(s * 2, s * 1.8, s * 1.5, (x, y, TZ + 0.14 + up), "coal", rot=(i * 0.7, i * 0.4, i * 1.3), center=True, top=(s * 1.3, s * 1.2))
for x, y in ((-0.03, -0.2), (0.07, -0.42), (-0.12, -0.36)):
    K.box(0.022, 0.022, 0.016, (x, y, TZ + 0.215), "fire")
for x, y, s in ((0.03, -0.33, 0.032), (-0.07, -0.25, 0.026), (0.11, -0.24, 0.024)):
    K.lathe([(0, -s * 0.8), (s, 0), (s * 0.6, s * 0.9), (0, s * 1.4)], (x, y, TZ + 0.235), "radium", seg=5)

finish(K, "fardier")
