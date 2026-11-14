#!/usr/bin/env python3
"""Builds the demo BeamNG level used by the app (testdata/level.zip):
terrain with material layers, textured .dae shapes (house, tree, crate) with
png + DXT1/DXT5 .dds textures, BeamNG main.materials.json / materials.cs,
a textured DecalRoad, and a few references to game-shared shapes that are
deliberately NOT in the zip (they fall back to boxes).
Usage: make_demo.py [--heavy OUT.zip]"""
import io, json, math, random, struct, sys, zipfile, os
import numpy as np
from PIL import Image

R = random.Random(7)
LV = 'levels/test_arranger'
HEAVY = '--heavy' in sys.argv

# ---------------- textures ----------------
def noise(n, scale, seed):
    rng = np.random.default_rng(seed)
    g = rng.random((n // scale + 2, n // scale + 2))
    img = Image.fromarray((g * 255).astype(np.uint8)).resize((n, n), Image.BICUBIC)
    return np.asarray(img).astype(np.float32) / 255

def tex_brick(n=256):
    a = np.zeros((n, n, 3), np.float32)
    nz = noise(n, 8, 1) * 0.25 + noise(n, 32, 2) * 0.15
    bh, bw = n // 8, n // 4
    for y in range(n):
        row = y // bh; off = (bw // 2) * (row % 2)
        for x in range(n):
            mortar = (y % bh) < 3 or ((x + off) % bw) < 3
            if mortar: c = (0.78, 0.75, 0.70)
            else:
                k = ((x + off) // bw * 7 + row * 13) % 5 * 0.04
                c = (0.62 - k, 0.27 - k / 2, 0.18 - k / 3)
            a[y, x] = c
    a *= (0.85 + nz[..., None])
    return np.clip(a, 0, 1)

def tex_roof(n=256):
    a = np.zeros((n, n, 3), np.float32); nz = noise(n, 16, 3) * 0.2
    th = n // 8
    for y in range(n):
        r = y % th
        shade = 0.55 + 0.45 * (r / th)
        for x in range(n):
            col = (x // (n // 8) + y // th) % 2
            base = (0.42, 0.16, 0.12) if col else (0.38, 0.14, 0.11)
            a[y, x] = [c * shade for c in base]
    return np.clip(a * (0.9 + nz[..., None]), 0, 1)

def tex_bark(n=256):
    s = noise(n, 4, 5)[:, :1].repeat(n, 1).T * 0.5 + noise(n, 16, 6) * 0.5
    a = np.stack([0.30 + 0.25 * s, 0.20 + 0.15 * s, 0.12 + 0.08 * s], -1)
    return np.clip(a, 0, 1)

def tex_leaves(n=256):
    a = np.zeros((n, n, 4), np.float32)
    yy, xx = np.mgrid[0:n, 0:n]
    for _ in range(260):
        cx, cy = R.uniform(0, n), R.uniform(n * 0.05, n * 0.98)
        rr = R.uniform(5, 14)
        # canopy shape: wider at bottom
        lim = (n - cy) / n
        if abs(cx - n / 2) > n * 0.48 * (0.25 + 0.75 * (1 - lim)) : continue
        m = ((xx - cx) ** 2 + ((yy - cy) * 1.6) ** 2) < rr * rr
        g = R.uniform(0.25, 0.55)
        a[m] = [0.10 + g * 0.3, 0.25 + g * 0.5, 0.06 + g * 0.15, 1]
    return a

def tex_planks(n=256):
    nz = noise(n, 4, 9)[:1, :].repeat(n, 0) * 0.35 + noise(n, 32, 10) * 0.2
    a = np.stack([0.55 + 0.3 * nz, 0.38 + 0.22 * nz, 0.20 + 0.1 * nz], -1)
    for k in range(0, n, n // 4): a[k:k + 4, :] *= 0.45
    a[:6, :] *= 0.4; a[-6:, :] *= 0.4; a[:, :6] *= 0.4; a[:, -6:] *= 0.4
    return np.clip(a, 0, 1)

def tex_grass(n=256):
    s = noise(n, 4, 11) * 0.5 + noise(n, 24, 12) * 0.5
    return np.clip(np.stack([0.22 + 0.18 * s, 0.38 + 0.22 * s, 0.12 + 0.08 * s], -1), 0, 1)

def tex_dirt(n=256):
    s = noise(n, 6, 13) * 0.6 + noise(n, 30, 14) * 0.4
    return np.clip(np.stack([0.42 + 0.2 * s, 0.32 + 0.16 * s, 0.22 + 0.1 * s], -1), 0, 1)

def tex_rock(n=256):
    s = noise(n, 5, 15) * 0.5 + noise(n, 20, 16) * 0.5
    return np.clip(np.stack([0.40 + 0.3 * s, 0.39 + 0.29 * s, 0.37 + 0.27 * s], -1), 0, 1)

def tex_road(n=256):
    a = np.zeros((n, n, 4), np.float32)
    s = noise(n, 3, 17) * 0.12
    a[..., 0] = a[..., 1] = 0.20 + s; a[..., 2] = 0.21 + s; a[..., 3] = 1
    w = n
    edge = int(w * 0.06)
    a[:, edge:edge + 6, :3] = 0.92; a[:, w - edge - 6:w - edge, :3] = 0.92
    for y in range(n):
        if (y // (n // 4)) % 2 == 0:
            a[y, w // 2 - 4:w // 2 + 4, :3] = (0.95, 0.78, 0.15)
    a[:, :4, 3] = 0.0; a[:, 4:10, 3] = 0.6; a[:, -4:, 3] = 0.0; a[:, -10:-4, 3] = 0.6
    return a

def to_png(a):
    mode = 'RGBA' if a.shape[2] == 4 else 'RGB'
    b = io.BytesIO(); Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), mode).save(b, 'PNG', optimize=True); return b.getvalue()

# ---- DXT encoders (tiny, quality is fine for a demo) ----
def to565(c):
    return (int(round(c[0] * 31 / 255)) << 11) | (int(round(c[1] * 63 / 255)) << 5) | int(round(c[2] * 31 / 255))
def from565(v):
    return np.array([((v >> 11) & 31) * 255 // 31, ((v >> 5) & 63) * 255 // 63, (v & 31) * 255 // 31], np.float32)
def color_block(px):
    rgb = px[:, :3].astype(np.float32)
    lum = rgb @ np.array([0.3, 0.59, 0.11])
    c0, c1 = to565(rgb[lum.argmax()]), to565(rgb[lum.argmin()])
    if c0 < c1: c0, c1 = c1, c0
    if c0 == c1:
        return struct.pack('<HHI', c0, c1, 0)
    p0, p1 = from565(c0), from565(c1)
    pal = np.stack([p0, p1, (2 * p0 + p1) // 3, (p0 + 2 * p1) // 3])
    idx = ((rgb[:, None, :] - pal[None]) ** 2).sum(-1).argmin(1)
    bits = 0
    for i, v in enumerate(idx): bits |= int(v) << (2 * i)
    return struct.pack('<HHI', c0, c1, bits)
def alpha_block(al):
    a0, a1 = int(al.max()), int(al.min())
    if a0 == a1: return bytes([a0, a1, 0, 0, 0, 0, 0, 0])
    pal = np.array([a0, a1] + [((7 - i) * a0 + i * a1) // 7 for i in range(1, 7)], np.float32)
    idx = np.abs(al[:, None].astype(np.float32) - pal[None]).argmin(1)
    bits = 0
    for i, v in enumerate(idx): bits |= int(v) << (3 * i)
    return bytes([a0, a1]) + bits.to_bytes(6, 'little')
def dds(a, fourcc):
    img = (np.clip(a, 0, 1) * 255).astype(np.uint8)
    if img.shape[2] == 3: img = np.concatenate([img, np.full(img.shape[:2] + (1,), 255, np.uint8)], 2)
    h, w = img.shape[:2]
    levels = []
    cur = img
    while True:
        levels.append(cur)
        if cur.shape[0] <= 4 or cur.shape[1] <= 4: break
        cur = np.asarray(Image.fromarray(cur, 'RGBA').resize((cur.shape[1] // 2, cur.shape[0] // 2), Image.BOX))
    out = bytearray()
    for lv in levels:
        lh, lw = lv.shape[:2]
        for by in range(0, lh, 4):
            for bx in range(0, lw, 4):
                px = lv[by:by + 4, bx:bx + 4].reshape(-1, 4)
                if fourcc == b'DXT5': out += alpha_block(px[:, 3])
                out += color_block(px)
    bs = 8 if fourcc == b'DXT1' else 16
    hdr = struct.pack('<4sIIIIIII44xII4sIIIII IIII4x', b'DDS ', 124, 0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000, h, w,
                      max(1, w // 4) * max(1, h // 4) * bs, 0, len(levels), 32, 0x4, fourcc, 0, 0, 0, 0, 0, 0x1000 | 0x400000 | 0x8, 0, 0, 0)
    assert len(hdr) == 128, len(hdr)
    return bytes(hdr) + bytes(out)

# ---------------- collada ----------------
class Dae:
    def __init__(self): self.geoms = []; self.mats = {}; self.images = {}; self.nodes = []
    def material(self, mid, color=(0.8, 0.8, 0.8), image=None):
        self.mats[mid] = (color, image)
        if image: self.images[mid + '-img'] = image
    def geometry(self, gid, prims):  # prims: list of (material, positions[], normals[], uvs[]) triangles soup
        self.geoms.append((gid, prims))
    def xml(self, nodes):
        f = lambda a: ' '.join('%.5g' % v for v in a)
        o = ['<?xml version="1.0" encoding="utf-8"?>', '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">',
             '<asset><unit meter="1" name="meter"/><up_axis>Z_UP</up_axis></asset>']
        o.append('<library_images>' + ''.join(f'<image id="{k}" name="{k}"><init_from>{v}</init_from></image>' for k, v in self.images.items()) + '</library_images>')
        o.append('<library_effects>')
        for mid, (col, img) in self.mats.items():
            if img:
                diff = (f'<newparam sid="{mid}-surf"><surface type="2D"><init_from>{mid}-img</init_from></surface></newparam>'
                        f'<newparam sid="{mid}-samp"><sampler2D><source>{mid}-surf</source></sampler2D></newparam>')
                d2 = f'<diffuse><texture texture="{mid}-samp" texcoord="UVMap"/></diffuse>'
            else:
                diff = ''; d2 = f'<diffuse><color>{f(col)} 1</color></diffuse>'
            o.append(f'<effect id="{mid}-effect"><profile_COMMON>{diff}<technique sid="common"><lambert>{d2}</lambert></technique></profile_COMMON></effect>')
        o.append('</library_effects><library_materials>')
        for mid in self.mats: o.append(f'<material id="{mid}" name="{mid}"><instance_effect url="#{mid}-effect"/></material>')
        o.append('</library_materials><library_geometries>')
        for gid, prims in self.geoms:
            P, N, U, tris = [], [], [], []
            for mat, ps, ns, us in prims:
                start = len(P) // 3
                P += ps; N += ns; U += us
                tris.append((mat, start, len(ps) // 9))
            nv = len(P) // 3
            o.append(f'<geometry id="{gid}" name="{gid}"><mesh>')
            o.append(f'<source id="{gid}-pos"><float_array id="{gid}-pos-arr" count="{len(P)}">{f(P)}</float_array><technique_common><accessor source="#{gid}-pos-arr" count="{nv}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>')
            o.append(f'<source id="{gid}-nor"><float_array id="{gid}-nor-arr" count="{len(N)}">{f(N)}</float_array><technique_common><accessor source="#{gid}-nor-arr" count="{nv}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>')
            o.append(f'<source id="{gid}-uv"><float_array id="{gid}-uv-arr" count="{len(U)}">{f(U)}</float_array><technique_common><accessor source="#{gid}-uv-arr" count="{nv}" stride="2"><param name="S" type="float"/><param name="T" type="float"/></accessor></technique_common></source>')
            o.append(f'<vertices id="{gid}-vtx"><input semantic="POSITION" source="#{gid}-pos"/></vertices>')
            for mat, start, cnt in tris:
                idx = ' '.join(str(start + i) for i in range(cnt * 3))
                o.append(f'<triangles material="{mat}" count="{cnt}"><input semantic="VERTEX" source="#{gid}-vtx" offset="0"/><input semantic="NORMAL" source="#{gid}-nor" offset="0"/><input semantic="TEXCOORD" source="#{gid}-uv" offset="0" set="0"/><p>{idx}</p></triangles>')
            o.append('</mesh></geometry>')
        o.append('</library_geometries><library_visual_scenes><visual_scene id="Scene" name="Scene">')
        def node(n):
            name, geo, kids = n
            s = f'<node id="{name}" name="{name}" type="NODE">'
            if geo:
                mats = sorted({p[0] for g, pr in self.geoms if g == geo for p in pr})
                s += f'<instance_geometry url="#{geo}"><bind_material><technique_common>' + ''.join(f'<instance_material symbol="{m}" target="#{m}"/>' for m in mats) + '</technique_common></bind_material></instance_geometry>'
            return s + ''.join(node(k) for k in kids) + '</node>'
        o.append(''.join(node(n) for n in nodes))
        o.append('</visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>')
        return '\n'.join(o)

def quad(p0, p1, p2, p3, uv=((0, 0), (1, 0), (1, 1), (0, 1))):
    a, b, c, d = map(np.array, (p0, p1, p2, p3))
    n = np.cross(b - a, d - a); n = n / (np.linalg.norm(n) or 1)
    ps = list(a) + list(b) + list(c) + list(a) + list(c) + list(d)
    us = list(uv[0]) + list(uv[1]) + list(uv[2]) + list(uv[0]) + list(uv[2]) + list(uv[3])
    return ps, list(n) * 6, us
def tri(p0, p1, p2, uv):
    a, b, c = map(np.array, (p0, p1, p2)); n = np.cross(b - a, c - a); n = n / np.linalg.norm(n)
    return list(a) + list(b) + list(c), list(n) * 3, [v for t in uv for v in t]
def merge(mat, parts):
    P, N, U = [], [], []
    for p, n, u in parts: P += [float(x) for x in p]; N += [float(x) for x in n]; U += [float(x) for x in u]
    return (mat, P, N, U)

def box_parts(x0, x1, y0, y1, z0, z1, t=1.0):
    W, D, H = x1 - x0, y1 - y0, z1 - z0
    return [quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), ((0, 0), (W / t, 0), (W / t, H / t), (0, H / t))),
            quad((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1), ((0, 0), (W / t, 0), (W / t, H / t), (0, H / t))),
            quad((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1), ((0, 0), (D / t, 0), (D / t, H / t), (0, H / t))),
            quad((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1), ((0, 0), (D / t, 0), (D / t, H / t), (0, H / t))),
            quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), ((0, 0), (W / t, 0), (W / t, D / t), (0, D / t))),
            quad((x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0), ((0, 0), (W / t, 0), (W / t, D / t), (0, D / t)))]

def house_dae():
    d = Dae()
    d.material('house_wall', image='house_wall.color.png')   # mapped by main.materials.json
    d.material('house_roof', image='house_roof.color.dds')
    d.material('house_door', color=(0.35, 0.22, 0.12))
    d.material('house_window', color=(0.5, 0.7, 0.85))
    X, Y, H, RZ = 4.0, 3.0, 3.0, 5.0
    walls = box_parts(-X, X, -Y, Y, 0, H, 2.0)[:4]
    gab = [tri((-X, -Y, H), (-X, Y, H), (-X, 0, RZ), ((0, 1.5), (3, 1.5), (1.5, 2.5))), tri((X, Y, H), (X, -Y, H), (X, 0, RZ), ((0, 1.5), (3, 1.5), (1.5, 2.5)))]
    O = 0.35
    roof = [quad((-X - O, -Y - O, H - 0.2), (X + O, -Y - O, H - 0.2), (X + O, 0, RZ), (-X - O, 0, RZ), ((0, 0), (4, 0), (4, 2), (0, 2))),
            quad((X + O, Y + O, H - 0.2), (-X - O, Y + O, H - 0.2), (-X - O, 0, RZ), (X + O, 0, RZ), ((0, 0), (4, 0), (4, 2), (0, 2)))]
    door = [quad((-0.6, -Y - 0.02, 0), (0.6, -Y - 0.02, 0), (0.6, -Y - 0.02, 2.1), (-0.6, -Y - 0.02, 2.1))]
    win = []
    for cx in (-2.6, 2.6):
        win.append(quad((cx - 0.6, -Y - 0.02, 1.1), (cx + 0.6, -Y - 0.02, 1.1), (cx + 0.6, -Y - 0.02, 2.2), (cx - 0.6, -Y - 0.02, 2.2)))
        win.append(quad((cx + 0.6, Y + 0.02, 1.1), (cx - 0.6, Y + 0.02, 1.1), (cx - 0.6, Y + 0.02, 2.2), (cx + 0.6, Y + 0.02, 2.2)))
    d.geometry('house_a400-mesh', [merge('house_wall', walls + gab), merge('house_roof', roof), merge('house_door', door), merge('house_window', win)])
    # low LOD (must be ignored by the app) and collision mesh (must be ignored)
    d.geometry('house_a50-mesh', [merge('house_door', box_parts(-X - 1, X + 1, -Y - 1, Y + 1, 0, 7))])
    d.geometry('Colmesh-1-mesh', [merge('house_door', box_parts(-X, X, -Y, Y, 0, RZ))])
    return d.xml([('base00', None, [('start01', None, [('house_a400', 'house_a400-mesh', []), ('house_a50', 'house_a50-mesh', []), ('Colmesh-1', 'Colmesh-1-mesh', [])])])])

def tree_dae():
    d = Dae()
    d.material('tree_bark', image='tree_bark.png')
    d.material('tree_leaves', image='tree_leaves.dds')
    parts = []
    n, r, h = 8, 0.22, 3.2
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p = lambda a, z, rr: (rr * math.cos(a), rr * math.sin(a), z)
        parts.append(quad(p(a0, 0, r), p(a1, 0, r), p(a1, h, r * 0.6), p(a0, h, r * 0.6), ((i / n, 0), ((i + 1) / n, 0), ((i + 1) / n, 2), (i / n, 2))))
    leaves = []
    W, z0, z1 = 2.6, 1.2, 7.0
    for k in range(3):
        a = math.pi * k / 3
        c, s = math.cos(a) * W, math.sin(a) * W
        leaves.append(quad((-c, -s, z0), (c, s, z0), (c, s, z1), (-c, -s, z1)))
    d.geometry('tree_trunk300-mesh', [merge('tree_bark', parts)])
    d.geometry('tree_leaves300-mesh', [merge('tree_leaves', leaves)])
    return d.xml([('base00', None, [('start01', None, [('tree_trunk300', 'tree_trunk300-mesh', []), ('tree_leaves300', 'tree_leaves300-mesh', []), ('Colmesh-1', 'tree_trunk300-mesh', [])])])])

def crate_dae():
    d = Dae()
    d.material('crate_wood', image='crate_wood.png')  # no BeamNG material: uses the Collada image path
    d.geometry('crate-mesh', [merge('crate_wood', box_parts(-1, 1, -1, 1, 0, 2, 2.0))])
    return d.xml([('crate', 'crate-mesh', [])])

# ---------------- terrain ----------------
def build_terrain(size, sq, maxh, roads, pads):
    hm = np.zeros((size, size), np.float32)
    ext = (size - 1) * sq
    yy, xx = np.mgrid[0:size, 0:size]
    cx = (xx - (size - 1) / 2) / ((size - 1) / 2); cy = (yy - (size - 1) / 2) / ((size - 1) / 2)
    r2 = cx * cx + cy * cy
    h = 0.12 + 0.62 * np.maximum(0, 1 - r2) ** 1.2 + 0.08 * xx / (size - 1)
    h += 0.05 * noise(size, max(2, size // 12), 21)
    if HEAVY: h += 0.25 * noise(size, size // 6, 22) + 0.15 * np.sin(xx / size * 9) * np.cos(yy / size * 7)
    h = np.clip(h, 0, 1)
    def H(x, y):
        fx, fy = x / sq, y / sq; x0, y0 = int(min(size - 2, max(0, fx))), int(min(size - 2, max(0, fy))); tx, ty = fx - x0, fy - y0
        a = h[y0, x0] * (1 - tx) + h[y0, x0 + 1] * tx; b = h[y0 + 1, x0] * (1 - tx) + h[y0 + 1, x0 + 1] * tx
        return float((a * (1 - ty) + b * ty) * maxh)
    # flatten pads (house plots)
    for (px, py, rad) in pads:
        z = H(px, py) / maxh
        d = np.hypot(xx * sq - px, yy * sq - py)
        w = np.clip((rad + 4 - d) / 4, 0, 1)
        h = h * (1 - w) + z * w
    layer = np.zeros((size, size), np.uint8)  # 0 Grass
    gy, gx = np.gradient(h * maxh, sq)
    slope = np.hypot(gx, gy)
    layer[(h > 0.62) | (slope > 0.55)] = 2           # Rock
    layer[(r2 > 0.85) & (h < 0.2)] = 3               # Sand (no texture in zip -> guessed colour)
    for (px, py, rad) in pads:
        layer[np.hypot(xx * sq - px, yy * sq - py) < rad] = 1   # Dirt
    for nodes in roads:
        for (a, b) in zip(nodes, nodes[1:]):
            ax, ay, bx, by = a[0], a[1], b[0], b[1]
            vx, vy = bx - ax, by - ay; L2 = vx * vx + vy * vy
            t = np.clip(((xx * sq - ax) * vx + (yy * sq - ay) * vy) / L2, 0, 1)
            dd = np.hypot(xx * sq - (ax + t * vx), yy * sq - (ay + t * vy))
            layer[dd < a[3] / 2 + 1.6] = 1
    hm16 = np.round(h * 65535).astype('<u2')
    names = ['Grass', 'Dirt', 'Rock', 'Sand']
    blob = struct.pack('<BI', 8, size) + hm16.tobytes() + layer.tobytes() + struct.pack('<I', len(names)) + b''.join(bytes([len(n)]) + n.encode() for n in names)
    return blob, H

def uidgen():
    return '%08x-%04x-4%03x-%04x-%012x' % (R.getrandbits(32), R.getrandbits(16), R.getrandbits(12), 0x8000 | R.getrandbits(14), R.getrandbits(48))

def rot(deg):
    a = math.radians(deg); c, s = round(math.cos(a), 6), round(math.sin(a), 6)
    return [c, s, 0, -s, c, 0, 0, 0, 1]

def build(out_zip, heavy=False):
    if heavy: size, sq, maxh = 1024, 2.0, 120.0
    else: size, sq, maxh = 128, 1.0, 16.0
    ext = (size - 1) * sq
    roads = ([[12, 40, 0, 6], [40, 44, 0, 6], [70, 52, 0, 8], [100, 60, 0, 6]],
             [[30, 8, 0, 5], [40, 30, 0, 5], [58, 40, 0, 5], [86, 34, 0, 5], [116, 22, 0, 5]])
    if heavy:
        roads = tuple([[R.uniform(0, ext), R.uniform(0, ext), 0, 7] for _ in range(6)] for _ in range(40))
    pads = [(24, 24, 7), (92, 92, 9), (100, 80, 7), (20, 70, 7), (80, 20, 7), (60, 100, 7)] if not heavy else []
    ter, H = build_terrain(size, sq, maxh, roads, pads)
    for nodes in roads:
        for n in nodes: n[2] = round(H(n[0], n[1]), 4)
    L = []
    def rec(d): L.append(json.dumps(d, separators=(',', ':')))
    rec({"name": "test_arranger", "class": "SimGroup", "persistentId": "9e984d07-87af-5032-b108-baadbe050b3e", "__parent": ""})
    rec({"name": "MissionGroup", "class": "SimGroup", "persistentId": "116bcf52-bc70-5cab-8bf7-4c8abc3b1c82", "__parent": "test_arranger"})
    rec({"name": "theTerrain", "class": "TerrainBlock", "persistentId": "603c8b72-983e-562f-9ae5-530df6728c77", "__parent": "MissionGroup", "position": [0, 0, 0], "squareSize": sq, "maxHeight": maxh, "terrainFile": f"{LV}/terrain.ter", "materialTextureSet": "test_arranger_TerrainMaterialTextureSet"})
    def ts(name, shape, x, y, deg=0, sc=(1, 1, 1), parent="MissionGroup"):
        rec({"name": name, "class": "TSStatic", "persistentId": uidgen(), "__parent": parent, "position": [round(x, 4), round(y, 4), round(H(x, y), 4)],
             "shapeName": shape, "collisionType": "Visible Mesh", "decalType": "None", "prebuildCollisionData": 0, "useInstanceRenderData": True,
             "scale": list(sc), "rotationMatrix": rot(deg)})
    if not heavy:
        ts("crate_a", f"/{LV}/box.dae", 24, 24, 0)
        ts("crate_b", f"/{LV}/box.dae", 48, 32, 35, (1.5, 1.2, 1))
        ts("crate_c", f"/{LV}/box.dae", 80, 94, -20, (0.8, 0.8, 1.4))
        for i, (x, y, dg) in enumerate([(92, 92, 15), (100, 80, -30), (20, 70, 90), (80, 20, 5), (60, 100, 180)]):
            ts(f"house_{i + 1}", f"/{LV}/art/shapes/house/house.dae", x, y, dg)
        k = 0
        while k < 28:
            x, y = R.uniform(6, ext - 6), R.uniform(6, ext - 6)
            if any(math.hypot(x - p[0], y - p[1]) < p[2] + 3 for p in pads): continue
            ts(f"tree_{k + 1}", f"art/shapes/tree/tree.dae", x, y, R.uniform(0, 360), (R.uniform(.8, 1.2),) * 3); k += 1
        ts("garage_shared", "/art/shapes/garage/garage_small.dae", 40, 60, 25)               # game-shared: not in zip
        ts("shop_other_level", "/levels/west_coast_usa/art/shapes/buildings/shop_a.dae", 70, 70, -10)  # other level: not in zip
        rec({"name": "main_road", "class": "DecalRoad", "persistentId": "58893254-d250-562d-90d0-a0956502351b", "__parent": "MissionGroup", "position": roads[0][0][:3], "improvedSpline": True, "material": "demo_road", "nodes": roads[0], "breakAngle": 1, "renderPriority": 10, "textureLength": 8, "detail": 0.1})
        rec({"name": "back_road", "class": "DecalRoad", "persistentId": uidgen(), "__parent": "MissionGroup", "position": roads[1][0][:3], "improvedSpline": True, "material": "road_asphalt_2lane", "nodes": roads[1], "breakAngle": 1, "renderPriority": 10, "textureLength": 6.4, "detail": 0.1})
        rec({"name": "spawn_start", "class": "SpawnSphere", "persistentId": "ccc29f96-773b-53db-a2e2-ae8cc24818fb", "__parent": "MissionGroup", "position": [28, 50, round(H(28, 50), 4)], "rotationMatrix": [1, 0, 0, 0, 1, 0, 0, 0, 1], "radius": 2, "spawnClass": "BeamNGVehicle"})
        rec({"name": "wp_hill", "class": "BeamNGWaypoint", "persistentId": "0d2e5b5b-ee1b-5023-acf0-21cbb01142c4", "__parent": "MissionGroup", "position": [64, 64, round(H(64, 64), 4)], "scale": [2, 2, 2], "rotationMatrix": [1, 0, 0, 0, 1, 0, 0, 0, 1]})
        rec({"name": "light_yard", "class": "PointLight", "persistentId": "0f9a7cc1-145a-5e88-978c-f6e5ba78206d", "__parent": "MissionGroup", "position": [36, 70, round(H(36, 70) + 3, 4)], "color": [1, 0.95, 0.8, 1], "radius": 12})
        rec({"name": "poi_view", "class": "BeamNGPointOfInterest", "persistentId": "dfcf9d1e-13e9-5bb5-9125-2a3d74200e17", "__parent": "MissionGroup", "position": [20, 90, round(H(20, 90), 4)], "rotationMatrix": [1, 0, 0, 0, 1, 0, 0, 0, 1]})
        rec({"name": "demo_car", "class": "BeamNGVehicle", "persistentId": "4f45ea1f-7217-5692-9969-c604a07e53ec", "__parent": "MissionGroup", "position": [32, 36, round(H(32, 36), 4)], "rotationMatrix": [0.0, 1.0, 0, -1.0, 0.0, 0, 0, 0, 1], "scale": [1, 1, 1], "JBeam": "pickup"})
        rec({"name": "shed_prefab", "class": "Prefab", "persistentId": "3a4bc242-47c1-5bf1-beb7-2bf5a42cd585", "__parent": "MissionGroup", "position": [72, 24, round(H(72, 24), 4)], "rotationMatrix": [0.965926, 0.258819, 0, -0.258819, 0.965926, 0, 0, 0, 1], "scale": [1, 1, 1], "filename": f"{LV}/shed.prefab"})
    else:
        shapes = [f"/{LV}/art/shapes/house/house.dae", f"art/shapes/tree/tree.dae", f"/{LV}/box.dae", "/art/shapes/garage/garage_small.dae"]
        for i in range(2400):
            sh = shapes[0] if i % 10 == 0 else shapes[2] if i % 10 == 1 else shapes[3] if i % 50 == 7 else shapes[1]
            ts(f"obj_{i}", sh, R.uniform(4, ext - 4), R.uniform(4, ext - 4), R.uniform(0, 360))
        for i, nodes in enumerate(roads):
            rec({"name": f"road_{i}", "class": "DecalRoad", "persistentId": uidgen(), "__parent": "MissionGroup", "position": nodes[0][:3], "material": "demo_road", "nodes": nodes, "textureLength": 8})
    items = '\n'.join(L) + '\n'

    hm = {"house_wall": {"name": "house_wall", "mapTo": "house_wall", "class": "Material", "version": 1.5,
                         "Stages": [{"baseColorMap": "house_wall.color.png"}, {}, {}, {}]},
          "house_roof": {"name": "house_roof", "mapTo": "house_roof", "class": "Material", "version": 1.5,
                         "Stages": [{"baseColorMap": f"/{LV}/art/shapes/house/house_roof.color.dds"}, {}, {}, {}]},
          "house_window": {"name": "house_window", "mapTo": "house_window", "class": "Material",
                           "Stages": [{"diffuseColor": [0.45, 0.62, 0.78, 1]}]}}
    tree_cs = f'''singleton Material(tree_bark_mat)
{{
   mapTo = "tree_bark";
   diffuseMap[0] = "tree_bark";
   doubleSided = "0";
}};

singleton Material(tree_leaves_mat)
{{
   mapTo = "tree_leaves";
   diffuseMap[0] = "{LV}/art/shapes/tree/tree_leaves.dds";
   alphaTest = "1";
   alphaRef = "90";
   doubleSided = "1";
}};
'''
    terr = {f"Grass-{LV}": {"name": f"Grass-test", "internalName": "Grass", "class": "TerrainMaterial", "persistentId": uidgen(),
                            "baseColorBaseTex": f"/{LV}/art/terrains/t_grass_b.png", "baseColorBaseTexSize": 6},
            "Dirt-x": {"name": "Dirt-test", "internalName": "Dirt", "class": "TerrainMaterial", "diffuseMap": f"{LV}/art/terrains/t_dirt_d", "diffuseSize": 5},
            "Rock-x": {"name": "Rock-test", "internalName": "Rock", "class": "TerrainMaterial", "baseColorBaseTex": "t_rock_b.png", "baseColorBaseTexSize": 8},
            "Sand-x": {"name": "Sand-test", "internalName": "Sand", "class": "TerrainMaterial", "baseColorBaseTex": "/levels/common/terrains/sand_b.dds"}}
    # relaxed BeamNG-style json (comments, no commas) to exercise the tolerant parser
    road_mats = '''// road materials
{
  "demo_road": {
    "name": "demo_road"
    "class": "Material"
    "mapTo": "demo_road"
    "Stages": [ { "colorMap": "road_demo.color.png" } {} {} {} ]
    "translucent": true
  }
}
'''
    files = {
        f'{LV}/items.level.json': items.encode(),
        f'{LV}/terrain.ter': ter,
        f'{LV}/info.json': json.dumps({"title": "Arranger demo", "description": "demo"}).encode(),
        f'{LV}/box.dae': crate_dae().encode(),
        f'{LV}/crate_wood.png': to_png(tex_planks()),
        f'{LV}/art/shapes/house/house.dae': house_dae().encode(),
        f'{LV}/art/shapes/house/main.materials.json': json.dumps(hm, indent=1).encode(),
        f'{LV}/art/shapes/house/house_wall.color.png': to_png(tex_brick()),
        f'{LV}/art/shapes/house/house_roof.color.dds': dds(tex_roof(), b'DXT1'),
        f'{LV}/art/shapes/tree/tree.dae': tree_dae().encode(),
        f'{LV}/art/shapes/tree/materials.cs': tree_cs.encode(),
        f'{LV}/art/shapes/tree/tree_bark.png': to_png(tex_bark()),
        f'{LV}/art/shapes/tree/tree_leaves.dds': dds(tex_leaves(), b'DXT5'),
        f'{LV}/art/terrains/main.materials.json': json.dumps(terr, indent=1).encode(),
        f'{LV}/art/terrains/t_grass_b.png': to_png(tex_grass()),
        f'{LV}/art/terrains/t_dirt_d.dds': dds(tex_dirt(), b'DXT1'),
        f'{LV}/art/terrains/t_rock_b.png': to_png(tex_rock()),
        f'{LV}/art/road/main.materials.json': road_mats.encode(),
        f'{LV}/art/road/road_demo.color.png': to_png(tex_road()),
    }
    with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED) as z:
        for k, v in files.items(): z.writestr(k, v)
    return files

if __name__ == '__main__':
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    if HEAVY:
        out = sys.argv[sys.argv.index('--heavy') + 1]
        build(out, heavy=True); print('heavy ->', out, os.path.getsize(out))
    else:
        files = build(os.path.join(root, 'testdata/level.zip'))
        open(os.path.join(root, 'testdata/items.level.json'), 'wb').write(files[f'{LV}/items.level.json'])
        open(os.path.join(root, 'testdata/terrain.ter'), 'wb').write(files[f'{LV}/terrain.ter'])
        open(os.path.join(root, 'testdata/box.dae'), 'wb').write(files[f'{LV}/box.dae'])
        import base64
        open(os.path.join(root, 'testdata/level.zip.b64'), 'w').write(base64.encodebytes(open(os.path.join(root, 'testdata/level.zip'), 'rb').read()).decode())
        print('demo ->', os.path.getsize(os.path.join(root, 'testdata/level.zip')), 'bytes')
