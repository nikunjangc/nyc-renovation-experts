"""
sample_room.py - render the sample 360 living room used by room3d.html.

  python3.11 tools/room3d/sample_room.py OUT.png WIDTH SAMPLES ART.png [--layout OUT.json] [--labels] [--variant 2|3]

Builds a 17 x 14 ft prewar-style living room (9 ft ceiling, two tall windows,
radiator, herringbone floor, sofa, rug, coffee table, armchair, media console,
bookshelf, floor lamp, wall art) and renders it with Cycles from a camera
1.5 m above the floor as an equirectangular panorama (WIDTH x WIDTH/2).

Everything is modeled here; the floor and wood textures are the CC0 ambientCG
files in textures/ (see textures/CREDITS.md) and the wall art is an image made
for this scene. --layout writes the room's true corners for the app's sample
(feet, three.js axes: x = image centre direction, y up, z = right of it).

Needs Blender's Python module (pip install bpy, Python 3.11).
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

FT = 0.3048
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEX = os.path.join(REPO, "textures")

# Room box in metres (Blender axes, z up). Camera floor point at the origin.
X0, X1 = -2.35, 2.85      # door wall .. window wall   (5.20 m = 17.1 ft)
Y0, Y1 = -2.00, 2.27      # right wall .. left wall     (4.27 m = 14.0 ft)
H = 2.743                 # 9 ft ceiling
CAM_H = 1.50
WALL_T = 0.16


def srgb(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c) + (1.0,)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color="#ffffff", rough=0.6, metal=0.0, sheen=0.0, tex=None, tex_size=1.0,
             box=False, spec=0.5, emission=None, emission_strength=0.0, transmission=0.0, tint=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = srgb(color)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if "Sheen Weight" in p.inputs:
        p.inputs["Sheen Weight"].default_value = sheen
    if "Specular IOR Level" in p.inputs:
        p.inputs["Specular IOR Level"].default_value = spec
    if transmission and "Transmission Weight" in p.inputs:
        p.inputs["Transmission Weight"].default_value = transmission
    if emission:
        p.inputs["Emission Color"].default_value = srgb(emission)
        p.inputs["Emission Strength"].default_value = emission_strength
    if tex:
        img = bpy.data.images.load(tex)
        ti = nt.nodes.new("ShaderNodeTexImage")
        ti.image = img
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        s = 1.0 / tex_size
        mp.inputs["Scale"].default_value = (s, s, s)
        if box:
            ti.projection = "BOX"
            ti.projection_blend = 0.25
            nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        else:
            nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], ti.inputs["Vector"])
        if tint:
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs["Factor"].default_value = 1.0
            nt.links.new(ti.outputs["Color"], mix.inputs[6])
            mix.inputs[7].default_value = srgb(tint)
            nt.links.new(mix.outputs[2], p.inputs["Base Color"])
        else:
            nt.links.new(ti.outputs["Color"], p.inputs["Base Color"])
    return m


def box(name, sx, sy, sz, cx, cy, cz, mat, bevel=0.0, segs=3, rot_z=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, cy, cz))
    o = bpy.context.active_object
    o.name = name
    o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if rot_z:
        o.rotation_euler[2] = rot_z
    if bevel > 0:
        b = o.modifiers.new("bevel", "BEVEL")
        b.width = bevel
        b.segments = segs
        b.limit_method = "ANGLE"
        o.modifiers.new("wn", "WEIGHTED_NORMAL")
        bpy.ops.object.shade_smooth()
    o.data.materials.append(mat)
    return o


def cyl(name, r, h, cx, cy, cz, mat, verts=32, r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, vertices=verts, location=(cx, cy, cz))
    else:
        bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=r2, depth=h, vertices=verts, location=(cx, cy, cz))
    o = bpy.context.active_object
    o.name = name
    bpy.ops.object.shade_smooth()
    o.data.materials.append(mat)
    return o


def parent(children, name, loc=(0, 0, 0), rot_z=0.0):
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    for c in children:
        c.parent = e
    e.location = loc
    e.rotation_euler[2] = rot_z
    return e


# --variant 2 / 3: other materials on the same room, for testing the app's
# fills on harder looks (dark glossy floor with dark baseboards; a light
# floor with furniture and a rug close to its colour). Only the default room
# ships with the app.
VARIANTS = {
    2: {"floor": dict(tex=os.path.join(TEX, "wood-espresso-strip.webp"), tex_size=2 * FT, rough=0.12, spec=0.6),
        "trim": dict(color="#3b2a20", rough=0.4), "wall paint": dict(color="#e6dfd2"),
        "sofa fabric": dict(color="#7a4a2e"), "cushion fabric": dict(color="#80502f"),
        "chair fabric": dict(color="#4a3428"), "rug": dict(tint="#8c8c88"), "rug border": dict(color="#2a2a2a")},
    3: {"floor": dict(tex=os.path.join(TEX, "wood-graywash-oak.webp"), tex_size=3 * FT, rough=0.45),
        "wall paint": dict(color="#d9d9d6"), "sofa fabric": dict(color="#b5b2aa"), "cushion fabric": dict(color="#bdbab2"),
        "chair fabric": dict(color="#d8cdb8"), "rug": dict(tint="#d5ccbc"), "rug border": dict(color="#c4b8a4")},
}
VARIANT = 1


def vmat(name, color="#ffffff", **kw):
    over = dict(VARIANTS.get(VARIANT, {}).get(name, {}))
    color = over.pop("color", color)
    kw.update(over)
    return material(name, color, **kw)


def build(art_path):
    paint = vmat("wall paint", "#d2c8b6", rough=0.88, spec=0.3)
    ceiling = material("ceiling", "#efede8", rough=0.92, spec=0.2)
    trim = vmat("trim", "#f1efe9", rough=0.32)
    floor = vmat("floor", "#ffffff", rough=0.38, tex=os.path.join(TEX, "herringbone-honey-oak.webp"),
                 tex_size=3 * FT, spec=0.45)
    walnut = material("walnut", "#ffffff", rough=0.45, tex=os.path.join(TEX, "wood-rustic-walnut.webp"),
                      tex_size=1.0, box=True)
    oak = material("oak", "#ffffff", rough=0.5, tex=os.path.join(TEX, "wood-honey-oak.webp"), tex_size=0.9, box=True)
    fabric = vmat("sofa fabric", "#5d6872", rough=0.95, sheen=0.6, spec=0.25)
    fabric2 = vmat("cushion fabric", "#66727c", rough=0.95, sheen=0.6, spec=0.25)
    chair_fabric = vmat("chair fabric", "#5f7f72", rough=0.9, sheen=0.5, spec=0.3)
    linen = material("pillow", "#e6dccb", rough=0.95, sheen=0.5, spec=0.25)
    black_metal = material("black metal", "#1b1b1c", rough=0.35, metal=0.7)
    brass = material("brass", "#b48a4a", rough=0.3, metal=1.0)
    rug = vmat("rug", "#ffffff", rough=1.0, tex=os.path.join(TEX, "carpet-beige.webp"), tex_size=1.2,
                   sheen=0.4, tint="#c9b8a0")
    rug_border = vmat("rug border", "#3f4a55", rough=1.0, sheen=0.4)
    screen = material("tv screen", "#060708", rough=0.06, spec=0.8)
    white_paint = material("white paint", "#f0eee8", rough=0.45)
    radiator_paint = material("radiator", "#e8e4dc", rough=0.42, metal=0.15)
    terracotta = material("pot", "#a45a3c", rough=0.8)
    leaf = material("leaf", "#3d5a2a", rough=0.6, sheen=0.2)
    shade = material("lamp shade", "#f4ecdc", rough=0.9, transmission=0.35, emission="#ffd9a0",
                     emission_strength=1.2)
    brick = material("brick outside", "#ffffff", rough=0.95, tex=os.path.join(TEX, "brick-red-white-mortar.webp"),
                     tex_size=2.2)
    dark_glass = material("windows outside", "#1d242c", rough=0.15, spec=0.8)
    art_mat = bpy.data.materials.new("art")
    art_mat.use_nodes = True
    an = art_mat.node_tree
    ap = an.nodes["Principled BSDF"]
    ap.inputs["Roughness"].default_value = 0.8
    ai = an.nodes.new("ShaderNodeTexImage")
    ai.image = bpy.data.images.load(art_path)
    an.links.new(ai.outputs["Color"], ap.inputs["Base Color"])
    books = [material(f"book {i}", c, rough=0.7) for i, c in enumerate(
        ["#7a3b2e", "#2f4858", "#c9a227", "#e3dccb", "#4b5d3a", "#8c6d62", "#1f2a36", "#b56b45"])]

    # ---- floor, ceiling ----------------------------------------------------
    bpy.ops.mesh.primitive_plane_add(size=1, location=((X0 + X1) / 2, (Y0 + Y1) / 2, 0))
    f = bpy.context.active_object
    f.name = "floor"
    f.scale = (X1 - X0 + 0.4, Y1 - Y0 + 0.4, 1)
    f.data.materials.append(floor)
    box("ceiling", X1 - X0 + 0.4, Y1 - Y0 + 0.4, 0.05, (X0 + X1) / 2, (Y0 + Y1) / 2, H + 0.025, ceiling)

    # ---- walls with openings ----------------------------------------------
    win_c = [-0.70, 1.05]
    win_w, sill, top = 0.95, 0.72, 2.42
    # window wall (x = X1): solid pieces between/around the two windows
    edges = [Y0 - WALL_T]
    for c in win_c:
        edges += [c - win_w / 2, c + win_w / 2]
    edges.append(Y1 + WALL_T)
    for i in range(0, len(edges), 2):
        a, b = edges[i], edges[i + 1]
        box(f"window wall {i}", WALL_T, b - a, H, X1 + WALL_T / 2, (a + b) / 2, H / 2, paint)
    for c in win_c:
        box("below window", WALL_T, win_w, sill, X1 + WALL_T / 2, c, sill / 2, paint)
        box("above window", WALL_T, win_w, H - top, X1 + WALL_T / 2, c, (top + H) / 2, paint)
        # casing, sill, double-hung sash rails
        box("casing l", 0.03, 0.08, top - sill + 0.08, X1 - 0.015, c - win_w / 2 - 0.04, (sill + top) / 2, trim)
        box("casing r", 0.03, 0.08, top - sill + 0.08, X1 - 0.015, c + win_w / 2 + 0.04, (sill + top) / 2, trim)
        # (overlapping pieces never share a face: coincident faces render black in Cycles)
        box("casing t", 0.034, win_w + 0.17, 0.09, X1 - 0.017, c, top + 0.045, trim)
        box("sill", 0.12, win_w + 0.2, 0.035, X1 - 0.04, c, sill - 0.0145, trim, bevel=0.006)
        box("sash frame l", 0.05, 0.05, top - sill, X1 + 0.05, c - win_w / 2 + 0.025, (sill + top) / 2, trim)
        box("sash frame r", 0.05, 0.05, top - sill, X1 + 0.05, c + win_w / 2 - 0.025, (sill + top) / 2, trim)
        box("sash bottom", 0.044, win_w - 0.004, 0.06, X1 + 0.05, c, sill + 0.03, trim)
        box("sash top", 0.044, win_w - 0.004, 0.05, X1 + 0.05, c, top - 0.025, trim)
        box("meeting rail", 0.06, win_w - 0.004, 0.05, X1 + 0.062, c, (sill + top) / 2, trim)
        # portal light filling the room through the window, unseen by the camera
        bpy.ops.object.light_add(type="AREA", location=(X1 + 0.12, c, (sill + top) / 2))
        L = bpy.context.active_object
        L.data.shape = "RECTANGLE"
        L.data.size = top - sill
        L.data.size_y = win_w
        L.data.energy = 230
        L.data.color = (0.92, 0.96, 1.0)
        L.rotation_euler = Vector((-1, 0, 0)).to_track_quat("-Z", "Y").to_euler()
        L.visible_camera = False
        L.visible_glossy = False

    # door wall (x = X0) with a doorway to a hallway
    door_c, door_w, door_h = -1.25, 0.92, 2.13
    box("door wall a", WALL_T, (door_c - door_w / 2) - (Y0 - WALL_T), H, X0 - WALL_T / 2,
        ((Y0 - WALL_T) + (door_c - door_w / 2)) / 2, H / 2, paint)
    box("door wall b", WALL_T, (Y1 + WALL_T) - (door_c + door_w / 2), H, X0 - WALL_T / 2,
        ((Y1 + WALL_T) + (door_c + door_w / 2)) / 2, H / 2, paint)
    box("over door", WALL_T, door_w, H - door_h, X0 - WALL_T / 2, door_c, (door_h + H) / 2, paint)
    box("door casing l", 0.025, 0.09, door_h + 0.09, X0 + 0.0125, door_c - door_w / 2 - 0.045, (door_h + 0.09) / 2, trim)
    box("door casing r", 0.025, 0.09, door_h + 0.09, X0 + 0.0125, door_c + door_w / 2 + 0.045, (door_h + 0.09) / 2, trim)
    box("door casing t", 0.029, door_w + 0.19, 0.09, X0 + 0.0145, door_c, door_h + 0.045, trim)
    # hallway beyond the door
    hx0, hx1 = X0 - 2.4, X0 - WALL_T
    box("hall wall a", hx1 - hx0, 0.1, H, (hx0 + hx1) / 2, door_c - 0.62, H / 2, paint)
    box("hall wall b", hx1 - hx0, 0.1, H, (hx0 + hx1) / 2, door_c + 0.62, H / 2, paint)
    box("hall end", 0.1, 1.4, H, hx0, door_c, H / 2, paint)
    bpy.ops.object.light_add(type="POINT", location=((hx0 + hx1) / 2, door_c, H - 0.3))
    hl = bpy.context.active_object
    hl.data.energy = 60
    hl.data.color = (1.0, 0.85, 0.65)
    hl.data.shadow_soft_size = 0.2

    # side walls
    box("left wall", X1 - X0 + 2 * WALL_T, WALL_T, H, (X0 + X1) / 2, Y1 + WALL_T / 2, H / 2, paint)
    box("right wall", X1 - X0 + 2 * WALL_T, WALL_T, H, (X0 + X1) / 2, Y0 - WALL_T / 2, H / 2, paint)

    # baseboards and crown molding
    bb, cr = 0.13, 0.09
    for (sx, sy, cx, cy) in [
        (X1 - X0, 0.018, (X0 + X1) / 2, Y1 - 0.009),
        (X1 - X0, 0.018, (X0 + X1) / 2, Y0 + 0.009),
    ]:
        box("baseboard", sx, sy, bb, cx, cy, bb / 2, trim, bevel=0.004)
        box("crown", sx, sy * 3, cr, cx, cy + (0.018 if cy < 0 else -0.018), H - cr / 2, trim, bevel=0.01)
    for (a, b) in [(Y0, door_c - door_w / 2 - 0.09), (door_c + door_w / 2 + 0.09, Y1)]:
        box("baseboard", 0.018, b - a, bb, X0 + 0.009, (a + b) / 2, bb / 2, trim, bevel=0.004)
    box("crown", 0.054, Y1 - Y0, cr, X0 + 0.027, (Y0 + Y1) / 2, H - cr / 2, trim, bevel=0.01)
    for (a, b) in [(Y0, win_c[0] - win_w / 2 - 0.08), (win_c[0] + win_w / 2 + 0.08, win_c[1] - win_w / 2 - 0.08),
                   (win_c[1] + win_w / 2 + 0.08, Y1)]:
        box("baseboard", 0.018, b - a, bb, X1 - 0.009, (a + b) / 2, bb / 2, trim, bevel=0.004)
    box("crown", 0.054, Y1 - Y0, cr, X1 - 0.027, (Y0 + Y1) / 2, H - cr / 2, trim, bevel=0.01)

    # radiator under the first window
    rad = []
    rc = win_c[0]
    n = 14
    for i in range(n):
        y = rc - 0.42 + i * (0.84 / (n - 1))
        rad.append(box("radiator fin", 0.17, 0.045, 0.58, X1 - 0.16, y, 0.36, radiator_paint, bevel=0.012))
    rad.append(box("radiator foot l", 0.17, 0.05, 0.08, X1 - 0.16, rc - 0.42, 0.04, radiator_paint))
    rad.append(box("radiator foot r", 0.17, 0.05, 0.08, X1 - 0.16, rc + 0.42, 0.04, radiator_paint))
    cyl("radiator valve", 0.02, 0.12, X1 - 0.16, rc - 0.5, 0.12, brass)

    # ---- furniture ---------------------------------------------------------
    # sofa against the left wall
    sw, sd = 2.25, 0.95
    sx, sy = 0.15, Y1 - 0.03 - sd / 2
    parts = [
        box("sofa base", sw, sd, 0.26, 0, 0, 0.24, fabric, bevel=0.03),
        box("sofa back", sw, 0.22, 0.48, 0, sd / 2 - 0.11, 0.58, fabric, bevel=0.05),
        box("sofa arm l", 0.2, sd, 0.36, -sw / 2 + 0.1, 0, 0.48, fabric, bevel=0.06),
        box("sofa arm r", 0.2, sd, 0.36, sw / 2 - 0.1, 0, 0.48, fabric, bevel=0.06),
    ]
    cw = (sw - 0.4) / 3
    for i in range(3):
        x = -sw / 2 + 0.2 + cw / 2 + i * cw
        parts.append(box("seat cushion", cw - 0.01, sd - 0.26, 0.15, x, -0.1, 0.44, fabric2, bevel=0.05))
        parts.append(box("back cushion", cw - 0.02, 0.18, 0.4, x, sd / 2 - 0.3, 0.68, fabric2, bevel=0.07))
    parts.append(box("pillow", 0.45, 0.14, 0.42, -sw / 2 + 0.45, sd / 2 - 0.42, 0.7, linen, bevel=0.06))
    parts.append(box("pillow", 0.45, 0.14, 0.42, sw / 2 - 0.45, sd / 2 - 0.42, 0.7, linen, bevel=0.06))
    for lx in (-sw / 2 + 0.08, sw / 2 - 0.08):
        for ly in (-sd / 2 + 0.08, sd / 2 - 0.08):
            parts.append(cyl("sofa leg", 0.022, 0.11, lx, ly, 0.055, walnut, verts=16, r2=0.016))
    parent(parts, "sofa", (sx, sy, 0))          # back (+y) against the left wall

    # wall art over the sofa
    aw, ah = 1.15, 0.84
    box("art frame", aw + 0.05, 0.03, ah + 0.05, sx, Y1 - 0.02, 1.62, black_metal)
    bpy.ops.mesh.primitive_plane_add(size=1, location=(sx, Y1 - 0.037, 1.62))
    canvas = bpy.context.active_object
    canvas.name = "art"
    canvas.scale = (aw, ah, 1)
    canvas.rotation_euler = (math.pi / 2, 0, 0)       # faces the room (-y), not mirrored
    canvas.data.materials.append(art_mat)

    # rug and coffee table
    rx, ry = sx, Y1 - 1.5
    box("rug border", 2.7, 1.85, 0.012, rx, ry, 0.006, rug_border)
    box("rug", 2.56, 1.71, 0.016, rx, ry, 0.008, rug)
    table = [box("table top", 1.15, 0.6, 0.04, 0, 0, 0.41, walnut, bevel=0.008)]
    for lx in (-0.52, 0.52):
        for ly in (-0.25, 0.25):
            table.append(box("table leg", 0.03, 0.03, 0.39, lx, ly, 0.195, black_metal))
    table.append(box("table shelf", 1.05, 0.5, 0.02, 0, 0, 0.12, black_metal))
    ty = ry - 0.05
    parent(table, "coffee table", (rx, ty, 0.016))
    cyl("bowl", 0.11, 0.06, rx - 0.25, ty, 0.48, white_paint, verts=32, r2=0.07)
    box("book stack", 0.24, 0.17, 0.05, rx + 0.28, ty - 0.05, 0.48, books[1], bevel=0.003)
    box("book stack", 0.22, 0.16, 0.04, rx + 0.28, ty - 0.05, 0.525, books[2], bevel=0.003)

    # armchair by the window, angled toward the room
    aw2, ad2 = 0.85, 0.85
    chair = [
        box("chair base", aw2, ad2, 0.26, 0, 0, 0.26, chair_fabric, bevel=0.04),
        box("chair back", aw2, 0.18, 0.5, 0, ad2 / 2 - 0.09, 0.6, chair_fabric, bevel=0.06),
        box("chair arm", 0.14, ad2, 0.3, -aw2 / 2 + 0.07, 0, 0.5, chair_fabric, bevel=0.05),
        box("chair arm", 0.14, ad2, 0.3, aw2 / 2 - 0.07, 0, 0.5, chair_fabric, bevel=0.05),
        box("chair cushion", aw2 - 0.3, ad2 - 0.24, 0.13, 0, -0.08, 0.45, chair_fabric, bevel=0.05),
    ]
    for lx in (-aw2 / 2 + 0.07, aw2 / 2 - 0.07):
        for ly in (-ad2 / 2 + 0.07, ad2 / 2 - 0.07):
            chair.append(cyl("chair leg", 0.02, 0.13, lx, ly, 0.065, walnut, verts=16, r2=0.014))
    chx, chy = 2.05, -1.25
    face = math.atan2((Y0 + Y1) / 2 - chy, 0.25 - chx)     # toward the middle of the room
    parent(chair, "armchair", (chx, chy, 0), face + math.pi / 2)   # its front is local -y

    # media console + TV on the right wall
    cx = 0.25
    console = [box("console", 1.8, 0.45, 0.52, 0, 0, 0.32, walnut, bevel=0.01)]
    for lx in (-0.8, 0.8):
        console.append(box("console leg", 0.04, 0.38, 0.06, lx, 0, 0.03, black_metal))
    for dx in (-0.6, 0.0, 0.6):
        console.append(box("console door line", 0.006, 0.006, 0.44, dx - 0.3 if dx > 0 else dx + 0.3, -0.226, 0.32,
                           black_metal))
    parent(console, "media console", (cx, Y0 + 0.24, 0), math.pi)   # doors face the room
    box("tv", 1.25, 0.04, 0.72, cx, Y0 + 0.03, 1.32, screen, bevel=0.004)
    box("speaker", 0.5, 0.12, 0.08, cx, Y0 + 0.3, 0.62, black_metal, bevel=0.01)

    # bookshelf on the door wall
    bx, by = X0 + 0.18, 0.95
    shelf = [box("shelf side", 0.34, 0.025, 1.95, 0, -0.45, 0.975, white_paint),
             box("shelf side", 0.34, 0.025, 1.95, 0, 0.45, 0.975, white_paint),
             box("shelf back", 0.012, 0.9, 1.95, -0.165, 0, 0.975, white_paint)]
    import random
    rnd = random.Random(3)
    for k in range(6):
        z = 0.04 + k * 0.37
        shelf.append(box("shelf board", 0.33, 0.88, 0.022, 0, 0, z, white_paint))
        if k == 5:
            break
        y = -0.42
        while y < 0.4:
            bw = rnd.uniform(0.025, 0.05)
            bh = rnd.uniform(0.2, 0.3)
            if rnd.random() < 0.18:
                y += 0.06
                continue
            shelf.append(box("book", rnd.uniform(0.18, 0.24), bw, bh, -0.03, y + bw / 2, z + 0.011 + bh / 2,
                             rnd.choice(books)))
            y += bw + 0.003
    parent(shelf, "bookshelf", (bx, by, 0))

    # floor lamp beside the sofa
    lx, ly = 1.62, Y1 - 0.32
    cyl("lamp base", 0.16, 0.03, lx, ly, 0.015, brass)
    cyl("lamp pole", 0.012, 1.45, lx, ly, 0.74, brass, verts=12)
    sh = cyl("lamp shade", 0.21, 0.3, lx, ly, 1.52, shade, verts=40, r2=0.19)
    bpy.ops.object.light_add(type="POINT", location=(lx, ly, 1.5))
    lp = bpy.context.active_object
    lp.data.energy = 25
    lp.data.color = (1.0, 0.78, 0.5)
    lp.data.shadow_soft_size = 0.08

    # plant next to the console
    px, py = 1.45, Y0 + 0.32
    cyl("plant pot", 0.17, 0.4, px, py, 0.2, terracotta, r2=0.13)
    rnd2 = random.Random(11)
    for i in range(44):
        a = rnd2.uniform(0, 2 * math.pi)
        r = rnd2.uniform(0.02, 0.24)
        z = rnd2.uniform(0.5, 1.15)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=16, ring_count=8,
                                             location=(px + r * math.cos(a), py + r * math.sin(a), z))
        lf = bpy.context.active_object
        lf.scale = (rnd2.uniform(0.035, 0.06), rnd2.uniform(0.01, 0.015), rnd2.uniform(0.09, 0.15))
        lf.rotation_euler = (rnd2.uniform(-0.6, 0.6), rnd2.uniform(-0.6, 0.6), a)
        bpy.ops.object.shade_smooth()
        lf.data.materials.append(leaf)

    # flush ceiling light (off)
    cyl("ceiling light", 0.22, 0.07, 0.25, (Y0 + Y1) / 2, H - 0.035, material("glass shade", "#f3f1ec", rough=0.3,
                                                                                    transmission=0.5))

    # ---- outside: brick building across the street, sky, sun ---------------
    bpy.ops.mesh.primitive_plane_add(size=1, location=(X1 + 15, 0, 6))
    fac = bpy.context.active_object
    fac.scale = (30, 60, 1)          # 30 m tall (local x turns vertical), 60 m wide
    fac.rotation_euler = (0, math.pi / 2, 0)
    fac.data.materials.append(brick)
    for row in range(5):
        for col in range(-9, 10):
            box("outside window", 0.05, 1.1, 1.6, X1 + 14.97, col * 3.0, -3 + row * 3.4, dark_glass)
    bpy.ops.mesh.primitive_plane_add(size=80, location=(X1 + 7, 0, -9))
    street = bpy.context.active_object
    street.data.materials.append(material("street", "#55524d", rough=0.9))

    world = bpy.data.worlds.new("sky")
    bpy.context.scene.world = world
    world.use_nodes = True
    wn = world.node_tree
    sky = wn.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA" if "NISHITA" in [i.identifier for i in sky.bl_rna.properties["sky_type"].enum_items] else sky.sky_type
    try:
        sky.sun_elevation = math.radians(32)
        sky.sun_rotation = math.radians(200)
    except Exception:
        pass
    bg = wn.nodes["Background"]
    bg.inputs["Strength"].default_value = 0.25
    wn.links.new(sky.outputs["Color"], bg.inputs["Color"])

    # High, soft sun: the light patches land near the window wall and have soft
    # edges (a hard sun patch across the rug makes the floor demo look patchy).
    sun_el = 52
    sun_dir = Vector((-math.cos(math.radians(sun_el)) * math.cos(math.radians(22)),
                      -math.cos(math.radians(sun_el)) * math.sin(math.radians(22)),
                      -math.sin(math.radians(sun_el))))
    bpy.ops.object.light_add(type="SUN")
    sun = bpy.context.active_object
    sun.data.energy = 2.6
    sun.data.angle = math.radians(4.0)
    sun.data.color = (1.0, 0.95, 0.86)
    sun.rotation_euler = sun_dir.to_track_quat("-Z", "Y").to_euler()


def camera(width, samples):
    sc = bpy.context.scene
    cam = bpy.data.cameras.new("pano")
    cam.type = "PANO"
    try:
        cam.panorama_type = "EQUIRECTANGULAR"
    except AttributeError:
        cam.cycles.panorama_type = "EQUIRECTANGULAR"
    o = bpy.data.objects.new("pano", cam)
    sc.collection.objects.link(o)
    o.location = (0, 0, CAM_H)
    o.rotation_euler = (math.pi / 2, 0, -math.pi / 2)   # looks along +X: the image centre
    sc.camera = o
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.03
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = "OPENIMAGEDENOISE"
    except Exception:
        pass
    sc.cycles.max_bounces = 6
    sc.cycles.diffuse_bounces = 4
    sc.cycles.glossy_bounces = 2
    sc.cycles.transmission_bounces = 3
    sc.cycles.transparent_max_bounces = 4
    sc.cycles.sample_clamp_indirect = 6
    sc.cycles.blur_glossy = 1.0
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    sc.render.resolution_x = width
    sc.render.resolution_y = width // 2
    sc.render.resolution_percentage = 100
    sc.render.threads_mode = "AUTO"
    sc.view_settings.view_transform = "AgX"
    try:
        sc.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    sc.view_settings.exposure = -0.1
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_depth = "8"


# --labels: flat colours by material instead of the photo, for checking the
# app's wall and floor fills against the truth (tools/room3d/masks_eval.mjs).
LABELS = {"floor": "#ff0000", "wall paint": "#0000ff", "ceiling": "#00ff00", "trim": "#ffff00",
          "rug": "#ff00ff", "rug border": "#ff00ff"}
OTHER = "#00ffff"


def labelize():
    flats = {}

    def flat(hexc):
        if hexc not in flats:
            m = bpy.data.materials.new("label " + hexc)
            m.use_nodes = True
            nt = m.node_tree
            for node in list(nt.nodes):
                nt.nodes.remove(node)
            out = nt.nodes.new("ShaderNodeOutputMaterial")
            em = nt.nodes.new("ShaderNodeEmission")
            em.inputs["Color"].default_value = srgb(hexc)
            em.inputs["Strength"].default_value = 1.0
            nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
            flats[hexc] = m
        return flats[hexc]

    for o in list(bpy.data.objects):
        if o.type == "LIGHT":
            o.hide_render = True
        elif o.type == "MESH":
            for slot in o.material_slots:
                name = slot.material.name.split(".")[0] if slot.material else ""
                slot.material = flat(LABELS.get(name, OTHER))
    sc = bpy.context.scene
    sc.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
    sc.cycles.samples = 1
    sc.cycles.use_adaptive_sampling = False
    sc.cycles.use_denoising = False
    sc.cycles.filter_width = 0.01
    sc.cycles.max_bounces = 0
    sc.view_settings.view_transform = "Standard"
    try:
        sc.view_settings.look = "None"
    except Exception:
        pass
    sc.view_settings.exposure = 0.0


def layout():
    """True room corners for the app, in feet, three.js axes (x = +X, z = -Y)."""
    pts = [(X1, Y1), (X1, Y0), (X0, Y0), (X0, Y1)]
    corners = [[round(x / FT, 3), round(-y / FT, 3)] for (x, y) in pts]
    return {"cameraHeightFt": round(CAM_H / FT, 3), "ceilingFt": round(H / FT, 3), "corners": corners}


def main():
    argv = sys.argv[1:]
    lay = None
    if "--layout" in argv:
        i = argv.index("--layout")
        lay = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    labels = "--labels" in argv
    argv = [a for a in argv if a != "--labels"]
    global VARIANT
    if "--variant" in argv:
        i = argv.index("--variant")
        VARIANT = int(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
    out, width, samples, art = argv[0], int(argv[1]), int(argv[2]), argv[3]
    reset()
    build(art)
    camera(width, samples)
    if labels:
        labelize()
    if lay:
        with open(lay, "w") as fh:
            json.dump(layout(), fh, indent=2)
    bpy.context.scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print("wrote", out)


if __name__ == "__main__":
    main()
