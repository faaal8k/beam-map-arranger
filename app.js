import * as THREE from './vendor/three.module.min.js';
import { AssetStore, yieldUI, dirOf, avgColor } from './assets.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
});
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const coarse = typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);
const PLACED = ['TSStatic', 'Prefab', 'TSForestItemData', 'BeamNGWaypoint', 'SpawnSphere', 'PointLight', 'BeamNGPointOfInterest', 'BeamNGVehicle'];
const COL = {
  TSStatic: 0x3b82f6, DecalRoad: 0xfbbf24, Prefab: 0xa855f7, TSForestItemData: 0x16a34a,
  BeamNGWaypoint: 0x22d3ee, SpawnSphere: 0x4ade80, PointLight: 0xfacc15,
  BeamNGPointOfInterest: 0xf472b6, BeamNGVehicle: 0xea580c
};

const S = {
  groups: [], objs: [], ter: null, block: null, sel: null, selNode: -1,
  undo: [], redo: [], zipFiles: null, dae: new Map(),
  addType: 'TSStatic', filter: '', autoZ: false, adding: false,
  mode: '3d', show: { ts: true, rd: true, ot: true, grid: true, names: false },
  clipboard: null, shapeSel: '', roadMat: 'road_asphalt_2lane',
  assets: null, assetGen: 0, shapeByName: new Map(), roadMats: new Map(), terTex: null, terLayers: null,
  astat: null
};

const isPlaced = r => Array.isArray(r.position) && PLACED.includes(r.class);
const readText = async e => (e.text ? await e.text() : await e.async('string'));
const readBuf = async e => (e.arrayBuffer ? await e.arrayBuffer() : await e.async('arraybuffer'));
const INTERNAL = new Set(['__src', '__dirty', '__raw', '__u']);
const clean = r => { const o = {}; for (const k in r) if (!INTERNAL.has(k)) o[k] = r[k]; return o; };
const dirty = r => { r.__dirty = true; };
const scl = r => Array.isArray(r.scale) ? r.scale.slice() : [1, 1, 1];

function rotZ(r) {
  if (Array.isArray(r.rotationMatrix) && r.rotationMatrix.length >= 9)
    return Math.atan2(r.rotationMatrix[3], r.rotationMatrix[0]);
  if (Array.isArray(r.rotation) && r.rotation.length >= 4) {
    const [a, b, c, ang] = r.rotation; const d = ang * Math.PI / 180;
    return Math.abs(c) >= Math.abs(a) && Math.abs(c) >= Math.abs(b) ? (c >= 0 ? d : -d) : 0;
  }
  return 0;
}
function setRotZ(r, rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  r.rotationMatrix = [c, s, 0, -s, c, 0, 0, 0, 1];
  delete r.rotation; dirty(r);
}
function rotMat(r) {
  if (Array.isArray(r.rotationMatrix) && r.rotationMatrix.length >= 9) return r.rotationMatrix.slice();
  const a = rotZ(r), c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}
function composeYaw(r, dRad) {
  const m = rotMat(r);
  const c = Math.cos(dRad), s = Math.sin(dRad);
  // Rz * M  (world-Z yaw), Rz = [c,-s,0; s,c,0; 0,0,1] in standard math...
  // Our stored matrix is row-major M*v, and setRotZ(rad)=[c,s,0,-s,c,0,0,0,1]
  // That Rz(d) is [c,s,0,-s,c,0,0,0,1]. New = Rz * M:
  const z = [c, s, 0, -s, c, 0, 0, 0, 1];
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    o[i * 3 + j] = z[i * 3] * m[j] + z[i * 3 + 1] * m[3 + j] + z[i * 3 + 2] * m[6 + j];
  r.rotationMatrix = o; delete r.rotation; dirty(r);
}

/* ---------- load / parse ---------- */
async function loadFiles(list) {
  const msg = $('msg'); if (msg) msg.textContent = 'جاري القراءة...';
  try {
    const raw = new Map();
    for (const f of list) {
      if (/\.zip$/i.test(f.name)) {
        const z = await JSZip.loadAsync(f);
        for (const [p, e] of Object.entries(z.files)) if (!e.dir) raw.set(p, e);
      } else raw.set(f.name, f);
    }
    S.zipFiles = raw; S.groups = []; S.objs = []; S.ter = null; S.block = null;
    S.sel = null; S.selNode = -1; S.undo = []; S.redo = []; S.dae.clear();
    let nItems = 0;
    for (const [p, e] of raw) {
      if (!/items\.level\.json$/i.test(p)) continue;
      const txt = await readText(e);
      const lines = txt.split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const recs = [];
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) { recs.push({ __raw: ln }); continue; }
        try { const r = JSON.parse(t); r.__src = ln; recs.push(r); }
        catch { recs.push({ __raw: ln }); }
      }
      const g = { path: p, recs }; S.groups.push(g); nItems++;
      for (const r of recs) {
        if (r.__raw) continue;
        if (r.class === 'TerrainBlock' && !S.block) S.block = r;
        if (r.class === 'TSStatic' || r.class === 'DecalRoad' || isPlaced(r))
          S.objs.push({ r, g, cls: r.class });
      }
    }
    if (!nItems) throw new Error('ما لقيت items.level.json في الملفات.');
    if (S.block) {
      const tp = (S.block.terrainFile || '').replace(/^\/+/, '').toLowerCase();
      const parts = tp.split('/').filter(Boolean);
      const tail3 = parts.slice(-3).join('/');
      const base = parts[parts.length - 1] || '';
      let tf = null;
      for (const [p, e] of raw) {
        if (!/\.ter$/i.test(p)) continue;
        const pl = p.replace(/^\/+/, '').toLowerCase();
        if (tp && (pl.endsWith(tail3) || pl.endsWith(base) || pl === tp)) { tf = e; break; }
        if (!tf) tf = e;
      }
      if (tf) S.ter = parseTer(await readBuf(tf));
      if (S.ter && !S.ter.mats.length) {
        for (const [p, e] of raw) {
          if (!/\.terrain\.json$/i.test(p)) continue;
          try { const j = JSON.parse(await readText(e)); if (Array.isArray(j.materials)) { S.ter.mats = j.materials.map(String); break; } } catch (_) {}
        }
      }
    }
    await loadDaeBounds();
    $('intro').style.display = 'none';
    rebuildObjs();
    terrainDirty = true;
    rebuildMeshes();
    fit();
    S.sel = null; renderSheet(); render();
    toast('تم: ' + S.objs.length + ' عنصر' + (S.ter ? ' + تضاريس ' + S.ter.size + '×' + S.ter.size : ' (بدون ملف .ter)'));
    S.realLoading = startRealLoad();
  } catch (e) { if (msg) msg.textContent = 'خطأ: ' + e.message; else alert(e.message); }
}

function parseTer(buf) {
  const v = new DataView(buf); const ver = v.getUint8(0);
  if (ver < 7 || ver > 9) throw new Error('نسخة .ter غير مدعومة: ' + ver);
  const size = v.getUint32(1, true);
  const hm = new Uint16Array(buf.slice(5, 5 + size * size * 2));
  // layer map (one material index per vertex, 255 = hole) + material names
  let layer = null, mats = [];
  let off = 5 + size * size * 2;
  if (buf.byteLength >= off + size * size) {
    layer = new Uint8Array(buf.slice(off, off + size * size)); off += size * size;
    try {
      if (buf.byteLength >= off + 4) {
        const n = v.getUint32(off, true); off += 4;
        if (n > 0 && n < 256) for (let i = 0; i < n && off < buf.byteLength; i++) {
          const len = v.getUint8(off); off += 1;
          mats.push(new TextDecoder().decode(new Uint8Array(buf, off, Math.min(len, buf.byteLength - off)))); off += len;
        }
      }
    } catch (_) { mats = []; }
  }
  return { size, hm, ver, layer, mats };
}
function T() {
  const b = S.block; if (!b || !S.ter) return null;
  const sq = +b.squareSize || 1;
  return { px: b.position[0], py: b.position[1], pz: b.position[2] || 0, sq, mh: +b.maxHeight || 0, size: S.ter.size, ext: (S.ter.size - 1) * sq };
}
function heightAt(x, y) {
  const t = T(); if (!t) return 0;
  const fx = (x - t.px) / t.sq, fy = (y - t.py) / t.sq;
  if (fx < 0 || fy < 0 || fx >= t.size - 1 || fy >= t.size - 1) return t.pz;
  const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
  const h = (i, j) => S.ter.hm[j * t.size + i];
  const a = h(x0, y0) * (1 - tx) + h(x0 + 1, y0) * tx;
  const b = h(x0, y0 + 1) * (1 - tx) + h(x0 + 1, y0 + 1) * tx;
  return t.pz + (a * (1 - ty) + b * ty) * t.mh / 65536;
}

async function loadDaeBounds() {
  const names = new Set();
  for (const o of S.objs) {
    if (o.cls === 'TSStatic' && o.r.shapeName) names.add(o.r.shapeName);
    if (o.r.shapeFile) names.add(o.r.shapeFile);
  }
  for (const nm of names) {
    const key = nm.replace(/^\/+/, '').toLowerCase();
    let ent = null;
    for (const [p, e] of S.zipFiles) {
      const pl = p.replace(/^\/+/, '').toLowerCase();
      if (pl.endsWith('.dae') && (pl === key || key.endsWith(pl) || pl.endsWith(key))) { ent = e; break; }
    }
    if (!ent) continue;
    try {
      const sz = ent._data ? ent._data.uncompressedSize : ent.size;
      if (sz > 60e6) continue;
      const txt = await readText(ent);
      const up = (/<up_axis>\s*([XYZ])_UP/i.exec(txt) || [])[1] || 'Z';
      const sm = /<unit[^>]*meter="([\d.eE+-]+)"/.exec(txt); const um = sm ? +sm[1] : 1;
      let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
      const re = /<float_array[^>]*id="[^"]*(?:positions|position)[^"]*"[^>]*>([^<]+)</gi; let m;
      while ((m = re.exec(txt))) {
        const a = m[1].trim().split(/\s+/);
        for (let i = 0; i + 2 < a.length; i += 3) {
          const x = +a[i], y = +a[i + 1], z = +a[i + 2];
          if (x < mnx) mnx = x; if (x > mxx) mxx = x;
          if (y < mny) mny = y; if (y > mxy) mxy = y;
          if (z < mnz) mnz = z; if (z > mxz) mxz = z;
        }
      }
      if (mnx > 1e8) continue;
      let b = { x0: mnx * um, x1: mxx * um, y0: mny * um, y1: mxy * um, z0: mnz * um, z1: mxz * um };
      if (up === 'Y') b = { x0: mnx * um, x1: mxx * um, y0: -mxz * um, y1: -mnz * um, z0: mny * um, z1: mxy * um };
      S.dae.set(nm, b);
    } catch (_) {}
  }
}

/* ---------- real look: shapes, materials, terrain layers ---------- */
const SHAPED = new Set(['TSStatic', 'TSForestItemData']);
const shapeRef = o => SHAPED.has(o.cls) ? (o.r.shapeName || o.r.shapeFile || '') : '';
function levelRoot(p) { const m = /^(.*?(?:^|\/)levels\/[^/]+)/i.exec(String(p).replace(/\\/g, '/')); return m ? m[1] : dirOf(p); }
const isPhone = () => Math.min(viewW, viewH) < 700 || coarse;
let terrainDirty = true, realRebuildT = 0;
function scheduleRealRebuild(now) {
  clearTimeout(realRebuildT);
  const run = () => { if (pts.size || gesturing) { realRebuildT = setTimeout(run, 250); return; } rebuildMeshes(); render(); };
  if (now) run(); else realRebuildT = setTimeout(run, 220);
}
function setAssetStatus() {
  const a = S.astat, el = $('assetStatus'); if (!el) return;
  if (!a) { el.hidden = true; return; }
  let h = '';
  if (a.loading) h += `<span class="spin"></span> جاري تحميل الأشكال الحقيقية <span class="n">${a.done}/${a.total}</span>`;
  else if (a.total) h += `أشكال حقيقية: <span class="n">${a.found}/${a.total}</span> ملف`;
  else h += 'لا توجد ملفات أشكال';
  if (a.total && (a.missing || a.failed)) h += ` · <b>${a.missing + a.failed}</b> صندوق` + (a.missing ? ` (${a.missing} غير موجود بالملف)` : '') + (a.failed ? ` (${a.failed} تعذّرت قراءته)` : '');
  if (a.tex) h += ` · خامات <span class="n">${a.tex.found}/${a.tex.found + a.tex.missing + a.tex.failed}</span>` + (a.tex.bc7 ? ` (${a.tex.bc7} بصيغة BC7 غير مدعومة)` : '');
  if (a.terrain) h += ` · أرض: ${a.terrain}`;
  el.innerHTML = h; el.hidden = false; placeStatus();
}
function placeStatus() {
  const el = $('assetStatus'), hd = $('hud'); if (!el || el.hidden || !hd) return;
  el.style.top = (hd.offsetTop + hd.offsetHeight + 6) + 'px';
}
const GUESS = [[/grass|lawn|meadow|field/i, [0.33, 0.45, 0.2]], [/sand|beach|desert/i, [0.76, 0.68, 0.5]], [/rock|cliff|stone|gravel/i, [0.5, 0.48, 0.45]],
  [/dirt|mud|soil|ground/i, [0.45, 0.36, 0.25]], [/asphalt|road|tarmac/i, [0.22, 0.22, 0.23]], [/snow|ice/i, [0.92, 0.94, 0.97]], [/forest|leaf|moss/i, [0.24, 0.34, 0.16]], [/concrete|cement/i, [0.62, 0.62, 0.6]]];
