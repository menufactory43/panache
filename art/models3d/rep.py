"""La République : ce que ses véhicules partagent. Laque ivoire à filets noirs, nickel, verre biseauté,
bobinages de cuivre, roues à rayons de fil, étincelles bleu électrique."""
import math

from common import PI, STEEL
from kit import xf

REP = {
    "ivoire": dict(color=0xe6dcc0, under=0xa89c80, under_metal=0.0, under_rough=0.7, rough=0.32, wear=0.6, chips=0.2, edge_paint=0.12, vary=0.08, streaks=0.3),
    "ivoire_d": dict(color=0xc6b998, under=0xa89c80, under_metal=0.0, under_rough=0.7, rough=0.36, wear=0.6, chips=0.2, edge_paint=0.15, vary=0.08, streaks=0.3),
    "nickel": dict(color=0xd4d8dc, under=0xf6f8fa, metal=0.6, rough=0.26, wear=0.0, edge_light=0.3, dirt=0.7, dirt_color=0x30343a, streaks=0.15, bump=0.1),
    "nickel_d": dict(color=0x8c939b, under=0xd8dce0, metal=0.6, rough=0.36, wear=0.0, edge_light=0.4, dirt=0.8, dirt_color=0x282c30, streaks=0.2),
    "laque": dict(color=0x1c2129, under=STEEL, rough=0.22, wear=0.7, chips=0.15, edge_paint=1.6, vary=0.1, streaks=0.2),
    "pneu": dict(color=0x1a1a1c, rough=0.9, wear=0.0, mud=0.2, dirt=1.2, dirt_color=0x5a4a36, bump=0.6, bump_scale=200.0),
    "verre": dict(color=0x9cc8e8, glow=0.35, rough=0.1, wear=0.0, dirt=0.2, streaks=0.1, vary=0.05),
    "arc": dict(color=0xe4f6ff, glow=1.0, wear=0.0, dirt=0.0, streaks=0.0, vary=0.0),
    "peau": dict(color=0xe0b89a, rough=0.7, wear=0.0, dirt=0.4, streaks=0.0),
}


def wire_wheel(K, c, r, w, side=1, n=12, seg=14):
    """Roue à rayons de fil d'axe X : pneu noir, jante nickelée, rayons fins, moyeu de laiton."""
    ax = "x" if side > 0 else "-x"
    t = r * 0.17
    K.torus(r - t, t, c, "pneu", seg=seg, tseg=5, axis=ax, scale=(1, 1, w / (2 * t)))
    K.lathe([(r - t * 1.75, -w * 0.3), (r - t * 1.75, w * 0.3), (r - t * 2.2, w * 0.24), (r - t * 2.2, -w * 0.24)], c, "nickel", seg=seg, axis=ax, closed=True)
    for i in range(n // 2):
        a = PI * i / (n // 2) + 0.2
        K.box(w * 0.16, 0.007 * r / 0.11, (r - t * 2) * 2, c, "nickel", rot=(a, 0, 0), center=True)
    K.lathe([(0, -w * 0.55), (r * 0.2, -w * 0.5), (r * 0.22, 0), (r * 0.16, w * 0.6), (0, w * 0.75)], c, "brass", seg=8, axis=ax)


def driver(K, at, coat, cap, goggles=False):
    """Un conducteur assis, de la taille au képi, face à l'avant."""
    x, y, z = at
    K.box(0.1, 0.075, 0.11, (x, y, z - 0.055), coat, top=(0.085, 0.06))
    K.box(0.07, 0.06, 0.02, (x, y, z + 0.055), "ivoire")
    for s in (1, -1):
        K.box(0.026, 0.085, 0.026, (x + s * 0.055, y + 0.04, z + 0.012), coat, rot=(-0.5, 0, 0), center=True)
    K.sphere(0.03, (x, y + 0.005, z + 0.1), "peau", seg=8, rings=5)
    K.lathe([(0.033, 0), (0.035, 0.02), (0.02, 0.026), (0, 0.027)], (x, y + 0.002, z + 0.118), cap, seg=8)
    K.box(0.05, 0.03, 0.006, (x, y + 0.035, z + 0.116), cap)
    if goggles:
        K.box(0.052, 0.012, 0.014, (x, y + 0.03, z + 0.098), "nickel")


def carriage_lamp(K, at, s=0.03, axis="y"):
    """Lanterne de voiture sur sa patte : corps de laiton, chapeau de laque, la lentille à l'arc."""
    x, y, z = at
    K.lathe([(s * 0.6, -s * 0.55), (s * 0.55, s * 0.4), (s * 0.3, s * 0.55), (0, s * 1.15)], at, "brass", seg=8)
    K.lathe([(s * 0.5, s * 0.4), (s * 0.2, s * 0.8), (0, s * 1.2)], at, "laque", seg=8, detail=True)
    d = 1 if axis == "y" else -1
    K.lathe([(s * 0.42, 0), (s * 0.25, s * 0.12), (0, s * 0.15)], (x, y + d * s * 0.5, z), "arc", seg=8, axis="y" if d > 0 else "-y")


def insulator(K, at, s=0.02):
    """Trois jupes de porcelaine sur une tige de nickel."""
    x, y, z = at
    for i in range(3):
        K.lathe([(s * 0.5, 0), (s, s * 0.1), (s * 0.7, s * 0.5), (s * 0.5, s * 0.55)], (x, y, z + i * s * 0.6), "enamel", seg=8)
    K.cyl(s * 0.25, s * 2.3, (x, y, z), "nickel", seg=5)


def coal(K, lumps, glows, z0):
    """Le chargement : des blocs de charbon [(x, y, taille, hauteur)], du radium [(x, y, rayon)]."""
    for i, (x, y, s, up) in enumerate(lumps):
        K.box(s * 2, s * 1.8, s * 1.4, (x, y, z0 + up), "coal", rot=(i * 0.7, i * 0.4, i * 1.3), center=True, top=(s * 1.3, s * 1.2))
    for x, y, s in glows:
        K.lathe([(0, -s * 0.8), (s, 0), (s * 0.6, s * 0.9), (0, s * 1.4)], (x, y, z0 + 0.07), "radium", seg=5)
