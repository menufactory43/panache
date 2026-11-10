"""Le Faucheux (Flak Crawler) : un faucheux de laiton et de fer.

Ventre de laiton riveté sous une carapace aux couleurs du camp, tête à deux yeux de gaz, six longues
pattes en échasses (cuisses de fer et leur piston, genoux de couleur, tibias de laiton), et sur le dos
une Gatling à six tubes pointée vers le ciel.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PI, finish, lamp, start  # noqa: E402
from kit import toward, xf  # noqa: E402
from mathutils import Vector  # noqa: E402

K = start()
K.use("hull")
CZ = 0.25  # le plan de joint entre le ventre et la carapace
SY = 1.3   # le corps est plus long que large

# ------------------------------------------------------------------ le corps
K.lathe([(0, -0.12), (0.08, -0.115), (0.15, -0.08), (0.2, -0.03), (0.215, 0.0)], (0, 0, CZ), "brass", seg=14, rot=(0, 0, 0), M=xf((0, 0, CZ), (0, 0, 0), (1, SY, 1)))
K.lathe([(0.215, 0.0), (0.225, 0.006), (0.225, 0.022), (0.212, 0.028)], (0, 0, CZ), "iron", seg=14, M=xf((0, 0, CZ), (0, 0, 0), (1, SY, 1)))
K.lathe([(0.212, 0.026), (0.19, 0.07), (0.14, 0.105), (0.07, 0.125), (0, 0.13)], (0, 0, CZ), "team", seg=14, M=xf((0, 0, CZ), (0, 0, 0), (1, SY, 1)))
for i in range(22):
    a = 2 * PI * i / 22
    K.rivet((0.226 * math.cos(a), 0.226 * SY * math.sin(a), CZ + 0.014), (math.cos(a), math.sin(a) / SY, 0), 0.007)
for i in range(12):
    a = 2 * PI * i / 12
    K.rivet((0.16 * math.cos(a), 0.16 * SY * math.sin(a), CZ - 0.072), (math.cos(a), math.sin(a), -1.2), 0.0065)
# l'arête de laiton sur le dos, deux nervures en travers (les plaques de la carapace)
dome = lambda u: math.sqrt(max(0.0, 1 - u * u))  # noqa: E731
K.strip_x([(0.268 * math.cos(a), CZ + 0.028 + 0.106 * math.sin(a) ** 0.8) for a in [PI * (0.06 + 0.88 * i / 10) for i in range(11)]], -0.013, 0.013, 0.012, "brass")
for y0 in (-0.13, 0.11):
    k = dome(y0 / 0.275)
    with K.on(xf((0, y0, 0), (0, 0, PI / 2))):
        K.strip_x([(0.206 * k * math.cos(a), CZ + 0.03 + 0.1 * k * math.sin(a) ** 0.8) for a in [PI * (0.05 + 0.9 * i / 10) for i in range(11)]], -0.008, 0.008, 0.008, "brass", detail=True)
# un hublot de gaz de chaque côté du ventre, la soupape dessous
for s in (1, -1):
    K.torus(0.03, 0.008, (s * 0.186, 0.0, CZ - 0.045), "brass", seg=10, tseg=4, axis="x", detail=True)
    K.lathe([(0.028, 0), (0.018, 0.008), (0, 0.01)], (s * 0.182, 0.0, CZ - 0.045), "amber", seg=8, axis="x" if s > 0 else "-x", detail=True)
K.lathe([(0.05, 0), (0.05, 0.02), (0.03, 0.035), (0, 0.035)], (0, 0, CZ - 0.118), "iron", seg=8, rot=(PI, 0, 0))
# la tête : un dôme de laiton, deux gros yeux de gaz, les palpes de fer
HY = 0.3
K.sphere(0.082, (0, HY, 0.235), "brass", seg=10, rings=6, scale=(1, 1.05, 0.8))
K.lathe([(0.06, 0), (0.07, 0.015), (0.07, 0.03), (0.06, 0.04)], (0, HY - 0.085, 0.235), "iron", seg=8, axis="y")
for s in (1, -1):
    lamp(K, (s * 0.04, HY + 0.055, 0.262), 0.03)
    K.pipe([(s * 0.03, HY + 0.06, 0.2), (s * 0.045, HY + 0.12, 0.15), (s * 0.03, HY + 0.15, 0.1)], 0.01, "iron", seg=4, r1=0.004, round_=0.02)
K.rivet_ring((0, HY, 0.298), 0.03, 6, r=0.005)

# ------------------------------------------------------------------ les pattes
PIVOTS = {}
for side in (1, -1):
    for i, ang in enumerate((-0.8, 0.0, 0.8)):
        name = f"leg{'R' if side > 0 else 'L'}{i}"
        dx, dz = side * math.cos(ang), math.sin(ang)
        H = Vector((dx * 0.18, -dz * 0.24, 0.23))
        N = Vector((dx * 0.36, -dz * 0.42, 0.48))
        F = Vector((dx * 0.52, -dz * 0.58, 0.01))
        K.use("hull")
        # l'épaule, sur le corps
        K.sphere(0.04, H, "iron", seg=8, rings=5)
        K.use(name)
        PIVOTS[name] = tuple(H)
        K.sphere(0.03, H, "gun", seg=6, rings=4)
        # la cuisse : une poutre de fer effilée, son piston de laiton dessous
        K.pipe([H, N], 0.026, "iron", seg=6, r1=0.02)
        d = (N - H).normalized()
        out = Vector((dx, -dz, 0)).normalized()
        low = (d.cross(out.cross(d))).normalized() * -0.03 + Vector((0, 0, -0.012))
        K.pipe([H + d * 0.05 + low, H + d * 0.19 + low], 0.014, "brass", seg=6)
        K.pipe([H + d * 0.19 + low, N - d * 0.02 + low * 0.4], 0.006, "gun", seg=4)
        # le genou aux couleurs du camp, cerclé de laiton
        K.sphere(0.046, N, "team", seg=8, rings=5)
        K.lathe([(0.03, 0), (0.03, 0.012), (0.016, 0.02), (0, 0.021)], N + out * 0.04, "brass", seg=6, M=xf(N + out * 0.04) @ toward(out))
        # le tibia de laiton, bagué de fer, et la griffe
        K.pipe([N, F + Vector((0, 0, 0.05))], 0.019, "brass", seg=6, r1=0.012)
        for f in (0.25, 0.55, 0.8):
            p = N.lerp(F + Vector((0, 0, 0.05)), f)
            dd = (F - N).normalized()
            K.lathe([(0.0225 - f * 0.006, -0.008), (0.0225 - f * 0.006, 0.008), (0.012, 0.008), (0.012, -0.008)], p, "iron", seg=6, closed=True, detail=True,
                    M=xf(p) @ toward(dd))
        K.lathe([(0.024, 0.065), (0.018, 0.04), (0.008, 0.0), (0, -0.002)], F, "gun", seg=5, fix=True)
        K.sphere(0.02, F + Vector((0, 0, 0.06)), "iron", seg=6, rings=4)

# ---------------------------------------------------------------- la tourelle
K.use("turret")
C = (0.0, -0.05, CZ + 0.125)
at = lambda x, y, z: (C[0] + x, C[1] + y, C[2] + z)  # noqa: E731
K.lathe([(0.115, -0.03), (0.118, 0.0), (0.112, 0.045), (0.095, 0.065), (0.06, 0.072), (0, 0.074)], C, "brass", seg=12)
K.rivet_ring(at(0, 0, 0.022), 0.117, 16, radial=True, r=0.006)
K.lathe([(0.062, 0.072), (0.062, 0.084), (0.04, 0.09), (0, 0.092)], at(0, -0.04, 0), "team", seg=10)
# le berceau et la Gatling, pointée haut : six tubes entre deux flasques de laiton, le chargeur à tambour, la manivelle
PITCH = 0.85
G = at(0, 0.03, 0.085)
for s in (1, -1):
    K.box(0.02, 0.09, 0.1, at(s * 0.062, 0.02, 0.03), "iron", top=(0.02, 0.05), shift=(0, 0.01))
with K.on(xf(G, (PITCH, 0, 0))):
    K.lathe([(0, -0.07), (0.045, -0.065), (0.052, -0.04), (0.052, 0.05), (0.04, 0.06)], (0, 0, 0), "gun", seg=10, axis="y")
    for k in range(6):
        a = 2 * PI * k / 6
        K.cyl(0.0125, 0.3, (0.03 * math.cos(a), 0.04, 0.03 * math.sin(a)), "gun", seg=5, axis="y")
    for y in (0.13, 0.3):
        K.lathe([(0.05, 0), (0.05, 0.022), (0.012, 0.022), (0.012, 0)], (0, y, 0), "brass", seg=10, axis="y", closed=True)
    K.lathe([(0.044, 0.34), (0.044, 0.35), (0, 0.35)], (0, 0, 0), "soot", seg=10, axis="y", detail=True)
    # le chargeur à tambour, sur le dessus
    K.lathe([(0.048, 0), (0.048, 0.03), (0.04, 0.036), (0, 0.037)], (0, 0.0, 0.05), "brass", seg=10)
    K.rivet_ring((0, 0.0, 0.086), 0.036, 6, r=0.005)
    # la manivelle
    K.pipe([(0.052, -0.02, 0), (0.085, -0.02, 0), (0.085, -0.02, -0.04), (0.105, -0.02, -0.04)], 0.007, "gun", seg=4)
    K.sphere(0.012, (0.11, -0.02, -0.04), "wood_l", seg=5, rings=3)
MUZZLE = (0, 0.03 + 0.35 * math.cos(PITCH), 0.085 + 0.35 * math.sin(PITCH))
lamp(K, at(0, -0.1, 0.05), 0.022, axis="-y")

finish(K, "faucheux", {"turret": C, **PIVOTS})
print("[faucheux] pivot", C, "bouche", MUZZLE)