const PAL = [[0.36, 0.46, 0.24], [0.5, 0.42, 0.3], [0.52, 0.5, 0.47], [0.7, 0.64, 0.48], [0.3, 0.38, 0.2], [0.42, 0.33, 0.24]];
function guessColor(nm, i) { for (const [re, c] of GUESS) if (re.test(nm)) return c; return PAL[i % PAL.length]; }

async function bakeTerrain(st, gen) {
  const t = T(); if (!t || !S.ter || !S.ter.layer) return null;
  const root = levelRoot(S.block && S.block.terrainFile || (S.groups[0] && S.groups[0].path) || '');
  const layers = [];
  let withTex = 0;
  for (let i = 0; i < Math.max(1, S.ter.mats.length); i++) {
    const nm = S.ter.mats[i] || 'layer' + i;
    const def = st.mats.terrain.get(nm.toLowerCase()) || null;
    let px = null;
    if (def && def.colorMap) px = await st.pixels(def.colorMap, [def.dir, root], 256);
    if (gen !== S.assetGen) return null;
    if (px) withTex++;
    layers.push({ nm, px, avg: px ? avgColor(px) : (def && def.color ? def.color : guessColor(nm, i)), tile: def && def.tile > 0 ? def.tile : 8 });
  }
  S.terLayers = layers;
  const N = Math.max(256, Math.min(isPhone() ? 1024 : 2048, 2 ** Math.ceil(Math.log2(t.ext / 0.1))));
  const data = new Uint8Array(N * N * 4);
  const L = S.ter.layer, sz = t.size;
  const toLin = c => c; // sampling in sRGB space; the texture is tagged sRGB
  const sample = (ly, x, y, out, w) => {
    const l = layers[ly];
    if (!l) return 0;
    if (l.px) {
      const u = ((x / l.tile) % 1 + 1) % 1, v = ((y / l.tile) % 1 + 1) % 1;
      const k = (Math.min(l.px.h - 1, ((1 - v) * l.px.h) | 0) * l.px.w + Math.min(l.px.w - 1, (u * l.px.w) | 0)) * 4;
      out[0] += l.px.data[k] * w; out[1] += l.px.data[k + 1] * w; out[2] += l.px.data[k + 2] * w;
    } else { out[0] += toLin(l.avg[0]) * 255 * w; out[1] += toLin(l.avg[1]) * 255 * w; out[2] += toLin(l.avg[2]) * 255 * w; }
    return w;
  };
  const acc = [0, 0, 0];
  for (let j = 0; j < N; j++) {
    const gy = Math.min(sz - 1.001, ((j + 0.5) / N) * (sz - 1)), y0 = gy | 0, fy = gy - y0;
    const wy = t.py + ((j + 0.5) / N) * t.ext;
    for (let i = 0; i < N; i++) {
      const gx = Math.min(sz - 1.001, ((i + 0.5) / N) * (sz - 1)), x0 = gx | 0, fx = gx - x0;
      const wx = t.px + ((i + 0.5) / N) * t.ext;
      acc[0] = acc[1] = acc[2] = 0; let wsum = 0;
      const a = L[y0 * sz + x0], b = L[y0 * sz + x0 + 1], c = L[(y0 + 1) * sz + x0], d = L[(y0 + 1) * sz + x0 + 1];
      if (a === b && a === c && a === d) { if (a !== 255) wsum = sample(a, wx, wy, acc, 1); }
      else {
        if (a !== 255) wsum += sample(a, wx, wy, acc, (1 - fx) * (1 - fy));
        if (b !== 255) wsum += sample(b, wx, wy, acc, fx * (1 - fy));
        if (c !== 255) wsum += sample(c, wx, wy, acc, (1 - fx) * fy);
        if (d !== 255) wsum += sample(d, wx, wy, acc, fx * fy);
      }
      const k = (j * N + i) * 4;
      if (wsum > 0) { data[k] = acc[0] / wsum; data[k + 1] = acc[1] / wsum; data[k + 2] = acc[2] / wsum; }
      else { data[k] = 90; data[k + 1] = 90; data[k + 2] = 90; }
      data[k + 3] = 255;
    }
    if ((j & 63) === 63) { await yieldUI(); if (gen !== S.assetGen) return null; }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = isPhone() ? 4 : 8; tex.needsUpdate = true;
  tex.onUpdate = () => { tex.image = { width: N, height: N, data: null }; };
  S.astat.terrain = withTex ? `${withTex}/${layers.length} طبقة بخامتها` : `${layers.length} طبقة بألوان تقريبية`;
  return tex;
}

async function ensureShape(o) {
  const ref = shapeRef(o); if (!ref || !S.assets) { rebuildMeshes(); render(); return; }
  if (!S.shapeByName.has(ref)) {
    const res = await S.assets.shape(ref, [dirOf(o.g.path), levelRoot(o.g.path)]);
    if (res && !res.error) { S.shapeByName.set(ref, res); S.dae.set(ref, res.bounds); }
  }
  rebuildMeshes(); renderSheet(true); render();
}
async function startRealLoad() {
  const gen = ++S.assetGen;
  if (S.assets) S.assets.dispose();
  if (S.terTex) { S.terTex.dispose(); S.terTex = null; }
  S.shapeByName = new Map(); S.roadMats = new Map(); S.terLayers = null;
  const st = new AssetStore(S.zipFiles, isPhone()); S.assets = st;
  const refs = new Map();
  for (const o of S.objs) { const r = shapeRef(o); if (r && !refs.has(r)) refs.set(r, [dirOf(o.g.path), levelRoot(o.g.path)]); }
  S.astat = { loading: true, total: refs.size, done: 0, found: 0, missing: 0, failed: 0, tex: st.texStats, terrain: '' };
  setAssetStatus();
  try {
    await st.init(); if (gen !== S.assetGen) return;
    const tt = await bakeTerrain(st, gen); if (gen !== S.assetGen) { tt && tt.dispose(); return; }
    if (tt) { S.terTex = tt; terrainDirty = true; scheduleRealRebuild(true); }
    // road materials
    const roadNames = new Set(S.objs.filter(o => o.cls === 'DecalRoad' && o.r.material).map(o => o.r.material));
    for (const nm of roadNames) {
      const def = st.mats.find(nm); if (!def || !def.colorMap) continue;
      const tex = await st.texture(def.colorMap, [def.dir, levelRoot(S.groups[0].path)]);
      if (gen !== S.assetGen) return;
      if (tex) S.roadMats.set(nm, { tex, def });
    }
    if (S.roadMats.size) scheduleRealRebuild();
    for (const [ref, bases] of refs) {
      const res = await st.shape(ref, bases);
      if (gen !== S.assetGen) return;
      S.astat.done++;
      if (!res) S.astat.missing++;
      else if (res.error) { S.astat.failed++; console.warn('dae', ref, res.error); }
      else { S.astat.found++; S.shapeByName.set(ref, res); S.dae.set(ref, res.bounds); scheduleRealRebuild(); }
      setAssetStatus();
      await yieldUI();
    }
  } catch (e) { console.warn('real assets', e); }
  if (gen !== S.assetGen) return;
  S.astat.loading = false; setAssetStatus();
  scheduleRealRebuild(true);
  if (S.sel) renderSheet(true);
}

function defaultBounds(cls) {
  if (cls === 'TSStatic' || cls === 'Prefab' || cls === 'BeamNGVehicle') return { x0: -1, x1: 1, y0: -1, y1: 1, z0: 0, z1: 2 };
  if (cls === 'TSForestItemData') return { x0: -.6, x1: .6, y0: -.6, y1: .6, z0: 0, z1: 3 };
  return { x0: -.6, x1: .6, y0: -.6, y1: .6, z0: 0, z1: 1.2 };
}
function boundsOf(o) {
  const nm = o.r.shapeName || o.r.shapeFile;
  return (nm && S.dae.get(nm)) || defaultBounds(o.cls);
}

/* ---------- undo / export ---------- */
function recsSnap() { return JSON.stringify(S.groups.map(g => g.recs)); }
function restore(u) {
  const all = JSON.parse(u.s);
  S.groups.forEach((g, i) => { g.recs = all[i]; });
  rebuildObjs();
  S.sel = u.sel >= 0 ? S.objs[u.sel] || null : null;
  S.selNode = u.node ?? -1;
  rebuildMeshes(); renderSheet(); render();
}
function push() {
  S.undo.push({ s: recsSnap(), sel: S.sel ? S.objs.indexOf(S.sel) : -1, node: S.selNode });
  if (S.undo.length > 60) S.undo.shift();
  S.redo.length = 0;
}
let gesturing = false, gestureDirty = false;
function beginEdit() { if (!gesturing) { gesturing = true; gestureDirty = false; push(); } }
function markGesture() { gestureDirty = true; if (S.sel) dirty(S.sel.r); }
function endEdit() {
  if (!gesturing) return;
  gesturing = false;
  if (!gestureDirty) S.undo.pop();
  gestureDirty = false;
}
function doUndo() {
  const u = S.undo.pop(); if (!u) return toast('ما فيه شيء للتراجع');
  S.redo.push({ s: recsSnap(), sel: S.sel ? S.objs.indexOf(S.sel) : -1, node: S.selNode });
  restore(u); toast('↶ تراجع');
}
function doRedo() {
  const u = S.redo.pop(); if (!u) return toast('ما فيه شيء للإعادة');
  S.undo.push({ s: recsSnap(), sel: S.sel ? S.objs.indexOf(S.sel) : -1, node: S.selNode });
  restore(u); toast('↷ إعادة');
}
function rebuildObjs() {
  S.objs = []; S.block = null;
  for (const g of S.groups) for (const r of g.recs) {
    if (r.__raw) continue;
    if (r.class === 'TerrainBlock' && !S.block) S.block = r;
    if (r.class === 'TSStatic' || r.class === 'DecalRoad' || isPlaced(r)) S.objs.push({ r, g, cls: r.class });
  }
}

function exportText() {
  return S.groups.map(g => ({
    path: g.path,
    txt: g.recs.map(r => {
      if (r.__raw !== undefined) return r.__raw;
      if (!r.__dirty && r.__src !== undefined) return r.__src;
      return JSON.stringify(clean(r));
    }).join('\n') + '\n'
  }));
}
async function doExport() {
  try {
    const files = exportText();
    const z = new JSZip();
    for (const f of files) z.file(f.path, f.txt);
    z.file('README.txt', 'ملفات items.level.json المعدّلة. انسخها فوق الأصلية في مجلد المستوى (levels/<اسم>/...) واحتفظ بنسخة احتياطية.\nملاحظة: المجسمات الجديدة تحتاج ملف .dae موجود في نفس المستوى.\n');
    const b = await z.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    dl(b, 'level-edited.zip');
    toast('تم التصدير (' + files.length + ' ملف)');
  } catch (e) { alert('فشل التصدير: ' + e.message); }
}
function dl(b, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}


/* ---------- three.js scene ---------- */
const cv = $('cv');
const overlay = $('overlay');
let renderer, scene, persp, ortho, camera, sun, hemi, terrainMesh, objGroup, realGroup, gridMesh;
const SKY_HORIZON = 0xb9cde0;
const raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const camState = { target: new THREE.Vector3(40, 40, 8), dist: 140, yaw: -Math.PI * 0.38, pitch: 0.62, ortho: 70 };
let viewW = 1, viewH = 1, dpr = 1, needRender = true;

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setClearColor(SKY_HORIZON, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.Fog(SKY_HORIZON, 200, 600);
  persp = new THREE.PerspectiveCamera(50, 1, 0.3, 4000);
  persp.up.set(0, 0, 1);
  ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.3, 4000);
  ortho.up.set(0, 1, 0);
  camera = persp;
  hemi = new THREE.HemisphereLight(0xd6e6ff, 0x4a3f30, 1.15);
  hemi.position.set(0, 0, 1);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
  sun.position.set(-60, -90, 110);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x8090a0, 0.25));
  objGroup = new THREE.Group();
  scene.add(objGroup);
  realGroup = new THREE.Group();
  scene.add(realGroup);
  resize();
  new ResizeObserver(() => resize()).observe($('stage'));
  addEventListener('resize', () => setTimeout(resize, 50));
  loop();
}
function skyTexture() {
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#4f86c6'); gr.addColorStop(0.55, '#9fc0e2'); gr.addColorStop(1, '#' + SKY_HORIZON.toString(16));
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function resize() {
  if (!renderer) return;
  const r = $('stage').getBoundingClientRect();
  viewW = Math.max(1, r.width); viewH = Math.max(1, r.height);
  dpr = Math.min(window.devicePixelRatio || 1, isPhone() ? 2 : 3);
  renderer.setPixelRatio(dpr);
  renderer.setSize(viewW, viewH, false);
  persp.aspect = viewW / viewH; persp.updateProjectionMatrix();
  updateCamera(); needRender = true;
}
function updateCamera() {
  const t = camState.target;
  if (scene.fog) {
    if (S.mode === '2d') { scene.fog.near = 4000; scene.fog.far = 8000; }
    else { scene.fog.near = camState.dist * 2.5; scene.fog.far = camState.dist * 9; }
  }
  if (S.mode === '2d') {
    camera = ortho;
    const h = camState.ortho, a = viewW / Math.max(1, viewH);
    ortho.left = -h * a; ortho.right = h * a; ortho.top = h; ortho.bottom = -h;
    ortho.position.set(t.x, t.y, Math.max(t.z, 0) + 400);
    ortho.up.set(0, 1, 0);
    ortho.lookAt(t.x, t.y, t.z);
    ortho.near = 1; ortho.far = 2000;
    ortho.updateProjectionMatrix();
  } else {
    camera = persp;
    const cp = Math.cos(camState.pitch), sp = Math.sin(camState.pitch);
    camera.up.set(0, 0, 1);
    camera.position.set(
      t.x + camState.dist * cp * Math.cos(camState.yaw),
      t.y + camState.dist * cp * Math.sin(camState.yaw),
      t.z + camState.dist * sp
    );
    camera.lookAt(t);
    camera.updateProjectionMatrix();
  }
  needRender = true;
}
function fit() {
  const t = T();
  let x0 = -40, x1 = 40, y0 = -40, y1 = 40, z0 = 0, z1 = 10;
  if (t) { x0 = t.px; y0 = t.py; x1 = t.px + t.ext; y1 = t.py + t.ext; z0 = t.pz; z1 = t.pz + t.mh; }
  else if (S.objs.length) {
    x0 = y0 = 1e9; x1 = y1 = -1e9;
    for (const o of S.objs) {
      const p = o.r.position || (o.r.nodes && o.r.nodes[0]); if (!p) continue;
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      z0 = Math.min(z0, p[2] || 0); z1 = Math.max(z1, p[2] || 0);
    }
    x0 -= 20; y0 -= 20; x1 += 20; y1 += 20;
  }
  camState.target.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const span = Math.max(x1 - x0, y1 - y0, 20);
  camState.dist = span * 1.55;
  const aspect = viewW / Math.max(1, viewH);
  camState.ortho = Math.max(span * 0.55, (span * 0.55) / aspect);
  camState.yaw = -Math.PI * 0.38; camState.pitch = 0.62;
  updateCamera(); render();
}
function focusObj(o) {
  if (!o) return;
  const b = worldBox(o);
  camState.target.set((b.s0 + b.s1) / 2, (b.z0 + b.z1) / 2, (b.y0 + b.y1) / 2);
  const span = Math.max(b.s1 - b.s0, b.z1 - b.z0, 4);
  camState.dist = Math.max(18, span * 7);
  camState.ortho = Math.max(8, span * 2.4);
  updateCamera(); render();
}
function setMode(m) {
  S.mode = m === '2d' ? '2d' : '3d';
  $('bMode').textContent = S.mode === '2d' ? '2د' : '3د';
  $('bMode').classList.toggle('on', S.mode === '2d');
  updateCamera(); updateOverlay(); render();
}

function project(x, y, z) {
  _v.set(x, y, z).project(camera);
  return [(_v.x * 0.5 + 0.5) * viewW, (-_v.y * 0.5 + 0.5) * viewH];
}
function ndcFrom(cx, cy) {
  const r = cv.getBoundingClientRect();
  _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
}
function setRay(cx, cy) { ndcFrom(cx, cy); raycaster.setFromCamera(_ndc, camera); }
function hitTerrainAt(cx, cy) {
  setRay(cx, cy);
  if (terrainMesh) {
    const hs = raycaster.intersectObject(terrainMesh, false);
    if (hs[0]) return hs[0].point.clone();
  }
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(S.sel && S.sel.r.position ? S.sel.r.position[2] : 0));
  const p = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, p)) return p;
  return null;
}

