"""Kit de modèles « haute fidélité » pour Panache (Blender 5.x, sans interface).

Un modèle se décrit une seule fois, en primitives. Le kit en tire deux maillages :

- **bas** : ce que le jeu dessine (peu de triangles, les pièces de détail en moins) ;
- **haut** : le même, cylindres plus ronds, plus les détails (rivets, maillons,
  plaques, sangles…) qui ne vivront que dans les textures.

Puis il cuit le haut sur le bas (Cycles, « sélection vers actif ») : arêtes
arrondies (nœud Bevel), usure de la peinture sur les arêtes, crasse dans les
creux, occlusion, et il écrit un .glb sans matériau et les passes brutes en PNG
(pack.py en fait les trois textures du jeu).

Repère Blender : X à droite, Y vers l'avant (le nez), Z en haut. L'export glTF
le tourne en Y haut, nez vers -Z : le contrat de three/models.ts.
"""
import math
import os

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

PI = math.pi


def srgb(hex_):
    """0xRRGGBB (sRGB) -> (r, g, b, 1) linéaire."""
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(hex_ >> 16 & 255), lin(hex_ >> 8 & 255), lin(hex_ & 255), 1.0)


def xf(at=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    return Matrix.Translation(Vector(at)) @ Euler(rot).to_matrix().to_4x4() @ Matrix.Diagonal((*scale, 1))


AXIS = {"z": (0, 0, 0), "y": (-PI / 2, 0, 0), "x": (0, PI / 2, 0), "-y": (PI / 2, 0, 0), "-x": (0, -PI / 2, 0), "-z": (PI, 0, 0)}


def toward(n):
    """Rotation qui amène +Z sur n."""
    return Vector((0, 0, 1)).rotation_difference(Vector(n).normalized()).to_matrix().to_4x4()


# ------------------------------------------------------------ géométrie ---

def g_rings(rings, cap0=True, cap1=True):
    """Relie des anneaux de même taille (listes de points) ; un anneau d'un seul point est un sommet."""
    verts, faces, idx = [], [], []
    for r in rings:
        idx.append(list(range(len(verts), len(verts) + len(r))))
        verts += [Vector(p) for p in r]
    for a, b in zip(idx, idx[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        n = max(len(a), len(b))
        for i in range(n):
            j = (i + 1) % n
            if len(a) == 1:
                faces.append((a[0], b[i], b[j]))
            elif len(b) == 1:
                faces.append((a[i], a[j], b[0]))
            else:
                faces.append((a[i], a[j], b[j], b[i]))
    if cap0 and len(idx[0]) > 2:
        faces.append(tuple(reversed(idx[0])))
    if cap1 and len(idx[-1]) > 2:
        faces.append(tuple(idx[-1]))
    return verts, faces


def g_lathe(profile, seg, arc=None, closed=False):
    """Tour autour de Z : profile = [(rayon, z)…] ; rayon 0 = sommet. closed : le profil est une boucle
    (un anneau plein) ; arc=(a0, a1) : une portion seulement (une plaque cintrée)."""
    if arc is not None:
        a0, a1 = arc
        n = len(profile)
        verts, faces = [], []
        for i in range(seg + 1):
            a = a0 + (a1 - a0) * i / seg
            verts += [Vector((r * math.cos(a), r * math.sin(a), z)) for r, z in profile]
        for i in range(seg):
            for j in range(n if closed else n - 1):
                faces.append((i * n + j, i * n + (j + 1) % n, (i + 1) * n + (j + 1) % n, (i + 1) * n + j))
        if closed:
            faces.append(tuple(range(n)))
            faces.append(tuple(seg * n + j for j in range(n)))
        return verts, faces
    rings = []
    for r, z in profile:
        if r <= 1e-6:
            rings.append([(0, 0, z)])
        else:
            rings.append([(r * math.cos(2 * PI * i / seg), r * math.sin(2 * PI * i / seg), z) for i in range(seg)])
    if closed:
        return g_rings(rings + [rings[0]], False, False)
    return g_rings(rings)


def g_box(w, d, h, top=None, shift=(0, 0)):
    """Boîte centrée en XY, de z=0 à h ; top=(w, d) rétrécit le dessus, shift le décale."""
    tw, td = top or (w, d)
    sx, sy = shift
    q = lambda a, b, z, ox=0, oy=0: [(-a / 2 + ox, -b / 2 + oy, z), (a / 2 + ox, -b / 2 + oy, z), (a / 2 + ox, b / 2 + oy, z), (-a / 2 + ox, b / 2 + oy, z)]
    return g_rings([q(w, d, 0), q(tw, td, h, sx, sy)])


def g_prism(outline, z0, z1, top=None):
    """Contour [(x, y)…] extrudé de z0 à z1 ; top = autre contour (même nombre de points)."""
    return g_rings([[(x, y, z0) for x, y in outline], [(x, y, z1) for x, y in (top or outline)]])


def g_pipe(path, r, seg, r1=None):
    """Tube de rayon r le long d'une polyligne (r1 : rayon à l'arrivée)."""
    pts = [Vector(p) for p in path]
    rings = []
    up = Vector((0, 0, 1))
    prev_n = None
    for i, p in enumerate(pts):
        t = ((pts[min(i + 1, len(pts) - 1)] - p).normalized() if i < len(pts) - 1 else Vector()) + ((p - pts[i - 1]).normalized() if i else Vector())
        t.normalize()
        if prev_n is None:
            n = t.cross(up)
            if n.length < 1e-4:
                n = t.cross(Vector((1, 0, 0)))
        else:
            n = prev_n - t * prev_n.dot(t)
        n.normalize()
        prev_n = n
        b = t.cross(n)
        k = i / max(1, len(pts) - 1)
        rr = r + ((r1 if r1 is not None else r) - r) * k
        rings.append([p + (n * math.cos(2 * PI * j / seg) + b * math.sin(2 * PI * j / seg)) * rr for j in range(seg)])
    return g_rings(rings)


def g_torus(R, r, seg, tseg):
    verts, faces = [], []
    for i in range(seg):
        a = 2 * PI * i / seg
        for j in range(tseg):
            b = 2 * PI * j / tseg
            verts.append(Vector(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b))))
    for i in range(seg):
        for j in range(tseg):
            a, b = i * tseg + j, i * tseg + (j + 1) % tseg
            c, d = ((i + 1) % seg) * tseg + (j + 1) % tseg, ((i + 1) % seg) * tseg + j
            faces.append((a, b, c, d))
    return verts, faces


def hull2d(points):
    """Enveloppe convexe (sens trigonométrique)."""
    pts = sorted(set((round(a, 6), round(b, 6)) for a, b in points))
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 1e-9:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 1e-9:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def frame(center, normal, up=(0, 0, 1)):
    """Repère posé sur une face : Z local = la normale, Y local = le haut de la face."""
    zc = Vector(normal).normalized()
    xc = Vector(up).cross(zc)
    if xc.length < 1e-4:
        xc = Vector((1, 0, 0))
    xc.normalize()
    yc = zc.cross(xc)
    M = Matrix.Identity(4)
    for i in range(3):
        M[i][0], M[i][1], M[i][2], M[i][3] = xc[i], yc[i], zc[i], center[i]
    return M


def quad_frame(a, b, c, d):
    """Repère au centre d'un quadrilatère (a, b en bas ; c, d en haut), normale vers l'extérieur du sens a-b-c."""
    a, b, c, d = Vector(a), Vector(b), Vector(c), Vector(d)
    n = (b - a).cross(c - a).normalized()
    return frame((a + b + c + d) / 4, n)


def fillet(path, radius, n=4):
    """Arrondit les coudes d'une polyligne."""
    pts = [Vector(p) for p in path]
    out = [pts[0]]
    for a, p, c in zip(pts, pts[1:], pts[2:]):
        u, v = (a - p), (c - p)
        d = min(radius, u.length * 0.45, v.length * 0.45)
        p0, p1 = p + u.normalized() * d, p + v.normalized() * d
        for i in range(n + 1):
            k = i / n
            out.append((p0.lerp(p, k)).lerp(p.lerp(p1, k), k))
    out.append(pts[-1])
    return out


def offset_strip(profile, th):
    """Polyligne 2D épaissie de th (du côté gauche) -> contour fermé."""
    pts = [Vector((a, b)) for a, b in profile]
    out = []
    for i, p in enumerate(pts):
        d0 = (p - pts[i - 1]).normalized() if i else None
        d1 = (pts[i + 1] - p).normalized() if i < len(pts) - 1 else None
        n0 = Vector((-d0.y, d0.x)) if d0 else None
        n1 = Vector((-d1.y, d1.x)) if d1 else None
        n = (n0 + n1).normalized() if n0 and n1 else (n0 or n1)
        k = 1 / max(0.3, n.dot(n0 or n1))
        out.append(p + n * th * k)
    return [tuple(p) for p in pts] + [tuple(p) for p in reversed(out)]


def _fix(verts, faces):
    """Normales cohérentes vers l'extérieur."""
    bm = bmesh.new()
    vs = [bm.verts.new(v) for v in verts]
    for f in faces:
        try:
            bm.faces.new([vs[i] for i in f])
        except ValueError:
            pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.verts.index_update()
    out = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    return out


class Geo:
    def __init__(self):
        self.verts, self.faces, self.mats = [], [], []


class Kit:
    def __init__(self, materials, hi=3):
        self.materials = materials  # {nom: dict de réglages}, l'ordre fait l'indice
        self.mat_index = {n: i for i, n in enumerate(materials)}
        self.parts = {}
        self.part = None
        self.hi = hi
        self.base = Matrix.Identity(4)
        self.use("hull")

    def use(self, part):
        self.part = part
        self.parts.setdefault(part, {"low": Geo(), "high": Geo()})

    # -- dépôt d'une primitive --
    def put(self, make, mat, M, detail=False, low_only=False, fix=True):
        for q in ("low", "high"):
            if (q == "low" and detail) or (q == "high" and low_only):
                continue
            verts, faces = make(q == "high")
            if fix:
                faces = _fix(verts, faces)
            g = self.parts[self.part][q]
            base = len(g.verts)
            B = self.base @ M
            g.verts += [tuple(B @ Vector(v)) for v in verts]
            g.faces += [tuple(i + base for i in f) for f in faces]
            g.mats += [self.mat_index[mat]] * len(faces)

    def _seg(self, seg, hi, hs=None):
        return (hs or min(64, seg * self.hi)) if hi else seg

    def box(self, w, d, h, at, mat, rot=(0, 0, 0), top=None, shift=(0, 0), center=False, **kw):
        """Boîte posée sur `at` (son dessous), ou centrée si center."""
        M = xf(at, rot) @ (Matrix.Translation((0, 0, -h / 2)) if center else Matrix.Identity(4))
        self.put(lambda hi: g_box(w, d, h, top, shift), mat, M, **kw)

    def lathe(self, profile, at, mat, seg=12, axis="z", rot=None, hs=None, M=None, arc=None, closed=False, **kw):
        M = M if M is not None else xf(at, rot if rot is not None else AXIS[axis])
        if arc is not None or closed:
            kw.setdefault("fix", True)
        else:
            kw.setdefault("fix", profile[0][0] <= 1e-6)
        self.put(lambda hi: g_lathe(profile, self._seg(seg, hi, hs), arc, closed), mat, M, **kw)

    def on(self, M):
        """`with kit.on(repère):` : les primitives du bloc se placent dans ce repère."""
        kit = self

        class _On:
            def __enter__(s):
                s.prev = kit.base
                kit.base = kit.base @ M

            def __exit__(s, *a):
                kit.base = s.prev
        return _On()

    def cyl(self, r, h, at, mat, seg=12, axis="z", r1=None, **kw):
        """Cylindre de `at` (centre de sa base) sur h le long de l'axe ; r1 = rayon du bout."""
        self.lathe([(r, 0), (r if r1 is None else r1, h)], at, mat, seg, axis, **kw)

    def sphere(self, r, at, mat, seg=12, rings=6, half=False, scale=(1, 1, 1), **kw):
        n = rings
        a0 = 0 if half else -PI / 2
        prof = [(r * math.cos(a0 + (PI / 2 - a0) * i / n), r * math.sin(a0 + (PI / 2 - a0) * i / n)) for i in range(n + 1)]
        prof[-1] = (0, prof[-1][1])
        if not half:
            prof[0] = (0, prof[0][1])
        self.put(lambda hi: g_lathe(prof, self._seg(seg, hi)), mat, xf(at, (0, 0, 0), scale), **kw)

    def torus(self, R, r, at, mat, seg=16, tseg=6, axis="z", scale=(1, 1, 1), **kw):
        self.put(lambda hi: g_torus(R, r, self._seg(seg, hi), tseg * (2 if hi else 1)), mat, xf(at, AXIS[axis], scale), **kw)

    def prism(self, outline, z0, z1, mat, top=None, at=(0, 0, 0), rot=(0, 0, 0), **kw):
        self.put(lambda hi: g_prism(outline, z0, z1, top), mat, xf(at, rot), **kw)

    def rings(self, rings, mat, at=(0, 0, 0), rot=(0, 0, 0), **kw):
        self.put(lambda hi: g_rings(rings), mat, xf(at, rot), **kw)

    def pipe(self, path, r, mat, seg=6, r1=None, round_=0.0, **kw):
        p = fillet(path, round_) if round_ else path
        self.put(lambda hi: g_pipe(p, r, self._seg(seg, hi, 12), r1), mat, Matrix.Identity(4), **kw)

    def strip_x(self, profile_yz, x0, x1, th, mat, **kw):
        """Tôle : polyligne [(y, z)…] épaissie de th, extrudée de x0 à x1."""
        o = offset_strip(profile_yz, th)
        self.put(lambda hi: g_rings([[(x0, y, z) for y, z in o], [(x1, y, z) for y, z in o]]), mat, Matrix.Identity(4), **kw)

    def rivet(self, at, n=(0, 0, 1), r=0.007, mat="rivet"):
        prof = [(r, -r * 0.3), (r, 0), (r * 0.8, r * 0.45), (r * 0.42, r * 0.72), (0, r * 0.8)]
        self.put(lambda hi: g_lathe(prof, 8), mat, Matrix.Translation(Vector(at)) @ toward(n), detail=True, fix=False)

    def rivets(self, a, b, count, n=(0, 0, 1), r=0.007, mat="rivet"):
        a, b = Vector(a), Vector(b)
        for i in range(count):
            self.rivet(a.lerp(b, 0.5 if count == 1 else i / (count - 1)), n, r, mat)

    def rivet_ring(self, c, R, count, r=0.007, mat="rivet", radial=False, phase=0.0):
        for i in range(count):
            a = 2 * PI * (i + phase) / count
            p = (c[0] + R * math.cos(a), c[1] + R * math.sin(a), c[2])
            self.rivet(p, (math.cos(a), math.sin(a), 0) if radial else (0, 0, 1), r, mat)

    def track(self, x0, x1, wheels, mat, th=0.022, links=50):
        """Chenille autour de roues [(y, z, r)…], de x0 à x1 : une bande en bas, ses maillons en haut."""
        pts = [(y + (r + th) * math.cos(2 * PI * i / 16), z + (r + th) * math.sin(2 * PI * i / 16)) for y, z, r in wheels for i in range(16)]
        H = [Vector(p) for p in hull2d(pts)]
        n = len(H)
        norm = []
        for i, p in enumerate(H):
            d0, d1 = (p - H[i - 1]).normalized(), (H[(i + 1) % n] - p).normalized()
            norm.append((Vector((-d0.y, d0.x)) + Vector((-d1.y, d1.x))).normalized())

        def band(off, thick):
            rings = []
            for p, m in zip(H, norm):
                a, b = p + m * off, p + m * (off + thick)
                rings.append([(x0, a.x, a.y), (x1, a.x, a.y), (x1, b.x, b.y), (x0, b.x, b.y)])
            return g_rings(rings + [rings[0]], False, False)
        self.put(lambda hi: band(0.0, th), mat, Matrix.Identity(4), low_only=True)
        self.put(lambda hi: band(0.011, th - 0.011), mat, Matrix.Identity(4), detail=True)
        seg = [(H[(i + 1) % n] - H[i]).length for i in range(n)]
        L = sum(seg)
        pitch = L / links
        w = abs(x1 - x0)
        for k in range(links):
            s = (k + 0.5) * pitch
            i = 0
            while s > seg[i]:
                s -= seg[i]
                i += 1
            a, b = H[i], H[(i + 1) % n]
            p = a.lerp(b, s / seg[i])
            t = (b - a).normalized()
            m = Vector((-t.y, t.x))
            M = Matrix(((1, 0, 0, (x0 + x1) / 2), (0, t.x, -m.x, p.x + m.x * 0.012), (0, t.y, -m.y, p.y + m.y * 0.012), (0, 0, 0, 1)))
            self.put(lambda hi: g_box(w, pitch * 0.84, 0.008), mat, M, detail=True)
            self.put(lambda hi: g_box(w * 0.94, pitch * 0.3, 0.012), mat, M, detail=True)
            for sx in (-1, 1):
                self.put(lambda hi: g_box(w * 0.1, pitch * 0.6, 0.011), mat, M @ Matrix.Translation((sx * w * 0.36, 0, 0)), detail=True)

    # -- maillages Blender --
    def _mesh(self, name, geos, part_ids=None, tri=False):
        verts, faces, mats, parts = [], [], [], []
        for k, g in enumerate(geos):
            base = len(verts)
            verts += g.verts
            faces += [tuple(i + base for i in f) for f in g.faces]
            mats += g.mats
            parts += [part_ids[k] if part_ids else 0] * len(g.faces)
        me = bpy.data.meshes.new(name)
        me.from_pydata(verts, [], faces)
        me.polygons.foreach_set("material_index", mats)
        me.polygons.foreach_set("use_smooth", [True] * len(faces))
        a = me.attributes.new("part", "INT", "FACE")
        a.data.foreach_set("value", parts)
        me.update()
        if tri:
            bm = bmesh.new()
            bm.from_mesh(me)
            bmesh.ops.triangulate(bm, faces=bm.faces)
            bm.to_mesh(me)
            bm.free()
        me.set_sharp_from_angle(angle=math.radians(50))
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob

    def build(self):
        names = list(self.parts)
        self.low = self._mesh("low", [self.parts[n]["low"] for n in names], list(range(len(names))), tri=True)
        self.high = {n: self._mesh("high_" + n, [self.parts[n]["high"]]) for n in names}
        mats = [make_material(n, p) for n, p in self.materials.items()]
        for ob in self.high.values():
            for m in mats:
                ob.data.materials.append(m)
        self.mats = mats
        tris = sum(len(p.vertices) - 2 for p in self.low.data.polygons)
        print(f"[kit] bas : {tris} triangles ; haut : {sum(len(o.data.polygons) for o in self.high.values())} faces")
        return tris


# ------------------------------------------------------------ matériaux ---

class Graph:
    def __init__(self, tree):
        self.t, self.n, self.l = tree, tree.nodes, tree.links

    def node(self, typ, **kw):
        n = self.n.new(typ)
        for k, v in kw.items():
            setattr(n, k, v)
        return n

    def set(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.l.new(v, sock)
        elif isinstance(v, (int, float)) and sock.type in ("RGBA", "VECTOR"):
            sock.default_value = (v, v, v, 1)[: len(sock.default_value)]
        else:
            sock.default_value = v

    def math(self, op, a, b=None, clamp=False):
        n = self.node("ShaderNodeMath", operation=op, use_clamp=clamp)
        self.set(n.inputs[0], a)
        if b is not None:
            self.set(n.inputs[1], b)
        return n.outputs[0]

    def mix(self, f, a, b):
        n = self.node("ShaderNodeMix", data_type="RGBA")
        self.set(n.inputs[0], f)
        self.set(n.inputs[6], a)
        self.set(n.inputs[7], b)
        return n.outputs[2]

    def lerp(self, f, a, b):
        n = self.node("ShaderNodeMix", data_type="FLOAT")
        self.set(n.inputs[0], f)
        self.set(n.inputs[2], a)
        self.set(n.inputs[3], b)
        return n.outputs[0]

    def ramp(self, v, a, b, c=0.0, d=1.0):
        n = self.node("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP")
        for i, x in enumerate((v, a, b, c, d)):
            self.set(n.inputs[i], x)
        return n.outputs[0]

    def noise(self, vec, scale, detail=3.0, rough=0.55, stretch=None):
        if stretch:
            m = self.node("ShaderNodeMapping")
            self.l.new(vec, m.inputs[0])
            m.inputs[3].default_value = stretch
            vec = m.outputs[0]
        n = self.node("ShaderNodeTexNoise")
        self.l.new(vec, n.inputs["Vector"])
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough
        return n.outputs[0]


DEFAULTS = dict(
    color=0x808080, under=0x9a9690, rough=0.55, under_rough=0.32, metal=0.0, under_metal=1.0,
    wear=1.0, chips=0.25, edge_paint=0.0, dirt=1.0, dirt_color=0x2a2018, mud=0.0, streaks=0.5,
    team=0.0, glow=0.0, bump=0.3, bump_scale=140.0, vary=0.16, wood=False, edge_light=0.0
)

# Le dégradé de la peinture, plus claire en haut : de quelle hauteur à quelle hauteur (un aéronef descend sous zéro).
GRADE = [0.0, 0.7]
BEVEL = 0.008
WEAR_R = 0.022


def make_material(name, params):
    p = {**DEFAULTS, **params}
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    t = m.node_tree
    t.nodes.clear()
    g = Graph(t)
    geo = g.node("ShaderNodeNewGeometry")
    N, P = geo.outputs["Normal"], geo.outputs["Position"]
    z = g.node("ShaderNodeSeparateXYZ")
    t.links.new(P, z.inputs[0])
    Z = z.outputs[2]
    nz = g.node("ShaderNodeSeparateXYZ")
    t.links.new(N, nz.inputs[0])
    wall = g.math("SUBTRACT", 1.0, g.math("ABSOLUTE", nz.outputs[2]))

    bev = g.node("ShaderNodeBevel", samples=8)
    bev.inputs["Radius"].default_value = BEVEL
    bevw = g.node("ShaderNodeBevel", samples=8)
    bevw.inputs["Radius"].default_value = WEAR_R
    dot = g.node("ShaderNodeVectorMath", operation="DOT_PRODUCT")
    t.links.new(bevw.outputs[0], dot.inputs[0])
    t.links.new(N, dot.inputs[1])
    edge = g.math("MULTIPLY", g.math("SUBTRACT", 1.0, dot.outputs["Value"]), 3.4, clamp=True)

    ao = g.node("ShaderNodeAmbientOcclusion", samples=12, only_local=True)
    ao.inputs["Distance"].default_value = 0.1
    AO = ao.outputs["AO"]
    aow = g.node("ShaderNodeAmbientOcclusion", samples=12, only_local=True)
    aow.inputs["Distance"].default_value = 0.3
    convex = g.ramp(AO, 0.5, 0.78)

    n_big = g.noise(P, 7.0, 2.0)
    n_mid = g.noise(P, 26.0, 4.0, 0.6)
    n_fine = g.noise(P, 110.0, 3.0, 0.6)

    # usure : arêtes saillantes rongées, plus quelques éclats
    w_edge = g.ramp(g.math("MULTIPLY", g.math("MULTIPLY", edge, convex), g.math("ADD", 0.35, g.math("MULTIPLY", n_mid, 1.5))), 0.3, 0.62)
    w_chip = g.ramp(g.math("MULTIPLY", g.noise(P, 16.0, 3.0, 0.7), g.math("ADD", n_mid, 0.3)), 0.56, 0.6)
    wear = g.math("MULTIPLY", g.math("MAXIMUM", w_edge, g.math("MULTIPLY", w_chip, p["chips"])), p["wear"], clamp=True)

    # crasse : dans les creux, et la boue au bas du châssis
    cav = g.math("MULTIPLY", g.ramp(AO, 0.82, 0.3), g.math("ADD", 0.45, n_mid))
    mud = g.math("MULTIPLY", g.ramp(Z, p["mud"], 0.0), g.math("ADD", 0.3, n_big)) if p["mud"] else 0.0
    dirt = g.math("MULTIPLY", g.math("ADD", cav, mud), p["dirt"], clamp=True)

    # coulures sur les parois
    n_streak = g.noise(P, 1.0, 2.0, 0.5, stretch=(55.0, 55.0, 4.0))
    streak = g.math("MULTIPLY", g.math("MULTIPLY", g.ramp(n_streak, 0.52, 0.75), wall), p["streaks"] * 0.55)

    # la peinture : nuancée, plus claire en haut qu'en bas
    value = g.math("MULTIPLY", g.math("ADD", 1 - p["vary"] / 2, g.math("MULTIPLY", n_big, p["vary"])), g.ramp(Z, GRADE[0], GRADE[1], 0.72, 1.04))
    paint = g.node("ShaderNodeVectorMath", operation="SCALE")
    paint.inputs[0].default_value = srgb(p["color"])[:3]
    t.links.new(value, paint.inputs["Scale"])
    col = paint.outputs[0]
    if p["wood"]:
        grain = g.noise(P, 1.0, 3.0, 0.6, stretch=(120.0, 6.0, 120.0))
        col = g.mix(g.ramp(grain, 0.35, 0.7, 0.0, 0.45), col, srgb(0x2a1a0e))
    col = g.mix(streak, col, srgb(p["dirt_color"]))
    if p["edge_paint"]:
        # (peinture : l'arête éclaircie, le rehaut des textures peintes)
        lit = g.node("ShaderNodeVectorMath", operation="SCALE")
        t.links.new(col, lit.inputs[0])
        lit.inputs["Scale"].default_value = 1.0 + p["edge_paint"]
        col = g.mix(g.math("MULTIPLY", edge, convex, clamp=True), col, lit.outputs[0])
    if p["edge_light"]:
        # (métaux nus : l'arête polie par le frottement, plus claire)
        col = g.mix(g.math("MULTIPLY", g.math("MULTIPLY", edge, convex), p["edge_light"], clamp=True), col, srgb(p["under"]))
    col = g.mix(wear, col, srgb(p["under"]))
    col = g.mix(g.math("MULTIPLY", dirt, 0.85), col, srgb(p["dirt_color"]))

    rough = g.lerp(wear, g.math("ADD", p["rough"] - 0.06, g.math("MULTIPLY", n_fine, 0.12)), p["under_rough"])
    rough = g.lerp(dirt, rough, 0.92)
    metal = g.math("MULTIPLY", g.lerp(wear, p["metal"], p["under_metal"]), g.math("SUBTRACT", 1.0, g.math("MULTIPLY", dirt, 0.8)))
    team = g.math("MULTIPLY", p["team"], g.math("SUBTRACT", 1.0, wear)) if p["team"] else 0.0

    # relief : le grain du matériau, la peinture écaillée en creux, les arêtes arrondies
    height = g.math("SUBTRACT", g.math("MULTIPLY", g.noise(P, p["bump_scale"], 2.0), p["bump"]), g.math("MULTIPLY", wear, 0.6))
    if p["wood"]:
        height = g.math("ADD", height, g.math("MULTIPLY", grain, 0.8))
    bump = g.node("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.5
    bump.inputs["Distance"].default_value = 0.0025
    t.links.new(height, bump.inputs["Height"])
    t.links.new(bev.outputs[0], bump.inputs["Normal"])

    def rgb(r, gg, b):
        c = g.node("ShaderNodeCombineColor")
        for i, v in enumerate((r, gg, b)):
            g.set(c.inputs[i], v)
        return c.outputs[0]

    outs = {"color": col, "orm": rgb(aow.outputs["AO"], rough, metal), "extra": rgb(team, p["glow"], wear)}
    em = g.node("ShaderNodeEmission")
    bsdf = g.node("ShaderNodeBsdfPrincipled")
    t.links.new(bump.outputs[0], bsdf.inputs["Normal"])
    out = g.node("ShaderNodeOutputMaterial")
    m["_kit"] = 1
    m_passes[name] = (t, outs, em, bsdf, out)
    return m


m_passes = {}


def set_pass(name):
    for t, outs, em, bsdf, out in m_passes.values():
        for l in list(out.inputs["Surface"].links):
            t.links.remove(l)
        if name == "normal":
            t.links.new(bsdf.outputs[0], out.inputs["Surface"])
        else:
            for l in list(em.inputs["Color"].links):
                t.links.remove(l)
            t.links.new(outs[name], em.inputs["Color"])
            t.links.new(em.outputs[0], out.inputs["Surface"])


# ----------------------------------------------------------------- cuisson ---

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    m_passes.clear()
    GRADE[:] = [0.0, 0.7]


def unwrap(low, margin=0.003):
    bpy.context.view_layer.objects.active = low
    low.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake(kit, out_dir, res=2048, samples=24, extrusion=0.014, ray=0.045):
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = "GPU"
    except Exception as e:  # noqa: BLE001
        print("[kit] pas de GPU :", e)
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    low = kit.low
    mat = bpy.data.materials.new("bake")
    mat.use_nodes = True
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    mat.node_tree.nodes.active = tex
    low.data.materials.append(mat)
    low.data.polygons.foreach_set("material_index", [0] * len(low.data.polygons))
    bpy.ops.object.select_all(action="DESELECT")
    for ob in kit.high.values():
        ob.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    for name in ("color", "orm", "extra", "normal"):
        img = bpy.data.images.new(name, res, res, alpha=False, is_data=name != "color")
        tex.image = img
        set_pass(name)
        bpy.ops.object.bake(
            type="NORMAL" if name == "normal" else "EMIT", use_selected_to_active=True, cage_extrusion=extrusion,
            max_ray_distance=ray, margin=12, use_clear=True, normal_space="TANGENT"
        )
        img.filepath_raw = os.path.join(out_dir, f"_{name}.png")
        img.file_format = "PNG"
        img.save()
        print("[kit] passe", name)


def export(kit, path, pivots):
    """Sépare le bas par pièce (chaque pièce ramenée à son pivot) et écrit le .glb, sans matériau."""
    names = list(kit.parts)
    obs = []
    for k, n in enumerate(names):
        me = kit.low.data.copy()
        bm = bmesh.new()
        bm.from_mesh(me)
        layer = bm.faces.layers.int["part"]
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[layer] != k], context="FACES")
        bmesh.ops.translate(bm, verts=bm.verts, vec=-Vector(pivots.get(n, (0, 0, 0))))
        bm.to_mesh(me)
        bm.free()
        me.materials.clear()
        me.attributes.remove(me.attributes["part"])
        ob = bpy.data.objects.new(n, me)
        bpy.context.scene.collection.objects.link(ob)
        obs.append(ob)
    bpy.ops.object.select_all(action="DESELECT")
    for ob in obs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_tangents=True, export_materials="NONE",
        export_yup=True, export_apply=True, export_normals=True, export_texcoords=True
    )
    print("[kit] écrit", path, os.path.getsize(path) // 1024, "Ko")
