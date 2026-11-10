"""L'Empire de Carbonie : ce que ses machines partagent. Fer noir de suie riveté, chaudières cerclées,
charbon, cheminées à la gorge rougie et foyers qui luisent, un laiton terne pour les seules garnitures."""
import math

from common import PI
from kit import xf

EMP = {
    "fer": dict(color=0x2b2725, under=0x8f8a84, metal=0.55, rough=0.6, wear=0.0, edge_light=0.45, mud=0.14, dirt_color=0x1a1512, bump=0.4),
    "fer_m": dict(color=0x4a423b, under=0xa09a92, metal=0.5, rough=0.6, wear=0.0, edge_light=0.45, mud=0.14, dirt_color=0x1a1512, bump=0.4),
    "rivet_e": dict(color=0x8a7c6a, under=0xc8bca8, metal=0.8, rough=0.45, wear=0.0, edge_light=0.4, dirt=0.5, streaks=0.0, bump=0.0),
    "laiton_t": dict(color=0xa8843e, under=0xe0c080, metal=1.0, rough=0.45, wear=0.0, edge_light=0.45, dirt_color=0x2a1e0e, dirt=1.1, streaks=0.4, bump=0.2),
    "acier": dict(color=0x8f959b, under=0xd0d4d8, metal=0.85, rough=0.35, wear=0.0, edge_light=0.5, dirt=0.7),
    "sac": dict(color=0x4a4034, rough=0.95, wear=0.0, bump=0.9, bump_scale=300.0),
    "peau": dict(color=0xd8ae90, rough=0.7, wear=0.0, dirt=0.4, streaks=0.0),
}


def rivets_e(K, a, b, n, normal=(0, 0, 1), r=0.007):
    K.rivets(a, b, n, n=normal, r=r, mat="rivet_e")


def iron_wheel(K, c, r, w, side=1, n=8, seg=12):
    """Roue de route en fer, d'axe X : bandage à crampons, jante, rais plats, moyeu de laiton terne."""
    ax = "x" if side > 0 else "-x"
    K.lathe([(r, -w / 2), (r, w / 2), (r * 0.84, w / 2), (r * 0.84, -w / 2)], c, "fer", seg=seg, axis=ax, closed=True)
    K.lathe([(r * 0.84, -w * 0.36), (r * 0.84, w * 0.36), (r * 0.72, w * 0.3), (r * 0.72, -w * 0.3)], c, "fer_m", seg=seg, axis=ax, closed=True)
    for i in range(n):
        a = 2 * PI * i / n
        K.box(w * 0.3, r * 0.13, r * 0.56, (c[0], c[1] + r * 0.46 * math.cos(a), c[2] + r * 0.46 * math.sin(a)), "fer", rot=(a - PI / 2, 0, 0), center=True)
        # les crampons du bandage, dans la texture
        K.box(w * 0.9, r * 0.08, r * 0.05, (c[0], c[1] + r * 1.0 * math.cos(a + 0.2), c[2] + r * 1.0 * math.sin(a + 0.2)), "fer_m", rot=(a + 0.2 - PI / 2, 0, 0), center=True, detail=True)
    K.lathe([(0, -w * 0.55), (r * 0.28, -w * 0.5), (r * 0.3, w * 0.4), (r * 0.16, w * 0.6), (r * 0.13, w * 0.75), (0, w * 0.78)], c, "laiton_t", seg=8, axis=ax)


def e_stack(K, base, r, h, seg=10):
    """Cheminée de fer : une bague de laiton terne, la couronne évasée pleine de suie, la gorge rougie."""
    K.lathe([(r * 1.25, 0), (r * 1.12, h * 0.06), (r, h * 0.8), (r * 1.1, h * 0.86), (r * 1.7, h * 1.02), (r * 1.72, h * 1.08), (r * 1.4, h * 1.1)], base, "fer", seg=seg)
    K.lathe([(r * 1.38, h * 1.102), (0, h * 1.104)], base, "fire", seg=seg, fix=True)
    K.torus(r * 1.06, r * 0.2, (base[0], base[1], base[2] + h * 0.3), "laiton_t", seg=seg, tseg=4, detail=True)
    K.torus(r * 1.7, r * 0.14, (base[0], base[1], base[2] + h * 1.06), "soot", seg=seg, tseg=4, detail=True)


def boiler(K, at, r, h, face=(0, -1), seg=14):
    """Chaudière verticale posée sur `at` : fer cerclé, couronnes de rivets, dôme, la porte du foyer qui luit vers `face` (x, y)."""
    x, y, z = at
    K.lathe([(r * 0.9, 0), (r, r * 0.12), (r, h - r * 0.15), (r * 0.9, h), (r * 0.5, h + r * 0.3), (0, h + r * 0.36)], at, "fer", seg=seg)
    for k in (0.2, 0.75):
        K.lathe([(r, h * k - 0.011), (r * 1.05, h * k - 0.008), (r * 1.05, h * k + 0.008), (r, h * k + 0.011)], at, "laiton_t", seg=seg, closed=True, detail=True)
        K.rivet_ring((x, y, z + h * k + 0.022), r * 1.005, 14, r=0.006, mat="rivet_e", radial=True)
    K.rivet_ring((x, y, z + h * 0.97), r * 0.93, 12, r=0.006, mat="rivet_e", radial=True)
    fx, fy = face
    from kit import frame
    with K.on(frame((x + fx * r * 1.002, y + fy * r * 1.002, z + h * 0.35), (fx, fy, 0))):
        K.box(r * 0.95, r * 0.75, 0.012, (0, 0, 0), "fer_m", detail=True)
        K.box(r * 0.7, r * 0.46, 0.015, (0, 0, 0), "fire", detail=True)
        for k in (-1, 0, 1):
            K.box(0.007, r * 0.5, 0.019, (k * r * 0.2, 0, 0), "soot", detail=True)
        for u in (-r * 0.42, r * 0.42):
            K.rivets((u, -r * 0.3, 0.012), (u, r * 0.3, 0.012), 3, r=0.005, mat="rivet_e")


def e_lamp(K, at, s=0.03, axis="y"):
    """Lampe à acétylène : un bidon de laiton terne, son capuchon de suie, la lentille ambrée."""
    x, y, z = at
    d = 1 if axis == "y" else -1
    K.lathe([(s * 0.55, -s * 0.5), (s * 0.5, s * 0.5), (s * 0.3, s * 0.7), (0, s * 1.2)], at, "laiton_t", seg=8)
    K.lathe([(s * 0.5, s * 0.5), (s * 0.25, s * 0.9), (0, s * 1.25)], at, "soot", seg=8, detail=True)
    K.lathe([(s * 0.42, 0), (s * 0.25, s * 0.12), (0, s * 0.15)], (x, y + d * s * 0.5, z), "amber", seg=8, axis="y" if d > 0 else "-y")


def coal_heap(K, x0, x1, y0, y1, z, n, s):
    """Un tas de charbon dans un bac, une braise dedans."""
    for i in range(n):
        u = ((i * 0.618) % 1) * (x1 - x0) + x0
        v = ((i * 0.382 + 0.17) % 1) * (y1 - y0) + y0
        K.box(s * 2, s * 1.7, s * 1.4, (u, v, z + (i % 3) * s * 0.4), "fire" if i == 2 else "coal", rot=(i * 0.7, i * 0.4, i * 1.3), center=True, top=(s * 1.3, s * 1.1))