function applyTRS(mesh, r, extraZ = 0) {
  const p = r.position || [0, 0, 0];
  const sc = scl(r); const m = rotMat(r);
  const R = new THREE.Matrix4().set(
    m[0], m[1], m[2], 0,
    m[3], m[4], m[5], 0,
    m[6], m[7], m[8], 0,
    0, 0, 0, 1
  );
  const Tm = new THREE.Matrix4().makeTranslation(p[0], p[1], (p[2] || 0) + extraZ);
  const Sm = new THREE.Matrix4().makeScale(sc[0], sc[1], sc[2]);
  mesh.matrix.copy(Tm).multiply(R).multiply(Sm);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrixWorld(true);
}

function makeTerrain() {
  if (terrainMesh) { scene.remove(terrainMesh); terrainMesh.geometry.dispose(); terrainMesh.material.dispose(); terrainMesh = null; }
  terrainDirty = false;
  const t = T(); if (!t) return;
  const L = S.ter.layer, lay = S.terLayers;
  const phone = Math.min(viewW, viewH) < 700 || coarse;
  const maxN = phone ? 192 : 256;
  const n = Math.min(t.size, maxN);
  const geo = new THREE.PlaneGeometry(1, 1, n - 1, n - 1);
  // PlaneGeometry is XY, z=0, centered; we'll overwrite vertices in Z-up: x,y horizontal, z height
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  let lo = 1e9, hi = -1e9;
  const hm = S.ter.hm;
  for (let i = 0; i < hm.length; i += Math.max(1, (hm.length / 4000) | 0)) { if (hm[i] < lo) lo = hm[i]; if (hm[i] > hi) hi = hm[i]; }
  const rg = Math.max(1, hi - lo);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const idx = j * n + i;
    const x = t.px + (i / (n - 1)) * t.ext;
    const y = t.py + (j / (n - 1)) * t.ext;
    const z = heightAt(x, y);
    pos.setXYZ(idx, x, y, z);
    geo.attributes.uv.setXY(idx, i / (n - 1), j / (n - 1));
    const si = Math.min(t.size - 1, ((j / (n - 1)) * (t.size - 1)) | 0) * t.size + Math.min(t.size - 1, ((i / (n - 1)) * (t.size - 1)) | 0);
    if (L && !S.terTex) { // quick per-layer colours until textures are baked
      const ly = L[si]; const c = ly === 255 ? [0.35, 0.35, 0.35] : (lay && lay[ly] ? lay[ly].avg : guessColor((S.ter.mats[ly] || ''), ly));
      col[idx * 3] = c[0]; col[idx * 3 + 1] = c[1]; col[idx * 3 + 2] = c[2];
    } else {
      const u = (S.ter.hm[si] - lo) / rg;
      const sh = 0.55 + 0.45 * u;
      col[idx * 3] = (70 + u * 110) / 255 * sh;
      col[idx * 3 + 1] = (100 + u * 80) / 255 * sh;
      col[idx * 3 + 2] = (60 + u * 50) / 255 * sh;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = S.terTex ? new THREE.MeshLambertMaterial({ map: S.terTex, side: THREE.DoubleSide })
    : new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  terrainMesh = new THREE.Mesh(geo, mat);
  terrainMesh.receiveShadow = false;
  terrainMesh.matrixAutoUpdate = true;
  terrainMesh.frustumCulled = false;
  scene.add(terrainMesh);
}

function boxGeoFrom(b) {
  const w = Math.max(0.05, b.x1 - b.x0), d = Math.max(0.05, b.y1 - b.y0), h = Math.max(0.05, b.z1 - b.z0);
  const geo = new THREE.BoxGeometry(w, d, h);
  geo.translate((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
  return geo;
}

const PROXY_MAT = new THREE.MeshBasicMaterial({ visible: false });
const SEL_EDGE = new THREE.LineBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.85, depthTest: false });
PROXY_MAT.userData.shared = SEL_EDGE.userData.shared = true;
function makeObjectMesh(o) {
  const col = COL[o.cls] || 0x94a3b8;
  if (o.cls === 'DecalRoad') return makeRoadMesh(o);
  let mesh;
  const real = S.shapeByName.get(shapeRef(o));
  if (real) {
    // the real mesh is drawn by an instanced batch; this box is the pick proxy and the selection hint
    if (!real.proxyGeo) { real.proxyGeo = boxGeoFrom(real.bounds); real.proxyGeo.userData.shared = true; }
    mesh = new THREE.Mesh(real.proxyGeo, PROXY_MAT);
    mesh.userData.real = real;
  } else if (o.cls === 'TSStatic' || o.cls === 'Prefab' || o.cls === 'BeamNGVehicle') {
    const geo = boxGeoFrom(boundsOf(o));
    const mat = new THREE.MeshLambertMaterial({ color: col, transparent: true, opacity: 0.88 });
    mesh = new THREE.Mesh(geo, mat);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    mesh.add(edges);
  } else if (o.cls === 'SpawnSphere' || o.cls === 'PointLight') {
    const mat = new THREE.MeshLambertMaterial({ color: col, transparent: true, opacity: 0.9 });
    mesh = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), mat);
  } else if (o.cls === 'BeamNGWaypoint' || o.cls === 'BeamNGPointOfInterest') {
    const mat = new THREE.MeshLambertMaterial({ color: col });
    mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.8), mat);
  } else if (o.cls === 'TSForestItemData') {
    const mat = new THREE.MeshLambertMaterial({ color: col });
    mesh = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.6, 8), mat);
    mesh.geometry.rotateX(Math.PI / 2);
    mesh.geometry.translate(0, 0, 1.3);
  } else {
    const mat = new THREE.MeshLambertMaterial({ color: col });
    mesh = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), mat);
  }
  mesh.userData.obj = o;
  applyTRS(mesh, o.r);
  return mesh;
}

function roadGeometry(o) {
  const nodes = o.r.nodes || [];
  const geo = new THREE.BufferGeometry();
  if (nodes.length < 2) return geo;
  const left = [], right = [], idx = [];
  const pts = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const step = Math.max(1, Math.min(8, len / 4));
    const nseg = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < nseg; k++) {
      const t = k / nseg;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[3] || 4, a[2]]);
    }
  }
  const last = nodes[nodes.length - 1];
  pts.push([last[0], last[1], last[3] || 4, last[2]]);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
    let dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    const w = (p[2] || 4) / 2;
    const z = (S.ter ? heightAt(p[0], p[1]) : (p[3] || 0)) + 0.08;
    left.push(p[0] - dy * w, p[1] + dx * w, z);
    right.push(p[0] + dy * w, p[1] - dx * w, z);
  }
  const pos = new Float32Array(pts.length * 2 * 3);
  for (let i = 0; i < pts.length; i++) {
    pos.set(left.slice(i * 3, i * 3 + 3), i * 6);
    pos.set(right.slice(i * 3, i * 3 + 3), i * 6 + 3);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    idx.push(a, b, c, b, d, c);
  }
  const uv = new Float32Array(pts.length * 4), tl = +o.r.textureLength || 5;
  let run = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i) run += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    uv.set([0, run / tl, 1, run / tl], i * 4);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
