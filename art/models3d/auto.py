"""Cuit les modèles procéduraux du jeu tels qu'ils sont (mêmes formes) : arêtes arrondies, peinture
usée sur les arêtes, crasse dans les creux, métaux qui brillent, occlusion.

  npx vite-node tools/export-models.ts                      # les formes -> art/models3d/out/src/*.json
  Blender -b --python art/models3d/auto.py -- [nom…]        # les cuit (tous, sans nom)
  python3 art/models3d/pack.py --all                        # -> public/assets/models/<nom>/

Chaque sommet arrive avec sa couleur de base, sa matière (métal, rugosité, usure, arête claire), le masque
de la couleur du camp et celui des lampes (tools/export-models.ts) : un seul matériau les lit.
"""
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kit as kitmod  # noqa: E402
from kit import Graph, srgb  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "out", "src")
args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
names = [a for a in args if not a.startswith("--")] or sorted(f[:-5] for f in os.listdir(SRC) if f.endswith(".json"))
SPREAD = 12.0  # les pièces sont cuites côte à côte, sans se toucher


def material():
    m = bpy.data.materials.new("auto")
    m.use_nodes = True
    t = m.node_tree
    t.nodes.clear()
    g = Graph(t)

    def attr(name):
        n = g.node("ShaderNodeAttribute", attribute_name=name)
        return n

    col = attr("col").outputs["Color"]
    prm = g.node("ShaderNodeSeparateColor")
    t.links.new(attr("prm").outputs["Color"], prm.inputs[0])
    metal0, rough0, wearK = prm.outputs[0], prm.outputs[1], prm.outputs[2]
    edgeL = attr("prm").outputs["Alpha"]
    tgn = g.node("ShaderNodeSeparateColor")
    t.links.new(attr("tg").outputs["Color"], tgn.inputs[0])
    team0, glow, kind = tgn.outputs[0], tgn.outputs[1], tgn.outputs[2]

    geo = g.node("ShaderNodeNewGeometry")
    N, P = geo.outputs["Normal"], geo.outputs["Position"]
    z = g.node("ShaderNodeSeparateXYZ")
    t.links.new(P, z.inputs[0])
    Z = z.outputs[2]
    nz = g.node("ShaderNodeSeparateXYZ")
    t.links.new(N, nz.inputs[0])
    wall = g.math("SUBTRACT", 1.0, g.math("ABSOLUTE", nz.outputs[2]))
    lit = g.math("SUBTRACT", 1.0, glow)  # (les lampes restent propres)

    bev = g.node("ShaderNodeBevel", samples=8)
    bev.inputs["Radius"].default_value = 0.007
    bevw = g.node("ShaderNodeBevel", samples=8)
    bevw.inputs["Radius"].default_value = 0.02
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
    rim = g.math("MULTIPLY", edge, convex, clamp=True)

    n_big = g.noise(P, 7.0, 2.0)
    n_mid = g.noise(P, 26.0, 4.0, 0.6)
    n_fine = g.noise(P, 110.0, 3.0, 0.6)
    w_edge = g.ramp(g.math("MULTIPLY", rim, g.math("ADD", 0.35, g.math("MULTIPLY", n_mid, 1.5))), 0.34, 0.66)
    w_chip = g.ramp(g.math("MULTIPLY", g.noise(P, 16.0, 3.0, 0.7), g.math("ADD", n_mid, 0.3)), 0.57, 0.61)
    wear = g.math("MULTIPLY", g.math("MAXIMUM", w_edge, g.math("MULTIPLY", w_chip, 0.08)), wearK, clamp=True)
    cav = g.math("MULTIPLY", g.ramp(AO, 0.82, 0.3), g.math("ADD", 0.45, n_mid))
    dirt = g.math("MULTIPLY", cav, lit, clamp=True)
    n_streak = g.noise(P, 1.0, 2.0, 0.5, stretch=(55.0, 55.0, 4.0))
    streak = g.math("MULTIPLY", g.math("MULTIPLY", g.math("MULTIPLY", g.ramp(n_streak, 0.52, 0.75), wall), 0.25), lit)

    # l'appareil des bâtiments, selon la matière (tg.b : 1 pierre de taille, 2 brique, 3 toiture, 4 bois) :
    # une trame de joints qui assombrit la couleur et creuse le relief
    px = g.node("ShaderNodeSeparateXYZ")
    t.links.new(P, px.inputs[0])
    along = g.math("ADD", px.outputs[0], px.outputs[1])

    def courses(k, w, h, mortar, off=0.5, squash=1.0, zmul=1.0):
        v = g.node("ShaderNodeCombineXYZ")
        g.set(v.inputs[0], along)
        g.set(v.inputs[1], g.math("MULTIPLY", px.outputs[2], zmul))
        br = g.node("ShaderNodeTexBrick", offset=off, squash=squash)
        t.links.new(v.outputs[0], br.inputs["Vector"])
        br.inputs["Color1"].default_value = (0.82, 0.82, 0.82, 1)
        br.inputs["Color2"].default_value = (1.0, 1.0, 1.0, 1)
        br.inputs["Mortar"].default_value = (0.5, 0.5, 0.5, 1)
        br.inputs["Scale"].default_value = 1.0
        br.inputs["Mortar Size"].default_value = mortar
        br.inputs["Mortar Smooth"].default_value = 0.2
        br.inputs["Bias"].default_value = 0.0
        br.inputs["Brick Width"].default_value = w
        br.inputs["Row Height"].default_value = h
        sel = g.math("COMPARE", kind, k / 8)
        sel.node.inputs[2].default_value = 0.03  # (l'écart admis)
        return sel, br.outputs["Color"], br.outputs["Fac"]

    tone, joint = 1.0, 0.0
    for sel, c_, f_ in (courses(1, 0.16, 0.07, 0.004), courses(2, 0.06, 0.024, 0.003), courses(3, 0.05, 0.03, 0.0025, zmul=1.6), courses(4, 0.6, 0.035, 0.002, off=0.3)):
        gray = g.node("ShaderNodeSeparateColor")
        t.links.new(c_, gray.inputs[0])
        tone = g.lerp(sel, tone, gray.outputs[0])
        joint = g.math("MAXIMUM", joint, g.math("MULTIPLY", sel, f_))

    # la couleur : nuancée, l'arête éclaircie (peinture) ou polie (métal nu), l'acier sous la peinture écaillée
    value = g.math("ADD", 0.82, g.math("MULTIPLY", n_big, 0.14))
    paint = g.node("ShaderNodeVectorMath", operation="SCALE")
    t.links.new(col, paint.inputs[0])
    t.links.new(g.math("MULTIPLY", g.lerp(glow, value, 1.0), tone), paint.inputs["Scale"])
    c = paint.outputs[0]
    c = g.mix(streak, c, srgb(0x2a2018))
    light = g.node("ShaderNodeVectorMath", operation="SCALE")
    t.links.new(c, light.inputs[0])
    t.links.new(g.math("ADD", 1.45, g.math("MULTIPLY", edgeL, 1.2)), light.inputs["Scale"])
    c = g.mix(g.math("MULTIPLY", g.math("MULTIPLY", rim, g.math("ADD", 0.5, edgeL)), lit, clamp=True), c, light.outputs[0])
    c = g.mix(wear, c, srgb(0x9a968e))
    c = g.mix(g.math("MULTIPLY", dirt, 0.8), c, srgb(0x2a2018))

    rough = g.lerp(wear, g.math("ADD", g.math("SUBTRACT", rough0, 0.06), g.math("MULTIPLY", n_fine, 0.12)), 0.32)
    rough = g.lerp(dirt, rough, 0.92)
    metal = g.math("MULTIPLY", g.lerp(wear, metal0, 1.0), g.math("SUBTRACT", 1.0, g.math("MULTIPLY", dirt, 0.8)))
    team = g.math("MULTIPLY", team0, g.math("SUBTRACT", 1.0, wear))

    height = g.math("SUBTRACT", g.math("SUBTRACT", g.math("MULTIPLY", g.noise(P, 140.0, 2.0), 0.3), g.math("MULTIPLY", wear, 0.6)), g.math("MULTIPLY", joint, 1.2))
    bump = g.node("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.5
    bump.inputs["Distance"].default_value = 0.0025
    t.links.new(height, bump.inputs["Height"])
    t.links.new(bev.outputs[0], bump.inputs["Normal"])

    def rgb(r, gg, b):
        n = g.node("ShaderNodeCombineColor")
        for i, v in enumerate((r, gg, b)):
            g.set(n.inputs[i], v)
        return n.outputs[0]

    outs = {"color": c, "orm": rgb(aow.outputs["AO"], rough, metal), "extra": rgb(team, glow, wear)}
    em = g.node("ShaderNodeEmission")
    bsdf = g.node("ShaderNodeBsdfPrincipled")
    t.links.new(bump.outputs[0], bsdf.inputs["Normal"])
    out = g.node("ShaderNodeOutputMaterial")
    kitmod.m_passes["auto"] = (t, outs, em, bsdf, out)
    tex = t.nodes.new("ShaderNodeTexImage")
    t.nodes.active = tex
    return m, tex


def build(data):
    """Un seul maillage : les pièces écartées de SPREAD en X (à leur hauteur montée), l'attribut `part` par face."""
    bm = bmesh.new()
    lc = bm.loops.layers.float_color.new("col")
    lp = bm.loops.layers.float_color.new("prm")
    lt = bm.loops.layers.float_color.new("tg")
    fp = bm.faces.layers.int.new("part")
    offsets = []
    for k, part in enumerate(data["parts"]):
        pos, col, prm, tg = part["pos"], part["col"], part["prm"], part["tg"]
        TG = len(tg) * 3 // len(pos)
        # (three : y en haut, nez vers -z  ->  Blender : z en haut, nez vers +y)
        off = Vector((k * SPREAD, 0, part["at"][1]))
        offsets.append(off)
        for i in range(0, len(pos) // 3, 3):
            vs = [bm.verts.new((pos[j * 3] + off.x, -pos[j * 3 + 2], pos[j * 3 + 1] + off.z)) for j in (i, i + 1, i + 2)]
            try:
                f = bm.faces.new(vs)
            except ValueError:
                continue
            f[fp] = k
            f.smooth = True
            for loop, j in zip(f.loops, (i, i + 1, i + 2)):
                loop[lc] = (*col[j * 3:j * 3 + 3], 1.0)
                loop[lp] = tuple(prm[j * 4:j * 4 + 4])
                loop[lt] = (tg[j * TG], tg[j * TG + 1], tg[j * TG + 2] if TG > 2 else 0.0, 1.0)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=2e-5)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6)
    me = bpy.data.meshes.new("low")
    bm.to_mesh(me)
    bm.free()
    me.set_sharp_from_angle(angle=math.radians(38))
    ob = bpy.data.objects.new("low", me)
    bpy.context.scene.collection.objects.link(ob)
    return ob, offsets