function makeRoadMesh(o) {
  const rm = S.roadMats.get(o.r.material);
  const mat = rm
    ? new THREE.MeshLambertMaterial({ map: rm.tex, color: 0xffffff, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    : new THREE.MeshLambertMaterial({ color: 0x45484e, transparent: true, opacity: 0.95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(roadGeometry(o), mat);
  mesh.userData.obj = o;
  mesh.matrixAutoUpdate = true;
  return mesh;
}

function rebuildMeshes() {
  if (objGroup) {
    const keep = [];
    objGroup.traverse(ch => keep.push(ch));
    objGroup.clear();
    for (const ch of keep) {
      if (ch.geometry && !ch.geometry.userData.shared) ch.geometry.dispose();
      if (ch.material) {
        const ms = Array.isArray(ch.material) ? ch.material : [ch.material];
        ms.forEach(m => { if (!m.userData.shared) m.dispose?.(); });
      }
    }
  }
  if (realGroup) { for (const b of [...realGroup.children]) { realGroup.remove(b); b.dispose?.(); } }
  if (terrainDirty || !terrainMesh) makeTerrain();
  if (gridMesh) { scene.remove(gridMesh); gridMesh = null; }
  if (S.show.grid) {
    const t = T(); const span = t ? t.ext : 100;
    // GridHelper is XZ in Y-up; rotate to XY (Z-up)
    const g = new THREE.GridHelper(span, 20, 0x4a5568, 0x2a3340);
    g.rotation.x = Math.PI / 2;
    if (t) g.position.set(t.px + t.ext / 2, t.py + t.ext / 2, t.pz + 0.04);
    g.material.transparent = true; g.material.opacity = 0.45;
    gridMesh = g; scene.add(g);
  }
  for (const o of S.objs) {
    if (o.cls === 'TSStatic' && !S.show.ts) continue;
    if (o.cls === 'DecalRoad' && !S.show.rd) continue;
    if (o.cls !== 'TSStatic' && o.cls !== 'DecalRoad' && !S.show.ot) continue;
    const m = makeObjectMesh(o);
    o.mesh = m; o.inst = null;
    objGroup.add(m);
  }
  buildBatches();
  highlightSel();
  needRender = true;
}

function buildBatches() {
  const by = new Map();
  for (const o of S.objs) {
    const real = o.mesh && o.mesh.userData.real; if (!real || !o.mesh.parent) continue;
    if (!by.has(real)) by.set(real, []);
    by.get(real).push(o);
  }
  for (const [real, list] of by) {
    const batches = real.parts.map(pt => {
      const im = new THREE.InstancedMesh(pt.geo, pt.mat, list.length);
      im.frustumCulled = false; im.matrixAutoUpdate = false;
      if (pt.mat.transparent) im.renderOrder = 2;
      realGroup.add(im); return im;
    });
    list.forEach((o, i) => {
      o.inst = { batches, i };
      for (const b of batches) b.setMatrixAt(i, o.mesh.matrix);
    });
    for (const b of batches) b.instanceMatrix.needsUpdate = true;
  }
}
function highlightSel() {
  for (const o of S.objs) {
    const m = o.mesh; if (!m || !m.material) continue;
    const on = o === S.sel;
    if (m.userData.real) {
      if (on && !m.userData.edges) { const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), SEL_EDGE); m.add(e); m.userData.edges = e; }
      if (m.userData.edges) m.userData.edges.visible = on;
      continue;
    }
    if (m.material.color && m.userData._base == null) m.userData._base = m.material.color.getHex();
    if (m.material.color) m.material.color.setHex(on ? 0xf97316 : m.userData._base);
    if (m.material.emissive) m.material.emissive.setHex(on ? 0x3a1404 : 0x000000);
    m.material.opacity = on ? 0.98 : (o.cls === 'DecalRoad' ? 0.92 : 0.88);
  }
}

function syncMesh(o) {
  if (!o || !o.mesh) return;
  if (o.cls === 'DecalRoad') {
    o.mesh.geometry.dispose();
    o.mesh.geometry = roadGeometry(o);
  } else {
    applyTRS(o.mesh, o.r);
    if (o.inst) for (const b of o.inst.batches) { b.setMatrixAt(o.inst.i, o.mesh.matrix); b.instanceMatrix.needsUpdate = true; }
  }
  needRender = true;
}

function worldBox(o) {
  if (o.cls === 'DecalRoad') {
    const n = o.r.nodes || [];
    let s0 = 1e9, s1 = -1e9, z0 = 1e9, z1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const q of n) { s0 = Math.min(s0, q[0]); s1 = Math.max(s1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); y0 = Math.min(y0, q[2]); y1 = Math.max(y1, q[2]); }
    return { s0, s1, z0, z1, y0, y1 };
  }
  const p = o.r.position || [0, 0, 0]; const sc = scl(o.r); const a = rotZ(o.r); const b = boundsOf(o);
  const c = Math.cos(a), s = Math.sin(a);
  const corners = [[b.x0 * sc[0], b.y0 * sc[1]], [b.x1 * sc[0], b.y0 * sc[1]], [b.x1 * sc[0], b.y1 * sc[1]], [b.x0 * sc[0], b.y1 * sc[1]]];
  const xs = [], ys = [];
  for (const [lx, ly] of corners) { xs.push(p[0] + lx * c - ly * s); ys.push(p[1] + lx * s + ly * c); }
  return { s0: Math.min(...xs), s1: Math.max(...xs), z0: Math.min(...ys), z1: Math.max(...ys), y0: p[2] + b.z0 * sc[2], y1: p[2] + b.z1 * sc[2] };
}
function localBox(o) {
  const sc = scl(o.r); const b = boundsOf(o);
  return { s0: b.x0 * sc[0], s1: b.x1 * sc[0], z0: b.y0 * sc[1], z1: b.y1 * sc[1], y0: b.z0 * sc[2], y1: b.z1 * sc[2] };
}

function outlineCorners(o) {
  if (o.cls === 'DecalRoad') return (o.r.nodes || []).map(q => [q[0], q[1], (q[2] || 0) + 0.2]);
  const p = o.r.position || [0, 0, 0]; const sc = scl(o.r); const a = rotZ(o.r); const b = boundsOf(o);
  const c = Math.cos(a), s = Math.sin(a);
  const z = p[2] + b.z0 * sc[2] + 0.05;
  return [[b.x0 * sc[0], b.y0 * sc[1]], [b.x1 * sc[0], b.y0 * sc[1]], [b.x1 * sc[0], b.y1 * sc[1]], [b.x0 * sc[0], b.y1 * sc[1]]]
    .map(([lx, ly]) => [p[0] + lx * c - ly * s, p[1] + lx * s + ly * c, z]);
}

function pxPerMeter(o) {
  const p = o.r.position || (o.r.nodes && o.r.nodes[0]) || [0, 0, 0];
  const a = project(p[0], p[1], p[2]);
  const b = project(p[0] + 1, p[1], p[2]);
  const c = project(p[0], p[1] + 1, p[2]);
  return Math.max(4, (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - a[0], c[1] - a[1])) / 2);
}


/* ---------- overlay: outline, 44px handles, snap guides ---------- */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
function toWorld2(a, b, rot) { return [a * Math.cos(rot) - b * Math.sin(rot), a * Math.sin(rot) + b * Math.cos(rot)]; }
function toLocal2(u, v, rot) { return [u * Math.cos(rot) + v * Math.sin(rot), -u * Math.sin(rot) + v * Math.cos(rot)]; }

function updateOverlay() {
  const poly = $('outline'), hg = $('handles'), gg = $('guides');
  if (!poly) return;
  gg.innerHTML = '';
  if (!S.sel) { poly.setAttribute('points', ''); hg.innerHTML = ''; return; }
  const o = S.sel;
  const corners = outlineCorners(o);
  const pts = corners.map(c => project(c[0], c[1], c[2])).filter(p => isFinite(p[0]));
  if (o.cls === 'DecalRoad') {
    poly.setAttribute('points', '');
    // draw road polyline as extra lines in guides group? use outline as thick polyline via a path
  } else {
    poly.setAttribute('points', pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '));
  }
  let html = '';
  if (o.cls === 'DecalRoad') {
    const n = o.r.nodes || [];
    for (let i = 0; i < n.length; i++) {
      const p = project(n[i][0], n[i][1], (n[i][2] || 0) + 0.15);
      const on = i === S.selNode;
      html += `<g class="h3d node" data-handle="node-${i}" style="cursor:move">
        <circle class="hit" cx="${p[0]}" cy="${p[1]}" r="22"/>
        <circle class="dot" cx="${p[0]}" cy="${p[1]}" r="${on ? 8 : 6}"/>
      </g>`;
    }
    // path of the road
    const rp = n.map(q => project(q[0], q[1], (q[2] || 0) + 0.15));
    html = `<polyline points="${rp.map(p => p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ')}" fill="none" stroke="#f97316" stroke-width="3" opacity=".9" pointer-events="none"/>` + html;
  } else if (!menuOpen()) {
    const k = pxPerMeter(o);
    const box = localBox(o); const rot = rotZ(o.r); const org = o.r.position || [0, 0, 0];
    const wpx = (box.s1 - box.s0) * k, hpx = (box.z1 - box.z0) * k;
    const wide = wpx > 90, tall = hpx > 90;
    const reach = coarse ? 30 : 12, base0 = coarse ? 6 : 0;
    const os = Math.max(base0, reach - wpx / 2) / k, oz = Math.max(base0, reach - hpx / 2) / k;
    const pos = {
      nw: [box.s0 - os, box.z1 + oz], n: [(box.s0 + box.s1) / 2, box.z1 + oz], ne: [box.s1 + os, box.z1 + oz],
      e: [box.s1 + os, (box.z0 + box.z1) / 2], se: [box.s1 + os, box.z0 - oz], s: [(box.s0 + box.s1) / 2, box.z0 - oz],
      sw: [box.s0 - os, box.z0 - oz], w: [box.s0 - os, (box.z0 + box.z1) / 2]
    };
    const mx = (box.s0 + box.s1) / 2, mz = (box.z0 + box.z1) / 2;
    const edge = {
      nw: [box.s0, box.z1], n: [mx, box.z1], ne: [box.s1, box.z1], e: [box.s1, mz],
      se: [box.s1, box.z0], s: [mx, box.z0], sw: [box.s0, box.z0], w: [box.s0, mz]
    };
    const z = org[2] + boundsOf(o).z0 * scl(o.r)[2] + 0.05;
    const midLocal = [mx, mz];
    const midW = toWorld2(midLocal[0], midLocal[1], rot);
    const midS = project(org[0] + midW[0], org[1] + midW[1], z);
    const list = HANDLES.filter(h => h.length === 2 || ((h === 'n' || h === 's') ? wide : tall) || !coarse);
    const reachPx = coarse ? 36 : 12, minPx = coarse ? 8 : 2;
    for (const h of list) {
      const ew = toWorld2(edge[h][0], edge[h][1], rot);
      const e = project(org[0] + ew[0], org[1] + ew[1], z);
      const dx = e[0] - midS[0], dy = e[1] - midS[1], d = Math.hypot(dx, dy) || 1;
      const out = Math.max(minPx, reachPx - d);
      const hx = e[0] + (dx / d) * out, hy = e[1] + (dy / d) * out;
      html += `<g class="h3d" data-handle="${h}" style="cursor:${rot ? 'move' : CURSOR[h]}">
        <line class="stem" x1="${e[0]}" y1="${e[1]}" x2="${hx}" y2="${hy}"/>
        <rect class="hit" x="${hx - 22}" y="${hy - 22}" width="44" height="44"/>
        <circle class="dot" cx="${hx}" cy="${hy}" r="${coarse ? 8 : 5}"/>
      </g>`;
    }
  }
  hg.innerHTML = html;
  drawGuides();
}

const liveGuides = [];
function drawGuides() {
  const gg = $('guides');
  gg.innerHTML = liveGuides.map(g => {
    const a = project(g.a[0], g.a[1], g.a[2] || 0), b = project(g.b[0], g.b[1], g.b[2] || 0);
    return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
  }).join('');
}
function setGuides(list) {
  const key = q => (q || []).map(x => x.axis + x.at.toFixed(3)).join();
  if (list?.length && key(list) !== key(liveGuides.map(g => ({ axis: g.axis, at: g.at })))) haptic();
  liveGuides.length = 0;
  if (!S.sel || !list?.length) { drawGuides(); return; }
  const b = worldBox(S.sel); const z = (b.y0 + b.y1) / 2;
  const m = 2;
  for (const q of list) {
    if (q.axis === 's') liveGuides.push({ axis: 's', at: q.at, a: [q.at, b.z0 - m, z], b: [q.at, b.z1 + m, z] });
    else liveGuides.push({ axis: 'z', at: q.at, a: [b.s0 - m, q.at, z], b: [b.s1 + m, q.at, z] });
  }
  drawGuides();
}
function capPtr(el, id) { try { el.setPointerCapture(id); } catch (_) {} }
function haptic() { try { navigator.vibrate?.(8); } catch {} }

function pickAt(cx, cy) {
  setRay(cx, cy);
  const hits = raycaster.intersectObjects(objGroup.children, true);
  for (const h of hits) {
    let m = h.object;
    while (m && !m.userData.obj) m = m.parent;
    if (m && m.userData.obj) {
      const o = m.userData.obj;
      if (o.cls === 'TSStatic' && !S.show.ts) continue;
      if (o.cls === 'DecalRoad' && !S.show.rd) continue;
      if (o.cls !== 'TSStatic' && o.cls !== 'DecalRoad' && !S.show.ot) continue;
      return o;
    }
  }
  return null;
}
function nearSel(cx, cy, mpx = 40) {
  const o = S.sel; if (!o) return false;
  const corners = outlineCorners(o).map(c => project(c[0], c[1], c[2]));
  if (!corners.length) return false;
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
  return cx >= Math.min(...xs) - mpx && cx <= Math.max(...xs) + mpx && cy >= Math.min(...ys) - mpx && cy <= Math.max(...ys) + mpx;
}
function clientToStage(cx, cy) {
  const r = cv.getBoundingClientRect();
  return [cx - r.left, cy - r.top];
}

/* ---------- snap / move / resize ---------- */
function guideLinesExcept(cur) {
  const s = [], z = [];
  for (const o of S.objs) {
    if (o === cur) continue;
    const b = worldBox(o);
    s.push(b.s0, (b.s0 + b.s1) / 2, b.s1);
    z.push(b.z0, (b.z0 + b.z1) / 2, b.z1);
    const p = o.r.position; if (p) { s.push(p[0]); z.push(p[1]); }
  }
  const t = T();
  if (t) { s.push(t.px, t.px + t.ext / 2, t.px + t.ext); z.push(t.py, t.py + t.ext / 2, t.py + t.ext); }
  return { s, z };
}
function snapMove(startBox, du, dv, lines, tol) {
  const guides = []; let ou = du, ov = dv;
  const best = (cands, targets) => {
    let b = null;
    for (const c of cands) for (const t of targets) {
      const d = t - c; if (Math.abs(d) <= tol && (!b || Math.abs(d) < Math.abs(b.d))) b = { d, at: t };
    }
    return b;
  };
  const bs = best([startBox.s0 + du, (startBox.s0 + startBox.s1) / 2 + du, startBox.s1 + du], lines.s || []);
  if (bs) { ou = du + bs.d; guides.push({ axis: 's', at: bs.at }); }
  const bz = best([startBox.z0 + dv, (startBox.z0 + startBox.z1) / 2 + dv, startBox.z1 + dv], lines.z || []);
  if (bz) { ov = dv + bz.d; guides.push({ axis: 'z', at: bz.at }); }
  return { du: ou, dv: ov, guides };
}

function moveObj(o, start, du, dv, node) {
  markGesture();
  if (o.cls === 'DecalRoad') {
    const n = o.r.nodes;
    if (node >= 0 && n[node]) {
      n[node][0] = start.nodes[node][0] + du; n[node][1] = start.nodes[node][1] + dv;
      if (S.autoZ) n[node][2] = heightAt(n[node][0], n[node][1]);
    } else {
      n.forEach((q, i) => { q[0] = start.nodes[i][0] + du; q[1] = start.nodes[i][1] + dv; if (S.autoZ) q[2] = heightAt(q[0], q[1]); });
    }
    if (n[0]) o.r.position = [n[0][0], n[0][1], n[0][2]];
  } else {
    o.r.position[0] = start.pos[0] + du;
    o.r.position[1] = start.pos[1] + dv;
    if (S.autoZ) o.r.position[2] = heightAt(o.r.position[0], o.r.position[1]);
  }
  dirty(o.r); syncMesh(o);
}

function boxByHandle(start, handle, ds, dz) {
  const b = { ...start };
  if (handle.includes('e')) b.s1 = Math.max(start.s0 + 0.05, start.s1 + ds);
  if (handle.includes('w')) b.s0 = Math.min(start.s1 - 0.05, start.s0 + ds);
  if (handle.includes('n')) b.z1 = Math.max(start.z0 + 0.05, start.z1 + dz);
  if (handle.includes('s')) b.z0 = Math.min(start.z1 - 0.05, start.z0 + dz);
  return b;
}
function applyLocalBox(o, startBox, newBox, startPos, startScl) {
  const b = boundsOf(o);
  const sx = (newBox.s1 - newBox.s0) / Math.max(0.05, b.x1 - b.x0);
  const sy = (newBox.z1 - newBox.z0) / Math.max(0.05, b.y1 - b.y0);
  const sz = startScl[2];
  o.r.scale = [sx, sy, sz];
  const midS = (newBox.s0 + newBox.s1) / 2, midZ = (newBox.z0 + newBox.z1) / 2;
  const natS = (b.x0 + b.x1) / 2 * sx, natZ = (b.y0 + b.y1) / 2 * sy;
  const [wx, wy] = toWorld2(midS - natS, midZ - natZ, rotZ(o.r));
  o.r.position[0] = startPos[0] + wx;
  o.r.position[1] = startPos[1] + wy;
  dirty(o.r); syncMesh(o);
}
function pinchScale(a0, b0, a, b) {
  const dx0 = Math.abs(a0[0] - b0[0]), dy0 = Math.abs(a0[1] - b0[1]);
  const d0 = Math.max(1, Math.hypot(dx0, dy0)), d = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const ang = Math.atan2(dy0, dx0) * 180 / Math.PI, f = d / d0;
  if (ang < 30) return { fx: f, fz: 1, mode: 'w' };
  if (ang > 60) return { fx: 1, fz: f, mode: 'h' };
  return { fx: f, fz: f, mode: 'both' };
}
function twistDeg(a0, b0, a, b) {
  const t0 = Math.atan2(-(b0[1] - a0[1]), b0[0] - a0[0]);
  const t = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
  let d = (t - t0) * 180 / Math.PI; while (d > 180) d -= 360; while (d < -180) d += 360;
  return d;
}
function applyPinch(o, start, fx, fz, dDeg) {
  markGesture();
  if (o.cls === 'DecalRoad') {
    const f = (fx + fz) / 2;
    o.r.nodes.forEach((q, i) => { q[3] = Math.max(0.5, (start.widths[i] || 6) * f); });
    dirty(o.r); syncMesh(o); return;
  }
  const b = boundsOf(o);
  const ns = [start.scl[0] * fx, start.scl[1] * fz, start.scl[2] * (fx === 1 || fz === 1 ? 1 : (fx + fz) / 2)];
  ns[0] = clamp(ns[0], 0.05, 40); ns[1] = clamp(ns[1], 0.05, 40); ns[2] = clamp(ns[2], 0.05, 40);
  o.r.scale = ns;
  // keep bottom at same place when z changes
  const zOff = (b.z0 * ns[2]) - (b.z0 * start.scl[2]);
  o.r.position[0] = start.pos[0]; o.r.position[1] = start.pos[1];
  o.r.position[2] = start.pos[2]; // origin stays; z scale grows upward if z0==0
  if (start.mat) o.r.rotationMatrix = start.mat.slice();
  if (dDeg) composeYaw(o.r, dDeg * Math.PI / 180);
  dirty(o.r); syncMesh(o);
}

function snapToGround(o) {
  if (!o) return;
  beginEdit(); markGesture();
  if (o.cls === 'DecalRoad') o.r.nodes.forEach(q => { q[2] = heightAt(q[0], q[1]); });
  else if (o.r.position) o.r.position[2] = heightAt(o.r.position[0], o.r.position[1]);
  if (o.cls === 'DecalRoad' && o.r.nodes[0]) o.r.position = [o.r.nodes[0][0], o.r.nodes[0][1], o.r.nodes[0][2]];
  dirty(o.r); syncMesh(o); endEdit(); renderSheet(true); toast('تم اللصق بالأرض');
}

function snapshotOf(o) {
  if (o.cls === 'DecalRoad') return { nodes: o.r.nodes.map(q => q.slice()), widths: o.r.nodes.map(q => q[3] || 6), pos: (o.r.position || []).slice() };
  return { pos: o.r.position.slice(), scl: scl(o.r), mat: rotMat(o.r), box: localBox(o) };
}


function nearSelClient(cx, cy, mpx = 40) {
  const [x, y] = clientToStage(cx, cy);
  return nearSel(x, y, mpx);
}

/* ---------- context menu ---------- */
let menuTarget = null, menuArmed = false;
function menuOpen() { return !!menuTarget; }
function closeMenu() { if (!menuTarget && $('ctxmenu').hidden) return; menuTarget = null; menuPress = null; $('ctxmenu').hidden = true; }
function openMenu(t, ev) {
  if (!t) return; S.sel = t; menuTarget = t; highlightSel(); renderSheet();
  const m = $('ctxmenu');
  const items = menuItems(t);
  m.innerHTML = `<div class="mh"><span>${esc(t.r.name || t.cls)}</span><button class="mx" data-close aria-label="إغلاق القائمة">✕</button></div>` +
    items.map(it => `<button role="menuitem" data-act="${it.id}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}</button>`).join('');
  m.hidden = false; menuArmed = false;
  const W = 176, MH = items.length * 46 + 12 + 40;
  let left, top;
  const r = $('stage').getBoundingClientRect();
  const box = worldBox(t);
  const corners = [[box.s0, box.z0], [box.s1, box.z0], [box.s1, box.z1], [box.s0, box.z1]]
    .map(([x, y]) => project(x, y, (box.y0 + box.y1) / 2));
  const l = Math.min(...corners.map(p => p[0])), rr = Math.max(...corners.map(p => p[0]));
  const tt = Math.min(...corners.map(p => p[1])), bb = Math.max(...corners.map(p => p[1]));
  if (viewW - rr >= W + 12) { left = rr + 10; top = (tt + bb) / 2 - MH / 2; }
  else if (l >= W + 12) { left = l - W - 10; top = (tt + bb) / 2 - MH / 2; }
  else { left = (l + rr) / 2 - W / 2; top = tt >= MH + 12 ? tt - MH - 10 : bb + 10; }
  left = clamp(left, 8, viewW - W - 8); top = clamp(top, 8 + 10, viewH - MH - 8);
  m.style.left = left + 'px'; m.style.top = top + 'px';
  updateOverlay(); render();
}
function menuItems(t) {
  const hasClip = !!S.clipboard;
  return [
    { id: 'dup', label: 'نسخ / تكرار', run: () => dupSel() },
    { id: 'snap', label: 'الصق بالأرض', run: () => snapToGround(t) },
    { id: 'copy', label: 'نسخ الإعدادات', run: () => { S.clipboard = copySettings(t); toast('تم نسخ الإعدادات'); } },
    { id: 'paste', label: 'لصق الإعدادات', disabled: !hasClip, run: () => pasteSettings(t) },
    { id: 'del', label: 'حذف', danger: true, run: () => delSel() }
  ];
}
function copySettings(o) {
  const r = o.r, c = {};
  for (const k of ['scale', 'rotationMatrix', 'rotation', 'collisionType', 'decalType', 'material', 'textureLength', 'breakAngle', 'color', 'radius'])
    if (r[k] !== undefined) c[k] = JSON.parse(JSON.stringify(r[k]));
  return c;
}
function pasteSettings(o) {
  if (!S.clipboard) return;
  beginEdit(); markGesture();
  Object.assign(o.r, JSON.parse(JSON.stringify(S.clipboard)));
  dirty(o.r); syncMesh(o); endEdit(); renderSheet(); toast('تم لصق الإعدادات');
}
$('ctxmenu').addEventListener('pointerdown', ev => { ev.stopPropagation(); menuArmed = true; });
$('ctxmenu').addEventListener('click', ev => {
  if (ev.target.closest('[data-close]')) { closeMenu(); return; }
  const btn = ev.target.closest('button[data-act]'); if (!btn || !menuArmed) return;
  if (!menuTarget) { closeMenu(); return; }
  const it = menuItems(menuTarget).find(x => x.id === btn.dataset.act);
  closeMenu(); if (it && !it.disabled) it.run();
});

/* ---------- multi-finger taps (Procreate style) ---------- */
function multiTap({ onTwo, onThree }) {
  const down = new Map(); let maxN = 0, t0 = 0, spoiled = false;
  return {
    down(e) { if (e.pointerType !== 'touch') return; if (!down.size) { maxN = 0; t0 = performance.now(); spoiled = false; } down.set(e.pointerId, [e.clientX, e.clientY]); maxN = Math.max(maxN, down.size); },
    move(e) { const p = down.get(e.pointerId); if (p && Math.hypot(e.clientX - p[0], e.clientY - p[1]) > 12) spoiled = true; },
    up(e) {
      if (!down.has(e.pointerId)) return 0;
      down.delete(e.pointerId); if (e.type === 'pointercancel') spoiled = true;
      if (down.size) return 0;
      if (spoiled || performance.now() - t0 >= 300) return 0;
      if (maxN === 2) { onTwo?.(); return 2; }
      if (maxN === 3) { onThree?.(); return 3; }
      return 0;
    }
  };
}
const taps = multiTap({ onTwo: doUndo, onThree: doRedo });

/* ---------- gestures: handle > selected > camera ---------- */
const pts = new Map();
let cand = null, drag = null, pull = null, pinch = null, press = 0;
let lastThingTap = null, lastTap = null, pendingMenu = 0, pendingSheet = 0, swallow = false, dismissTap = null, menuPress = null;
let lastType = 'mouse', orbitVel = { y: 0, p: 0 }, fly = 0;
const claimed = new Set();

function startSizeTip(text) { const el = $('sizeTip'); el.hidden = false; el.textContent = text; }
function hideSizeTip() { setTimeout(() => { if (!pts.size) $('sizeTip').hidden = true; }, 600); }
function sizeLabel(o) {
  if (!o) return '';
  if (o.cls === 'DecalRoad') { const n = o.r.nodes || []; return 'عرض ' + (n[0] ? n[0][3] : 0).toFixed(2) + ' م · ' + n.length + ' نقاط'; }
  const s = scl(o.r), b = boundsOf(o);
  return ((b.x1 - b.x0) * s[0]).toFixed(2) + ' × ' + ((b.y1 - b.y0) * s[1]).toFixed(2) + ' × ' + ((b.z1 - b.z0) * s[2]).toFixed(2) + ' م';
}

function onDown(ev) {
  if (ev.target.closest?.('.ctxmenu')) return;
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  if (swallow) { swallow = false; return; }
  lastType = ev.pointerType;
  pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
  taps.down(ev);
  cancelAnimationFrame(fly); orbitVel = { y: 0, p: 0 };

  if (pts.size === 2) {
    clearTimeout(press);
    const [a, b] = [...pts.values()];
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const t = S.sel, mine = drag || pull;
    const fresh = cand && !cand.moved && performance.now() - cand.at < 400;
    const onIt = !!t && (mine ? mine.o === t : !!fresh && nearSelClient(c[0], c[1]));
    drag = null; pull = null; cand = null;
    if (onIt) {
      claimed.add(ev.pointerId);
      capPtr(overlay, ev.pointerId);
      beginEdit();
      pinch = { resize: true, o: t, a0: a, b0: b, start: snapshotOf(t), live: false };
    } else {
      pinch = { resize: false, d: Math.hypot(a[0] - b[0], a[1] - b[1]), c, dist: camState.dist, ortho: camState.ortho, tx: camState.target.x, ty: camState.target.y, tz: camState.target.z };
    }
    return;
  }
  if (pts.size > 2) { cand = null; return; }

  const hd = ev.target.closest?.('[data-handle]');
  if (hd && S.sel) {
    claimed.add(ev.pointerId);
    capPtr(ev.target, ev.pointerId);
    const h = hd.dataset.handle;
    if (h.startsWith('node-')) {
      S.selNode = +h.slice(5);
      beginEdit();
      drag = { o: S.sel, node: S.selNode, start: snapshotOf(S.sel), sx: ev.clientX, sy: ev.clientY, hit: hitTerrainAt(ev.clientX, ev.clientY), live: ev.pointerType === 'mouse', moved: false };
    } else {
      pull = { o: S.sel, h, start: snapshotOf(S.sel), sx: ev.clientX, sy: ev.clientY };
      beginEdit(); startSizeTip(sizeLabel(S.sel));
    }
    return;
  }

  const t = (S.sel && nearSelClient(ev.clientX, ev.clientY, coarse ? 14 : 4)) ? S.sel : pickAt(ev.clientX, ev.clientY);
  if (t && t === S.sel) {
    claimed.add(ev.pointerId);
    capPtr(cv, ev.pointerId);
    let node = -1;
    if (t.cls === 'DecalRoad') {
      const n = t.r.nodes || []; const k = pxPerMeter(t);
      for (let i = 0; i < n.length; i++) {
        const p = project(n[i][0], n[i][1], n[i][2] || 0);
        const [x, y] = clientToStage(ev.clientX, ev.clientY);
        if (Math.hypot(p[0] - x, p[1] - y) < 22) node = i;
      }
    }
    S.selNode = node;
    drag = { o: t, node, start: snapshotOf(t), sx: ev.clientX, sy: ev.clientY, hit: hitTerrainAt(ev.clientX, ev.clientY), live: ev.pointerType === 'mouse', was: true, moved: false };
    beginEdit();
    if (!drag.live) press = setTimeout(() => { if (drag && !drag.moved && pts.size === 1) { const tt = drag.o; menuPress = { id: ev.pointerId, x: drag.sx, y: drag.sy }; drag = null; endEdit(); openMenu(tt); haptic(); } }, 500);
    return;
  }

  cand = { t, id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, at: performance.now(), moved: false };
  if (t && ev.pointerType !== 'touch' && ev.pointerType !== 'pen' && ev.pointerType !== 'mouse') { /* noop */ }
  if (t && ev.pointerType !== 'mouse') press = setTimeout(() => { if (cand && cand.t && !cand.moved && pts.size === 1) { const tt = cand.t; menuPress = { id: cand.id, x: cand.sx, y: cand.sy }; cand = null; openMenu(tt); haptic(); } }, 500);
}

function onMove(ev) {
  if (!pts.has(ev.pointerId)) return;
  const prev = pts.get(ev.pointerId);
  pts.set(ev.pointerId, [ev.clientX, ev.clientY]);
  taps.move(ev);
  if (menuOpen() && menuPress && menuPress.id === ev.pointerId && Math.hypot(ev.clientX - menuPress.x, ev.clientY - menuPress.y) > 14) { closeMenu(); menuPress = null; }
  if (cand && ev.pointerId === cand.id && Math.hypot(ev.clientX - cand.sx, ev.clientY - cand.sy) > (ev.pointerType === 'touch' ? 10 : 4)) {
    cand.moved = true; clearTimeout(press);
  }

  if (pinch && pts.size >= 2) {
    const [a, b] = [...pts.values()];
    if (pinch.resize) {
      const o = pinch.o; if (!o) return;
      if (!pinch.live) {
        if (Math.max(Math.hypot(a[0] - pinch.a0[0], a[1] - pinch.a0[1]), Math.hypot(b[0] - pinch.b0[0], b[1] - pinch.b0[1])) < 10) return;
        pinch.live = true;
      }
      const { fx, fz } = pinchScale(pinch.a0, pinch.b0, a, b);
      const deg = twistDeg(pinch.a0, pinch.b0, a, b);
      applyPinch(o, pinch.start, fx, fz, deg);
      startSizeTip(sizeLabel(o)); syncSheetLive(); updateOverlay(); render();
      return;
    }
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const f = d / Math.max(1, pinch.d);
    if (S.mode === '2d') camState.ortho = clamp(pinch.ortho / f, 4, 4000);
    else camState.dist = clamp(pinch.dist / f, 4, 4000);
    const hit0 = pinch._hit || (pinch._hit = hitTerrainAt(pinch.c[0], pinch.c[1]));
    const hit1 = hitTerrainAt(c[0], c[1]);
    if (hit0 && hit1) {
      camState.target.x = pinch.tx - (hit1.x - hit0.x);
      camState.target.y = pinch.ty - (hit1.y - hit0.y);
    }
    updateCamera(); updateOverlay(); render();
    return;
  }

  if (pull) {
    const o = pull.o; const rot = rotZ(o.r);
    const h0 = hitTerrainAt(pull.sx, pull.sy), h1 = hitTerrainAt(ev.clientX, ev.clientY);
    if (h0 && h1) {
      const [ds, dz] = toLocal2(h1.x - h0.x, h1.y - h0.y, rot);
      const nb = boxByHandle(pull.start.box, pull.h, ds, dz);
      markGesture();
      applyLocalBox(o, pull.start.box, nb, pull.start.pos, pull.start.scl);
      startSizeTip(sizeLabel(o)); syncSheetLive(); updateOverlay(); render();
    }
    return;
  }

  if (drag) {
    if (!drag.live && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 6) return;
    if (Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) >= 6) { drag.moved = true; clearTimeout(press); }
    if (S.adding) return;
    drag.live = true;
    const hit = hitTerrainAt(ev.clientX, ev.clientY);
    if (!hit || !drag.hit) return;
    let du = hit.x - drag.hit.x, dv = hit.y - drag.hit.y;
    const startBox = drag.start.box || worldBoxFromSnap(drag.o, drag.start);
    const k = pxPerMeter(drag.o);
    const snapped = snapMove(startBox, du, dv, guideLinesExcept(drag.o), (coarse ? 9 : 6) / k);
    du = snapped.du; dv = snapped.dv; setGuides(snapped.guides);
    moveObj(drag.o, drag.start, du, dv, drag.node);
    syncSheetLive(); updateOverlay(); render();
    return;
  }

  if (cand && cand.moved && ev.pointerId === cand.id && pts.size === 1) {
    const dx = ev.clientX - cand.sx, dy = ev.clientY - cand.sy;
    if (S.mode === '2d') {
      if (!cand.pan) cand.pan = { x: ev.clientX, y: ev.clientY, tx: camState.target.x, ty: camState.target.y, hit: hitTerrainAt(cand.sx, cand.sy) };
      const h1 = hitTerrainAt(ev.clientX, ev.clientY);
      if (cand.pan.hit && h1) {
        camState.target.x = cand.pan.tx - (h1.x - cand.pan.hit.x);
        camState.target.y = cand.pan.ty - (h1.y - cand.pan.hit.y);
      }
    } else {
      if (!cand.orbit) cand.orbit = { x: cand.sx, y: cand.sy, yaw: camState.yaw, pitch: camState.pitch };
      camState.yaw = cand.orbit.yaw - (ev.clientX - cand.orbit.x) * 0.005;
      camState.pitch = clamp(cand.orbit.pitch + (ev.clientY - cand.orbit.y) * 0.004, 0.08, 1.45);
      const dt = Math.max(1, ev.timeStamp - (cand._t || ev.timeStamp));
      orbitVel = { y: (ev.clientX - prev[0]) / dt, p: (ev.clientY - prev[1]) / dt };
      cand._t = ev.timeStamp;
    }
    updateCamera(); updateOverlay(); render();
  }
}