def bake(ob, tex, out_dir, res, samples):
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
        print("[auto] pas de GPU :", e)
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    for name in ("color", "orm", "extra", "normal"):
        img = bpy.data.images.new(name, res, res, alpha=False, is_data=name != "color")
        tex.image = img
        kitmod.set_pass(name)
        bpy.ops.object.bake(type="NORMAL" if name == "normal" else "EMIT", use_selected_to_active=False, margin=8, use_clear=True, normal_space="TANGENT")
        img.filepath_raw = os.path.join(out_dir, f"_{name}.png")
        img.file_format = "PNG"
        img.save()


def export(ob, data, offsets, path):
    obs = []
    for k, part in enumerate(data["parts"]):
        me = ob.data.copy()
        bm = bmesh.new()
        bm.from_mesh(me)
        layer = bm.faces.layers.int["part"]
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[layer] != k], context="FACES")
        bmesh.ops.translate(bm, verts=bm.verts, vec=-offsets[k])
        bm.to_mesh(me)
        bm.free()
        me.materials.clear()
        for a in ("part", "col", "prm", "tg"):
            me.attributes.remove(me.attributes[a])
        o = bpy.data.objects.new(part["name"], me)
        bpy.context.scene.collection.objects.link(o)
        obs.append(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_tangents=True, export_materials="NONE",
        export_yup=True, export_apply=True, export_normals=True, export_texcoords=True
    )


for name in names:
    with open(os.path.join(SRC, name + ".json")) as f:
        data = json.load(f)
    kitmod.reset_scene()
    ob, offsets = build(data)
    mat, tex = material()
    ob.data.materials.append(mat)
    kitmod.unwrap(ob, margin=0.004)
    res = 1024
    bake(ob, tex, os.path.join(HERE, "out", name), res, 8 if "--fast" in args else 16)
    export(ob, data, offsets, os.path.join(HERE, "..", "..", "public", "assets", "models", name, name + ".glb"))
    with open(os.path.join(HERE, "out", name, "size.txt"), "w") as f:
        f.write(str(data["size"]))
    print(f"[auto] {name} : {len(ob.data.polygons)} triangles, {res} px")