function worldBoxFromSnap(o, start) {
  if (start.box && o.cls !== 'DecalRoad') {
    // start.box is local; convert to world AABB at start.pos
    const a = rotZ(o.r), p = start.pos;
    const c = Math.cos(a), s = Math.sin(a);
    const corners = [[start.box.s0, start.box.z0], [start.box.s1, start.box.z0], [start.box.s1, start.box.z1], [start.box.s0, start.box.z1]];
    const xs = [], ys = [];
    for (const [lx, ly] of corners) { xs.push(p[0] + lx * c - ly * s); ys.push(p[1] + lx * s + ly * c); }
    return { s0: Math.min(...xs), s1: Math.max(...xs), z0: Math.min(...ys), z1: Math.max(...ys) };
  }
  const n = start.nodes || [];
  let s0 = 1e9, s1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const q of n) { s0 = Math.min(s0, q[0]); s1 = Math.max(s1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
  return { s0, s1, z0, z1 };
}

function onUp(ev) {
  if (!pts.has(ev.pointerId)) return;
  pts.delete(ev.pointerId);
  clearTimeout(press);
  const done = () => {
    claimed.delete(ev.pointerId);
    if (!pts.size) {
      endEdit();
      setGuides([]); hideSizeTip();
    }
    const n = taps.up(ev);
    if (n) { closeMenu(); clearTimeout(pendingMenu); }
  };

  if (cand && ev.pointerId === cand.id) {
    const c = cand; cand = null;
    // inertia
    if (c.moved && S.mode === '3d' && Math.hypot(orbitVel.y, orbitVel.p) > 0.02) startGlide();
    if (!c.moved && c.id === dismissTap) { dismissTap = null; done(); return; } // this tap only closed the menu
    if (!c.moved && ev.type === 'pointerup' && !pts.size && performance.now() - c.at < 600) {
      const now = Date.now();
      if (S.adding) {
        const hit = hitTerrainAt(ev.clientX, ev.clientY);
        if (hit) addAt(hit.x, hit.y);
        S.adding = false; $('bAdd').classList.remove('on');
      } else if (c.t) {
        if (lastThingTap && lastThingTap.t === c.t && now - lastThingTap.at < 320) {
          lastThingTap = null; clearTimeout(pendingSheet); focusObj(c.t); S.sel = c.t; highlightSel(); renderSheet();
        } else {
          S.sel = c.t; S.selNode = -1; highlightSel(); lastThingTap = { t: c.t, at: now };
          clearTimeout(pendingSheet); pendingSheet = setTimeout(() => { if (!pts.size) openDockForSel(); }, 330);
          renderSheet(); updateOverlay(); render();
        }
      } else {
        S.sel = null; S.selNode = -1; highlightSel(); renderSheet(); updateOverlay();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 30) { lastTap = null; fit(); }
        else lastTap = { t: now, x: ev.clientX, y: ev.clientY };
        if (dockSnap !== 'collapsed') setDock('collapsed');
      }
    }
    done(); return;
  }

  if (pinch) { if (pts.size < 2) pinch = null; done(); return; }

  if (drag && !drag.moved && ev.type === 'pointerup' && dismissTap === ev.pointerId) { dismissTap = null; drag = null; done(); updateOverlay(); render(); return; }
  if (drag && !drag.moved && ev.type === 'pointerup') {
    const t = drag.o, now = Date.now();
    if (lastThingTap && lastThingTap.t === t && now - lastThingTap.at < 320) {
      clearTimeout(pendingMenu); clearTimeout(pendingSheet); lastThingTap = null; focusObj(t);
    } else {
      lastThingTap = { t, at: now };
      // a tap only selects; the menu is long-press (0.5s) or right-click
      openDockForSel();
    }
  }
  drag = null; pull = null;
  done(); updateOverlay(); render();
}

function startGlide() {
  cancelAnimationFrame(fly);
  let vy = orbitVel.y * 16, vp = orbitVel.p * 16;
  const step = () => {
    vy *= 0.92; vp *= 0.92;
    if (Math.hypot(vy, vp) < 0.02) return;
    camState.yaw -= vy * 0.005;
    camState.pitch = clamp(camState.pitch + vp * 0.004, 0.08, 1.45);
    updateCamera(); updateOverlay(); render();
    fly = requestAnimationFrame(step);
  };
  fly = requestAnimationFrame(step);
}

function onWheel(ev) {
  ev.preventDefault(); closeMenu();
  const f = ev.deltaY < 0 ? 0.9 : 1.1;
  if (S.mode === '2d') camState.ortho = clamp(camState.ortho * f, 4, 4000);
  else camState.dist = clamp(camState.dist * f, 4, 4000);
  updateCamera(); updateOverlay(); render();
}
function onContext(ev) {
  ev.preventDefault();
  const t = pickAt(ev.clientX, ev.clientY);
  if (t) openMenu(t); else closeMenu();
}

// Any touch outside the menu closes it. A plain tap that closed the menu does nothing else,
// but a drag / pinch / orbit that starts there carries on normally.
document.addEventListener('pointerdown', ev => {
  if (menuOpen() && !ev.target.closest?.('.ctxmenu')) { closeMenu(); dismissTap = ev.target.closest?.('#stage') ? ev.pointerId : null; }
  else if (!menuOpen()) dismissTap = null;
}, true);
addEventListener('keydown', ev => { if (ev.key === 'Escape' && menuOpen()) { ev.preventDefault(); closeMenu(); } });

const stage = $('stage');
stage.addEventListener('pointerdown', onDown);
stage.addEventListener('pointermove', onMove);
stage.addEventListener('pointerup', onUp);
stage.addEventListener('pointercancel', onUp);
stage.addEventListener('wheel', onWheel, { passive: false });
stage.addEventListener('contextmenu', onContext);


/* ---------- add / delete / duplicate ---------- */
function addAt(x, y) {
  beginEdit(); markGesture();
  const g = S.groups[0];
  const parent = (S.objs.find(o => o.cls === S.addType && o.g === g) || S.objs.find(o => o.g === g) || { r: {} }).r.__parent || 'MissionGroup';
  let r;
  if (S.addType === 'DecalRoad') {
    const z = heightAt(x, y);
    r = { class: 'DecalRoad', name: 'road_' + Date.now().toString(36), persistentId: uid(), __parent: parent, position: [x, y, z], improvedSpline: true, material: S.roadMat || 'road_asphalt_2lane', nodes: [[x, y, z, 6], [x + 16, y, heightAt(x + 16, y), 6]], breakAngle: 1, renderPriority: 10, textureLength: 6.4, detail: 0.1 };
  } else {
    r = { class: 'TSStatic', name: 'obj_' + Date.now().toString(36), persistentId: uid(), __parent: parent, position: [x, y, heightAt(x, y)], shapeName: S.shapeSel || '', collisionType: 'Visible Mesh', decalType: 'None', prebuildCollisionData: 0, useInstanceRenderData: true, scale: [1, 1, 1], rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  }
  r.__dirty = true;
  g.recs.push(r);
  const o = { r, g, cls: r.class }; S.objs.push(o); S.sel = o;
  endEdit();
  rebuildMeshes(); renderSheet(); openDockForSel(); render();
}
function delSel() {
  if (!S.sel) return;
  beginEdit(); markGesture();
  const o = S.sel; o.g.recs.splice(o.g.recs.indexOf(o.r), 1);
  S.objs.splice(S.objs.indexOf(o), 1); S.sel = null; S.selNode = -1;
  endEdit(); rebuildMeshes(); renderSheet(); render();
}
function dupSel() {
  if (!S.sel) return;
  beginEdit(); markGesture();
  const o = S.sel; const r = JSON.parse(JSON.stringify(clean(o.r)));
  r.persistentId = uid(); r.name = (r.name || 'obj') + '_copy'; r.__dirty = true;
  const off = 3;
  if (r.nodes) r.nodes.forEach(q => { q[0] += off; q[1] += off; });
  if (r.position) { r.position[0] += off; r.position[1] += off; }
  o.g.recs.splice(o.g.recs.indexOf(o.r) + 1, 0, r);
  const n = { r, g: o.g, cls: o.cls }; S.objs.push(n); S.sel = n;
  endEdit(); rebuildMeshes(); renderSheet(); render();
}

/* ---------- sheet + dock ---------- */
let toastT = 0;
function toast(t) {
  const el = $('toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2200);
}

let dockSnap = 'collapsed', dockH = 0, dockDrag = null;
function dockHeights() {
  const vh = window.innerHeight;
  const collapsed = 28 + 52; // grab + bar (safe area is padding)
  return { collapsed, half: Math.min(vh * 0.44, 420), full: Math.min(vh * 0.75, 640) };
}
function setDock(s) {
  dockSnap = s;
  const h = dockHeights();
  dockH = h[s];
  const dock = $('dock');
  dock.style.setProperty('--dock-h', dockH + 'px');
  document.documentElement.style.setProperty('--dock-h', dockH + 'px');
  dock.classList.toggle('collapsed', s === 'collapsed');
  $('bCloseSheet').hidden = s === 'collapsed';
}
function openDockForSel() { if (S.sel) setDock(dockSnap === 'collapsed' ? 'half' : dockSnap); }
function sheetDown(e) {
  dockDrag = { y: e.clientY, h: dockH, t: performance.now(), moved: false };
  $('dock').classList.add('dragging');
  e.currentTarget.setPointerCapture?.(e.pointerId);
}
function sheetMove(e) {
  if (!dockDrag) return;
  const dy = dockDrag.y - e.clientY; // drag up = taller (RTL doesn't matter; Y is visual)
  if (Math.abs(e.clientY - dockDrag.y) > 6) dockDrag.moved = true;
  const h = dockHeights();
  dockH = clamp(dockDrag.h + dy, h.collapsed - 8, h.full);
  $('dock').style.setProperty('--dock-h', dockH + 'px');
  document.documentElement.style.setProperty('--dock-h', dockH + 'px');
  $('dock').classList.toggle('collapsed', dockH < h.collapsed + 20);
}
function sheetUp(e) {
  if (!dockDrag) return;
  const moved = dockDrag.moved; const h = dockHeights();
  $('dock').classList.remove('dragging');
  const order = ['collapsed', 'half', 'full'];
  let best = order.reduce((a, b) => Math.abs(h[b] - dockH) < Math.abs(h[a] - dockH) ? b : a);
  if (!moved) best = dockSnap === 'collapsed' ? 'half' : 'collapsed';
  dockDrag = null; setDock(best);
}
$('grab').addEventListener('pointerdown', sheetDown);
$('grab').addEventListener('pointermove', sheetMove);
$('grab').addEventListener('pointerup', sheetUp);
$('grab').addEventListener('pointercancel', sheetUp);
$('bCloseSheet').addEventListener('click', ev => { ev.stopPropagation(); setDock('collapsed'); });

function renderSheet(keepScroll) {
  const sh = $('sheet'); if (!sh) return;
  const sc = sh.scrollTop;
  let h = '';
  if (S.sel) {
    const o = S.sel, r = o.r;
    h += `<h4>المحدد: ${esc(o.cls)} — ${esc(r.name || '')}</h4>`;
    h += `<div class="row"><button class="b" id="sDup">⧉ نسخ</button><button class="b bd" id="sDel">🗑 حذف</button><button class="b" id="sSnap">⛰ الصق بالأرض</button><button class="b" id="sFocus">🎯 تمركز</button></div>`;
    h += `<div class="r"><label>الاسم</label><input type="text" data-f="name" value="${esc(r.name || '')}"></div>`;
    if (o.cls === 'DecalRoad') {
      const n = r.nodes || [];
      h += `<div class="r"><label>المادة</label><input type="text" data-f="material" value="${esc(r.material || '')}"></div>`;
      h += `<div class="r"><label>العرض</label><input type="number" step="0.1" id="fRoadW" value="${n[0] ? n[0][3] : 6}"></div>`;
      const len = n.reduce((l, q, i) => i ? l + Math.hypot(q[0] - n[i - 1][0], q[1] - n[i - 1][1]) : 0, 0);
      h += `<div class="sm">النقاط: ${n.length} — الطول ≈ ${len.toFixed(1)}م</div>`;
      h += `<div class="row"><button class="b" id="sAddN">➕ نقطة</button><button class="b bd" id="sDelN">➖ حذف النقطة</button><button class="b" id="sRev">⇄ عكس الاتجاه</button></div>`;
      if (S.selNode >= 0 && n[S.selNode]) h += `<h4>نقطة ${S.selNode + 1}</h4><div class="g3">${['X', 'Y', 'Z'].map((a, i) => `<div><div class="sm">${a}</div><input type="number" step="0.1" data-node="${i}" value="${n[S.selNode][i].toFixed(3)}"></div>`).join('')}</div>`;
    } else if (r.position) {
      const p = r.position;
      h += `<div class="g3">${['X', 'Y', 'Z'].map((a, i) => `<div><div class="sm">${a}</div><input type="number" step="0.1" data-pos="${i}" id="fP${i}" value="${(+p[i] || 0).toFixed(3)}"></div>`).join('')}</div>`;
      const ang = rotZ(r) * 180 / Math.PI;
      h += `<div class="r"><label>الدوران °</label><div><input type="range" min="-180" max="180" step="1" id="fRotR" value="${ang.toFixed(0)}"><input type="number" step="0.5" id="fRotN" value="${ang.toFixed(1)}"></div></div>`;
      const s = scl(r);
      h += `<h4>المقياس</h4><div class="g3">${[0, 1, 2].map(i => `<input type="number" step="0.01" data-scl="${i}" id="fS${i}" value="${s[i]}">`).join('')}</div>`;
      if (o.cls === 'TSStatic') {
        h += `<div class="r"><label>الموديل</label><input type="text" data-f="shapeName" value="${esc(r.shapeName || '')}"></div>`;
        const b = S.dae.get(r.shapeName); if (b) h += `<div class="sm">الأبعاد: ${((b.x1 - b.x0) * s[0]).toFixed(2)} × ${((b.y1 - b.y0) * s[1]).toFixed(2)} × ${((b.z1 - b.z0) * s[2]).toFixed(2)} م</div>`;
        h += `<div class="r"><label>التصادم</label><select data-f="collisionType">${['Visible Mesh', 'Collision Mesh', 'Bounds', 'None', 'Visible Mesh Final'].map(v => `<option ${r.collisionType === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`;
      }
    }
  } else {
    h += `<h4>العرض</h4><div class="tg">` + [['ts', 'مجسمات'], ['rd', 'ديكال/طرق'], ['ot', 'أخرى'], ['grid', 'شبكة']].map(([k, l]) => `<label><input type="checkbox" data-show="${k}" ${S.show[k] ? 'checked' : ''}>${l}</label>`).join('') + `<label><input type="checkbox" id="fAutoZ" ${S.autoZ ? 'checked' : ''}>لصق تلقائي بالتضاريس</label></div>`;
    h += `<h4>إضافة</h4><div class="r"><label>النوع</label><select id="fAddType"><option value="TSStatic" ${S.addType === 'TSStatic' ? 'selected' : ''}>مجسم (TSStatic)</option><option value="DecalRoad" ${S.addType === 'DecalRoad' ? 'selected' : ''}>طريق ديكال</option></select></div>`;
    if (S.addType === 'TSStatic' && S.zipFiles) {
      const shapes = [...new Set([...S.objs.filter(o => o.cls === 'TSStatic').map(o => o.r.shapeName), ...[...S.zipFiles.keys()].filter(p => /\.dae$/i.test(p)).map(p => '/' + p.replace(/^.*?(levels\/)/i, '$1'))])].filter(Boolean);
      h += `<div class="r"><label>الموديل</label><select id="fShape"><option value="">— اختر —</option>${shapes.map(s => `<option ${S.shapeSel === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>`;
    } else h += `<div class="r"><label>المادة</label><input type="text" id="fRoadMat" value="${esc(S.roadMat || 'road_asphalt_2lane')}"></div>`;
    h += `<div class="sm">اضغط «➕ إضافة» ثم المس مكان الخريطة. في الثلاثي الأبعاد: لمسة واحدة تحدد، والسحب يحرّك القطعة المحددة، والقرص يكبّر، واللف يدوّر. ضغطة مطوّلة تفتح القائمة.</div>`;
    h += `<h4>القائمة (${S.objs.length})</h4><div class="r"><label>بحث</label><input type="text" id="fFilter" value="${esc(S.filter)}"></div><div id="list"></div>`;
  }
  sh.innerHTML = h;
  bindSheet();
  if (!S.sel) fillList();
  if (keepScroll) sh.scrollTop = sc;
  updateOverlay();
}

function bindSheet() {
  const sh = $('sheet');
  sh.querySelector('#sDup')?.addEventListener('click', dupSel);
  sh.querySelector('#sDel')?.addEventListener('click', delSel);
  sh.querySelector('#sSnap')?.addEventListener('click', () => snapToGround(S.sel));
  sh.querySelector('#sFocus')?.addEventListener('click', () => focusObj(S.sel));
  sh.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', () => {
    if (!S.sel) return; beginEdit(); markGesture(); S.sel.r[el.dataset.f] = el.value; dirty(S.sel.r); endEdit(); syncMesh(S.sel); render();
    if (el.dataset.f === 'shapeName' || el.dataset.f === 'shapeFile') ensureShape(S.sel); else if (el.dataset.f === 'material' && S.sel.cls === 'DecalRoad') rebuildMeshes();
  }));
  sh.querySelectorAll('[data-pos]').forEach(el => el.addEventListener('change', () => {
    if (!S.sel) return; beginEdit(); markGesture(); S.sel.r.position[+el.dataset.pos] = +el.value; dirty(S.sel.r); endEdit(); syncMesh(S.sel); updateOverlay(); render();
  }));
  sh.querySelectorAll('[data-scl]').forEach(el => el.addEventListener('change', () => {
    if (!S.sel) return; beginEdit(); markGesture(); const s = scl(S.sel.r); s[+el.dataset.scl] = +el.value; S.sel.r.scale = s; dirty(S.sel.r); endEdit(); syncMesh(S.sel); updateOverlay(); render();
  }));
  sh.querySelectorAll('[data-node]').forEach(el => el.addEventListener('change', () => {
    if (!S.sel || S.selNode < 0) return; beginEdit(); markGesture(); S.sel.r.nodes[S.selNode][+el.dataset.node] = +el.value;
    const n = S.sel.r.nodes; S.sel.r.position = [n[0][0], n[0][1], n[0][2]]; dirty(S.sel.r); endEdit(); syncMesh(S.sel); updateOverlay(); render();
  }));
  const rot = v => { if (!S.sel) return; beginEdit(); markGesture(); setRotZ(S.sel.r, v * Math.PI / 180); endEdit(); syncMesh(S.sel); updateOverlay(); render(); };
  sh.querySelector('#fRotR')?.addEventListener('input', e => { if (!S.sel) return; if (!gesturing) beginEdit(); markGesture(); setRotZ(S.sel.r, +e.target.value * Math.PI / 180); syncMesh(S.sel); updateOverlay(); render(); const n = sh.querySelector('#fRotN'); if (n) n.value = (+e.target.value).toFixed(1); });
  sh.querySelector('#fRotR')?.addEventListener('change', endEdit);
  sh.querySelector('#fRotN')?.addEventListener('change', e => rot(+e.target.value));
  sh.querySelector('#fRoadW')?.addEventListener('change', e => { if (!S.sel) return; beginEdit(); markGesture(); S.sel.r.nodes.forEach(q => q[3] = +e.target.value); dirty(S.sel.r); endEdit(); syncMesh(S.sel); render(); });
  sh.querySelector('#sAddN')?.addEventListener('click', addNode);
  sh.querySelector('#sDelN')?.addEventListener('click', delNode);
  sh.querySelector('#sRev')?.addEventListener('click', () => { if (!S.sel) return; beginEdit(); markGesture(); S.sel.r.nodes.reverse(); const n = S.sel.r.nodes; S.sel.r.position = [n[0][0], n[0][1], n[0][2]]; dirty(S.sel.r); endEdit(); syncMesh(S.sel); renderSheet(1); render(); });
  sh.querySelectorAll('[data-show]').forEach(el => el.addEventListener('change', () => { S.show[el.dataset.show] = el.checked; if (el.dataset.show === 'grid') { rebuildMeshes(); } else { rebuildMeshes(); } render(); }));
  sh.querySelector('#fAutoZ')?.addEventListener('change', e => { S.autoZ = e.target.checked; });
  sh.querySelector('#fAddType')?.addEventListener('change', e => { S.addType = e.target.value; renderSheet(); });
  sh.querySelector('#fShape')?.addEventListener('change', e => { S.shapeSel = e.target.value; });
  sh.querySelector('#fRoadMat')?.addEventListener('change', e => { S.roadMat = e.target.value; });
  sh.querySelector('#fFilter')?.addEventListener('input', e => { S.filter = e.target.value; fillList(); });
}
function fillList() {
  const L = $('list'); if (!L) return;
  const q = S.filter.toLowerCase();
  L.innerHTML = S.objs.filter(o => !q || (o.r.name || '').toLowerCase().includes(q) || (o.cls || '').toLowerCase().includes(q) || (o.r.shapeName || '').toLowerCase().includes(q))
    .slice(0, 200).map((o, i) => `<div class="it${o === S.sel ? ' on' : ''}" data-i="${S.objs.indexOf(o)}"><span>${esc(o.r.name || o.cls)}</span><span class="sm">${o.cls}</span></div>`).join('');
  L.querySelectorAll('.it').forEach(el => el.onclick = () => { S.sel = S.objs[+el.dataset.i]; S.selNode = -1; highlightSel(); focusObj(S.sel); renderSheet(); render(); });
}
function syncSheetLive() {
  if (!S.sel) return;
  const r = S.sel.r;
  if (r.position) [0, 1, 2].forEach(i => { const el = $('fP' + i); if (el && document.activeElement !== el) el.value = (+r.position[i] || 0).toFixed(3); });
  const s = scl(r);
  [0, 1, 2].forEach(i => { const el = $('fS' + i); if (el && document.activeElement !== el) el.value = s[i]; });
  const ang = rotZ(r) * 180 / Math.PI;
  const rr = $('fRotR'), rn = $('fRotN');
  if (rr && document.activeElement !== rr) rr.value = ang.toFixed(0);
  if (rn && document.activeElement !== rn) rn.value = ang.toFixed(1);
}
function addNode() {
  if (!S.sel || S.sel.cls !== 'DecalRoad') return;
  beginEdit(); markGesture();
  const n = S.sel.r.nodes; let i = S.selNode >= 0 ? S.selNode : n.length - 1;
  const a = n[i], b = n[i + 1] || [a[0] + (a[0] - (n[i - 1]?.[0] ?? a[0] - 4)), a[1] + (a[1] - (n[i - 1]?.[1] ?? a[1])), a[2], a[3]];
  n.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, a[3]]);
  S.selNode = i + 1; dirty(S.sel.r); endEdit(); syncMesh(S.sel); renderSheet(1); render();
}
function delNode() {
  const n = S.sel?.r.nodes; if (!n || S.selNode < 0 || n.length <= 2) return toast('اختر نقطة (والحد الأدنى نقطتان)');
  beginEdit(); markGesture(); n.splice(S.selNode, 1); S.selNode = -1;
  S.sel.r.position = [n[0][0], n[0][1], n[0][2]]; dirty(S.sel.r); endEdit(); syncMesh(S.sel); renderSheet(1); render();
}

/* ---------- render loop + hud ---------- */
function hud() {
  const t = T(); let s = S.mode === '2d' ? 'من فوق' : 'ثلاثي الأبعاد';
  if (t) s += `<br>تضاريس <span class="n">${t.ext.toFixed(0)}×${t.ext.toFixed(0)} م</span> · خلية <span class="n">${t.sq}</span> · <span class="n">${t.size}px</span>`;
  if (S.sel) s += `<br>${esc(S.sel.cls)} — ${esc(S.sel.r.name || '')}`;
  $('hud').innerHTML = s;
  placeStatus();
}
function render() {
  needRender = true;
  hud(); updateOverlay();
}
function loop() {
  requestAnimationFrame(loop);
  if (!needRender || !renderer) return;
  needRender = false;
  if (camera) renderer.render(scene, camera);
}

/* ---------- chrome buttons + demo ---------- */
$('bOpen').onclick = $('bOpen2').onclick = () => $('fi').click();
$('fi').onchange = e => { if (e.target.files.length) loadFiles([...e.target.files]); e.target.value = ''; };
$('bMode').onclick = () => setMode(S.mode === '3d' ? '2d' : '3d');
$('bUndo').onclick = doUndo;
$('bFit').onclick = fit;
$('bAdd').onclick = () => { S.adding = !S.adding; $('bAdd').classList.toggle('on', S.adding); if (S.adding) { setDock('half'); S.sel = null; highlightSel(); renderSheet(); toast('اضغط على الخريطة لمكان الإضافة'); } };
$('bExp').onclick = doExport;

function buildDemoTer() {
  const SIZE = 32, ver = 8;
  const hm = new Uint16Array(SIZE * SIZE);
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    const cx = (i - (SIZE - 1) / 2) / ((SIZE - 1) / 2);
    const cy = (j - (SIZE - 1) / 2) / ((SIZE - 1) / 2);
    const r2 = cx * cx + cy * cy;
    let h = 0.12 + 0.72 * Math.max(0, 1 - r2) ** 1.2;
    h += 0.08 * (i / (SIZE - 1));
    hm[j * SIZE + i] = Math.max(0, Math.min(65535, Math.round(h * 65535)));
  }
  const buf = new ArrayBuffer(5 + SIZE * SIZE * 2);
  const v = new DataView(buf);
  v.setUint8(0, ver); v.setUint32(1, SIZE, true);
  new Uint8Array(buf).set(new Uint8Array(hm.buffer, hm.byteOffset, hm.byteLength), 5);
  return new File([buf], 'levels/test_arranger/terrain.ter');
}
function buildDemoFiles() {
  const items = `{"name":"test_arranger","class":"SimGroup","persistentId":"9e984d07-87af-5032-b108-baadbe050b3e","__parent":""}
{"name":"MissionGroup","class":"SimGroup","persistentId":"116bcf52-bc70-5cab-8bf7-4c8abc3b1c82","__parent":"test_arranger"}
{"name":"theTerrain","class":"TerrainBlock","persistentId":"603c8b72-983e-562f-9ae5-530df6728c77","__parent":"MissionGroup","position":[0,0,0],"squareSize":4.0,"maxHeight":20.0,"terrainFile":"levels/test_arranger/terrain.ter"}
{"name":"crate_a","class":"TSStatic","persistentId":"5d898e41-e945-59d7-9daf-b31e33247b38","__parent":"MissionGroup","position":[24,24,5.4208],"shapeName":"/levels/test_arranger/box.dae","collisionType":"Visible Mesh","decalType":"None","prebuildCollisionData":0,"useInstanceRenderData":true,"scale":[1,1,1],"rotationMatrix":[1,0,0,0,1,0,0,0,1]}
{"name":"crate_b","class":"TSStatic","persistentId":"1549811f-99b3-534d-8ce1-84aa25ba6b62","__parent":"MissionGroup","position":[48,32,12.645],"shapeName":"/levels/test_arranger/box.dae","collisionType":"Visible Mesh","decalType":"None","prebuildCollisionData":0,"useInstanceRenderData":true,"scale":[1.5,1.2,1],"rotationMatrix":[0.819152,0.573576,0,-0.573576,0.819152,0,0,0,1]}
{"name":"crate_c","class":"TSStatic","persistentId":"c852578e-899a-5978-b123-481d889d092c","__parent":"MissionGroup","position":[88,88,12.0953],"shapeName":"/levels/test_arranger/box.dae","collisionType":"Bounds","decalType":"None","prebuildCollisionData":0,"useInstanceRenderData":true,"scale":[0.8,0.8,1.4],"rotationMatrix":[0.939693,-0.34202,0,0.34202,0.939693,0,0,0,1]}
{"name":"main_road","class":"DecalRoad","persistentId":"58893254-d250-562d-90d0-a0956502351b","__parent":"MissionGroup","position":[12,40,4.9426],"improvedSpline":true,"material":"road_asphalt_2lane","nodes":[[12,40,4.9426,6],[40,44,13.7646,6],[70,52,16.9511,8],[100,60,11.8561,6]],"breakAngle":1,"renderPriority":10,"textureLength":6.4,"detail":0.1}
{"name":"spawn_start","class":"SpawnSphere","persistentId":"ccc29f96-773b-53db-a2e2-ae8cc24818fb","__parent":"MissionGroup","position":[28,50,11.5198],"rotationMatrix":[1,0,0,0,1,0,0,0,1],"radius":2,"spawnClass":"BeamNGVehicle"}
{"name":"wp_hill","class":"BeamNGWaypoint","persistentId":"0d2e5b5b-ee1b-5023-acf0-21cbb01142c4","__parent":"MissionGroup","position":[64,64,17.5897],"scale":[2,2,2],"rotationMatrix":[1,0,0,0,1,0,0,0,1]}
{"name":"light_yard","class":"PointLight","persistentId":"0f9a7cc1-145a-5e88-978c-f6e5ba78206d","__parent":"MissionGroup","position":[36,70,13.9882],"color":[1,0.95,0.8,1],"radius":12}
{"name":"poi_view","class":"BeamNGPointOfInterest","persistentId":"dfcf9d1e-13e9-5bb5-9125-2a3d74200e17","__parent":"MissionGroup","position":[20,90,6.5532],"rotationMatrix":[1,0,0,0,1,0,0,0,1]}
{"name":"demo_car","class":"BeamNGVehicle","persistentId":"4f45ea1f-7217-5692-9969-c604a07e53ec","__parent":"MissionGroup","position":[32,36,10.4581],"rotationMatrix":[0.0,1.0,0,-1.0,0.0,0,0,0,1],"scale":[1,1,1],"JBeam":"pickup"}
{"name":"shed_prefab","class":"Prefab","persistentId":"3a4bc242-47c1-5bf1-beb7-2bf5a42cd585","__parent":"MissionGroup","position":[72,24,11.1038],"rotationMatrix":[0.965926,0.258819,0,-0.258819,0.965926,0,0,0,1],"scale":[1,1,1],"filename":"levels/test_arranger/shed.prefab"}
{"name":"pine_item","class":"TSForestItemData","persistentId":"62c2a172-fa12-5888-9245-6569003cdb64","__parent":"MissionGroup","position":[56,80,15.9195],"scale":[1,1,1],"shapeFile":"/levels/test_arranger/box.dae"}
`;
  const dae = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <unit meter="1" name="meter"/>
    <up_axis>Z_UP</up_axis>
  </asset>
  <library_geometries>
    <geometry id="box">
      <mesh>
        <source id="box-positions-src">
          <float_array id="box-positions" count="24">-1 -1 0 1 -1 0 1 1 0 -1 1 0 -1 -1 2 1 -1 2 1 1 2 -1 1 2</float_array>
          <technique_common>
            <accessor source="#box-positions" count="8" stride="3">
              <param name="X" type="float"/>
              <param name="Y" type="float"/>
              <param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
      </mesh>
    </geometry>
  </library_geometries>
</COLLADA>
`;
  return [
    new File([items], 'levels/test_arranger/items.level.json', { type: 'application/json' }),
    buildDemoTer(),
    new File([dae], 'levels/test_arranger/box.dae', { type: 'model/vnd.collada+xml' })
  ];
}
async function loadDemo() {
  const msg = $('msg'); if (msg) msg.textContent = 'جاري تحميل الخريطة النموذجية...';
  try {
    try {
      const res = await fetch('testdata/level.zip');
      if (res.ok) { const blob = await res.blob(); await loadFiles([new File([blob], 'level.zip')]); return; }
    } catch (_) {}
    try { // text copy of the same zip (the site is published from text files)
      const res = await fetch('testdata/level.zip.b64');
      if (res.ok) {
        const bin = atob((await res.text()).replace(/\s+/g, ''));
        const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        await loadFiles([new File([u8], 'level.zip')]); return;
      }
    } catch (_) {}
    await loadFiles(buildDemoFiles());
  } catch (e) { if (msg) msg.textContent = 'خطأ: ' + e.message; }
}
$('bDemo').onclick = loadDemo;

/* ---------- test hooks ---------- */
window.__S = S;
window.__load = loadFiles;
window.__loadDemo = loadDemo;
window.__exportText = exportText;
window.__test = {
  loadDemo,
  objs: () => S.objs.map((o, i) => ({ i, cls: o.cls, name: o.r.name, pos: (o.r.position || []).slice(), scale: scl(o.r), rot: rotZ(o.r) })),
  select(i) { closeMenu(); S.sel = S.objs[i] || null; S.selNode = -1; highlightSel(); renderSheet(); updateOverlay(); render(); },
  screenOf(i) {
    const o = S.objs[i]; if (!o) return null;
    const p = o.r.position || (o.r.nodes && o.r.nodes[0]); if (!p) return null;
    const q = project(p[0], p[1], (p[2] || 0) + 0.5);
    const r = cv.getBoundingClientRect();
    return [r.left + q[0], r.top + q[1]];
  },
  setMode, mode: () => S.mode, fit, focus: i => { const o=S.objs[i]; if(o){ S.sel=o; highlightSel(); focusObj(o);} }, undo: doUndo, redo: doRedo,
  setAutoZ: v => { S.autoZ = !!v; },
  cam: () => ({ ...camState, target: camState.target.toArray() }),
  exportLines: () => exportText()[0]?.txt,
  bounds: i => S.objs[i] && boundsOf(S.objs[i]),
  worldBox: i => S.objs[i] && worldBox(S.objs[i]),
  menuOpen: () => menuOpen(),
  assets: () => S.astat && { ...S.astat, tex: { ...S.astat.tex }, shapes: [...S.shapeByName.keys()], batches: realGroup.children.length, terTex: !!S.terTex, roadMats: [...S.roadMats.keys()] },
  ready: () => !!S.astat && !S.astat.loading,
  setCam: c => { cancelAnimationFrame(fly); if (c.target) camState.target.set(...c.target); for (const k of ['dist', 'yaw', 'pitch', 'ortho']) if (c[k] != null) camState[k] = c[k]; updateCamera(); render(); },
  info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, geos: renderer.info.memory.geometries, texs: renderer.info.memory.textures, dpr }),
  pick: (x, y) => { const o = pickAt(x, y); return o ? S.objs.indexOf(o) : -1; },
  openMenu: i => openMenu(S.objs[i]),
  closeMenu
};

/* ---------- boot ---------- */
initThree();
setDock('collapsed');
renderSheet();
updateCamera();
render();
