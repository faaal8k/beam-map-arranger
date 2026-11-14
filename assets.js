// Real-look assets for the 3D view: resolve files inside the loaded level zip,
// read BeamNG materials, decode textures (png/jpg/tga/dds incl. DXT1/3/5) and
// turn TSStatic .dae shapes into baked, shareable geometry.
import * as THREE from './vendor/three.module.min.js';
import { ColladaLoader } from './vendor/ColladaLoader.js';
import { TGALoader } from './vendor/TGALoader.js';

const readText = async e => (e.text ? await e.text() : await e.async('string'));
const readBuf = async e => (e.arrayBuffer ? await e.arrayBuffer() : await e.async('arraybuffer'));
export const yieldUI = () => new Promise(r => setTimeout(r, 0));
const IMG_EXT = ['.dds', '.png', '.jpg', '.jpeg', '.tga'];

/* ---------- path index ---------- */
export function normPath(p) {
  let s = String(p || '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const out = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/').toLowerCase();
}
export const dirOf = p => { const n = normPath(p); const i = n.lastIndexOf('/'); return i < 0 ? '' : n.slice(0, i); };

export function buildIndex(files) {
  const exact = new Map(), suffix = new Map();
  const paths = [...files.keys()].sort((a, b) => a.length - b.length);
  for (const p of paths) {
    const n = normPath(p); const e = files.get(p);
    if (!exact.has(n)) exact.set(n, { path: n, entry: e });
    const segs = n.split('/');
    for (let i = 1; i < segs.length; i++) {
      const suf = segs.slice(i).join('/');
      if (!suffix.has(suf)) suffix.set(suf, { path: n, entry: e });
    }
  }
  function lookup(c) {
    if (exact.has(c)) return exact.get(c);
    if (suffix.has(c)) return suffix.get(c); // zip has an extra root folder
    const segs = c.split('/');
    for (let i = 1; i <= segs.length - 2; i++) { // zip is rooted below levels/<name>/
      const v = segs.slice(i).join('/');
      if (exact.has(v)) return exact.get(v);
      if (suffix.has(v)) return suffix.get(v);
    }
    return null;
  }
  const memo = new Map();
  function resolve(ref, bases = [], exts = null) {
    if (!ref) return null;
    const raw = String(ref).trim().replace(/\\/g, '/');
    const key = raw + '|' + bases.join(',') + '|' + (exts ? exts.join() : '');
    if (memo.has(key)) return memo.get(key);
    const cands = [];
    const relative = !raw.startsWith('/') && (raw.startsWith('.') || !raw.includes('/'));
    if (relative) for (const b of bases) cands.push(normPath(b + '/' + raw));
    cands.push(normPath(raw));
    if (!relative) for (const b of bases) cands.push(normPath(b + '/' + raw));
    let hit = null;
    for (const c of cands) { if ((hit = lookup(c))) break; }
    if (!hit && exts) {
      outer: for (const c of cands) {
        const stem = c.replace(/\.(dds|png|jpe?g|tga)$/i, '');
        for (const x of exts) { if ((hit = lookup(stem + x))) break outer; }
      }
    }
    memo.set(key, hit);
    return hit;
  }
  return { resolve, exact };
}

/* ---------- tolerant JSON (BeamNG "sjson": comments, missing/trailing commas) ---------- */
export function parseLoose(txt) {
  try { return JSON.parse(txt); } catch (_) {}
  let i = 0; const s = txt;
  const ws = () => {
    for (;;) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (s[i] === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (s[i] === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i + 2); i = j < 0 ? s.length : j + 2; continue; }
      break;
    }
  };
  const str = () => {
    i++; let o = '';
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\') { const c = s[++i]; o += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'u' ? String.fromCharCode(parseInt(s.substr(i + 1, 4), 16)) : c; if (c === 'u') i += 4; i++; }
      else o += s[i++];
    }
    i++; return o;
  };
  const val = () => {
    ws(); const c = s[i];
    if (c === '{') {
      i++; const o = {};
      for (;;) { ws(); if (s[i] === '}' || i >= s.length) { i++; return o; }
        let k; if (s[i] === '"') k = str(); else { const m = /^[^\s:=]+/.exec(s.slice(i)); k = m ? m[0] : ''; i += k.length || 1; }
        ws(); if (s[i] === ':' || s[i] === '=') i++; o[k] = val(); }
    }
    if (c === '[') { i++; const a = []; for (;;) { ws(); if (s[i] === ']' || i >= s.length) { i++; return a; } a.push(val()); } }
    if (c === '"') return str();
    const m = /^[^\s,\]}]+/.exec(s.slice(i)); const t = m ? m[0] : ''; i += t.length || 1;
    if (t === 'true') return true; if (t === 'false') return false; if (t === 'null') return null;
    const n = Number(t); return isNaN(n) ? t : n;
  };
  return val();
}

/* ---------- materials ---------- */
const vec4 = v => {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === 'string') { const a = v.trim().split(/[\s,]+/).map(Number); if (a.length >= 3 && a.every(x => !isNaN(x))) return a; }
  return null;
};
const first = v => Array.isArray(v) ? v.find(x => x) : v;
function normMat(name, d, dir) {
  const st = Array.isArray(d.Stages) ? d.Stages : (Array.isArray(d.stages) ? d.stages : []);
  const s0 = st.find(x => x && (x.baseColorMap || x.colorMap || x.diffuseMap)) || st[0] || {};
  const pick = k => first(s0[k]) ?? first(d[k]);
  const cls = d.class || d.__class || 'Material';
  const m = {
    key: name, cls, dir,
    mapTo: String(d.mapTo || '').toLowerCase(),
    colorMap: pick('baseColorMap') || pick('colorMap') || pick('diffuseMap') || null,
    color: vec4(s0.baseColorFactor) || vec4(s0.diffuseColor) || vec4(d.baseColorFactor) || vec4(first(d.diffuseColor)) || null,
    alphaTest: !!(d.alphaTest === true || d.alphaTest === 1 || d.alphaTest === '1' || String(d.alphaTest).toLowerCase() === 'true'),
    alphaRef: +d.alphaRef || 0,
    translucent: !!(d.translucent === true || d.translucent === 1 || String(d.translucent).toLowerCase() === 'true'),
    doubleSided: !!(d.doubleSided === true || d.doubleSided === 1 || String(d.doubleSided).toLowerCase() === 'true'),
  };
  if (/terrainmaterial/i.test(cls)) {
    m.internalName = String(d.internalName || name).toLowerCase();
    m.colorMap = first(d.baseColorBaseTex) || first(d.diffuseMap) || first(d.baseColorDetailTex) || first(d.detailMap) || null;
    m.tile = +(d.baseColorBaseTex ? (d.baseColorBaseTexSize || d.diffuseSize) : d.diffuseMap ? d.diffuseSize : (d.baseColorDetailTexSize || d.detailSize)) || 0;
  }
  return m;
}
function parseCS(txt, dir, out) {
  const re = /(?:singleton|new)\s+(\w*Material)\s*\(\s*([^)]*?)\s*\)\s*\{([\s\S]*?)\}\s*;/g; let m;
  while ((m = re.exec(txt))) {
    const d = { class: m[1] }; const body = m[3];
    const fr = /(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*=\s*"([^"]*)"\s*;/g; let f;
    while ((f = fr.exec(body))) { const k = f[1]; if (f[2] && f[2] !== '0' && d[k] !== undefined) continue; d[k] = f[3]; }
    out.push(normMat(m[2] || d.internalName || '', d, dir));
  }
}
export async function loadMaterials(files) {
  const list = [];
  for (const [p, e] of files) {
    const pl = p.toLowerCase();
    if (pl.endsWith('materials.json')) {
      try {
        const j = parseLoose(await readText(e));
        if (j && typeof j === 'object') for (const [k, d] of Object.entries(j)) if (d && typeof d === 'object') list.push(normMat(d.name || k, d, dirOf(p)));
      } catch (_) {}
    } else if (pl.endsWith('materials.cs')) {
      try { parseCS(await readText(e), dirOf(p), list); } catch (_) {}
    }
  }
  const byName = new Map(), byMap = new Map(), terrain = new Map();
  for (const m of list) {
    if (m.internalName) { if (!terrain.has(m.internalName)) terrain.set(m.internalName, m); continue; }
    const k = String(m.key).toLowerCase();
    if (!byName.has(k)) byName.set(k, m);
    if (m.mapTo && !byMap.has(m.mapTo)) byMap.set(m.mapTo, m);
  }
  const find = name => {
    if (!name) return null;
    const n = String(name).toLowerCase();
    const vs = [n, n.replace(/(-material|_material|-mat|_mat)$/, ''), n.replace(/-fx$|-effect$/, '')];
    for (const v of vs) { if (byMap.has(v)) return byMap.get(v); if (byName.has(v)) return byName.get(v); }
    return null;
  };
  return { find, terrain, count: list.length };
}

/* ---------- image decoding ---------- */
const pow2floor = n => 2 ** Math.floor(Math.log2(Math.max(1, n)));
function resample(img, tw, th) {
  if (img.w === tw && img.h === th) return img;
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(img.h - 1, Math.floor((y + 0.5) * img.h / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(img.w - 1, Math.floor((x + 0.5) * img.w / tw));
      const si = (sy * img.w + sx) * 4, di = (y * tw + x) * 4;
      out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = img.data[si + 3];
    }
  }
  return { w: tw, h: th, data: out };
}
const fitPow2 = (img, cap) => resample(img, Math.min(cap, pow2floor(img.w)), Math.min(cap, pow2floor(img.h)));

function c565(c, o, k) { o[k] = ((c >> 11) & 31) * 255 / 31 | 0; o[k + 1] = ((c >> 5) & 63) * 255 / 63 | 0; o[k + 2] = (c & 31) * 255 / 31 | 0; o[k + 3] = 255; }
function colorBlock(v, off, pal, four) {
  const a = v.getUint16(off, true), b = v.getUint16(off + 2, true);
  c565(a, pal, 0); c565(b, pal, 4);
  if (four || a > b) {
    for (let i = 0; i < 3; i++) { pal[8 + i] = (2 * pal[i] + pal[4 + i]) / 3 | 0; pal[12 + i] = (pal[i] + 2 * pal[4 + i]) / 3 | 0; }
    pal[11] = 255; pal[15] = 255;
  } else {
    for (let i = 0; i < 3; i++) { pal[8 + i] = (pal[i] + pal[4 + i]) / 2 | 0; pal[12 + i] = 0; }
    pal[11] = 255; pal[15] = 0;
  }
  return v.getUint32(off + 4, true);
}
function alphaBlock5(v, off, out) {
  const a0 = v.getUint8(off), a1 = v.getUint8(off + 1); const al = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) al.push(((7 - i) * a0 + i * a1) / 7 | 0);
  else { for (let i = 1; i < 5; i++) al.push(((5 - i) * a0 + i * a1) / 5 | 0); al.push(0, 255); }
  const lo = v.getUint8(off + 2) | (v.getUint8(off + 3) << 8) | (v.getUint8(off + 4) << 16);
  const hi = v.getUint8(off + 5) | (v.getUint8(off + 6) << 8) | (v.getUint8(off + 7) << 16);
  for (let i = 0; i < 8; i++) { out[i] = al[(lo >> (3 * i)) & 7]; out[8 + i] = al[(hi >> (3 * i)) & 7]; }
}
function decodeBlocks(v, off, w, h, fmt) {
  const out = new Uint8ClampedArray(w * h * 4);
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  const pal = new Uint8Array(16), al = new Uint8Array(16);
  const bs = fmt === 'BC1' || fmt === 'BC4' ? 8 : 16;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = off + (by * bw + bx) * bs;
    let idx = 0, hasA = false;
    if (fmt === 'BC4') {
      alphaBlock5(v, o, al);
      for (let p = 0; p < 16; p++) { const x = bx * 4 + (p & 3), y = by * 4 + (p >> 2); if (x >= w || y >= h) continue; const d = (y * w + x) * 4; out[d] = out[d + 1] = out[d + 2] = al[p]; out[d + 3] = 255; }
      continue;
    }
    if (fmt === 'BC2') { for (let p = 0; p < 16; p++) { const byte = v.getUint8(o + (p >> 1)); al[p] = ((p & 1) ? byte >> 4 : byte & 15) * 17; } hasA = true; idx = colorBlock(v, o + 8, pal, true); }
    else if (fmt === 'BC3') { alphaBlock5(v, o, al); hasA = true; idx = colorBlock(v, o + 8, pal, true); }
    else idx = colorBlock(v, o, pal, false);
    for (let p = 0; p < 16; p++) {
      const x = bx * 4 + (p & 3), y = by * 4 + (p >> 2); if (x >= w || y >= h) continue;
      const c = ((idx >>> (2 * p)) & 3) * 4, d = (y * w + x) * 4;
      out[d] = pal[c]; out[d + 1] = pal[c + 1]; out[d + 2] = pal[c + 2]; out[d + 3] = hasA ? al[p] : pal[c + 3];
    }
  }
  return out;
}
const maskShift = m => { if (!m) return [0, 0]; let s = 0; while (!((m >>> s) & 1)) s++; let b = 0; while ((m >>> (s + b)) & 1) b++; return [s, b]; };
export function decodeDDS(buf, cap = 1024) {
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== 0x20534444) throw new Error('not dds');
  const h = v.getUint32(12, true), w = v.getUint32(16, true);
  const mips = Math.max(1, v.getUint32(28, true));
  const pfFlags = v.getUint32(80, true), four = String.fromCharCode(v.getUint8(84), v.getUint8(85), v.getUint8(86), v.getUint8(87));
  let off = 128, fmt = null, bpp = 0, masks = null;
  if (pfFlags & 4) {
    if (four === 'DXT1') fmt = 'BC1'; else if (four === 'DXT2' || four === 'DXT3') fmt = 'BC2'; else if (four === 'DXT4' || four === 'DXT5') fmt = 'BC3';
    else if (four === 'ATI1' || four === 'BC4U') fmt = 'BC4';
    else if (four === 'DX10') {
      const dx = v.getUint32(128, true); off = 148;
      if (dx === 71 || dx === 72) fmt = 'BC1'; else if (dx === 74 || dx === 75) fmt = 'BC2'; else if (dx === 77 || dx === 78) fmt = 'BC3';
      else if (dx === 80 || dx === 81) fmt = 'BC4';
      else if (dx === 28 || dx === 29) { fmt = 'RGB'; bpp = 4; masks = [0xff, 0xff00, 0xff0000, 0xff000000]; }
      else if (dx === 87 || dx === 91) { fmt = 'RGB'; bpp = 4; masks = [0xff0000, 0xff00, 0xff, 0xff000000]; }
      else throw new Error('dds dxgi ' + dx + (dx === 98 || dx === 99 ? ' (BC7)' : '') + ' غير مدعوم');
    } else throw new Error('dds ' + four + ' غير مدعوم');
  } else if (pfFlags & 0x40 || pfFlags & 0x20000) {
    bpp = v.getUint32(88, true) / 8; fmt = 'RGB';
    masks = [v.getUint32(92, true), v.getUint32(96, true), v.getUint32(100, true), (pfFlags & 1) ? v.getUint32(104, true) : 0];
    if (pfFlags & 0x20000 && !masks[1]) masks = [masks[0], masks[0], masks[0], masks[3]];
  } else throw new Error('dds format');
  const size = (lw, lh) => fmt === 'RGB' ? lw * lh * bpp : Math.max(1, Math.ceil(lw / 4)) * Math.max(1, Math.ceil(lh / 4)) * (fmt === 'BC1' || fmt === 'BC4' ? 8 : 16);
  let lw = w, lh = h, L = 0;
  while (L < mips - 1 && Math.max(lw, lh) > cap) { off += size(lw, lh); lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1); L++; }
  if (off + size(lw, lh) > buf.byteLength) throw new Error('dds truncated');
  let data;
  if (fmt === 'RGB') {
    data = new Uint8ClampedArray(lw * lh * 4);
    const sh = masks.map(maskShift);
    for (let i = 0; i < lw * lh; i++) {
      let px = 0; const o = off + i * bpp;
      for (let b = 0; b < bpp; b++) px |= v.getUint8(o + b) << (8 * b);
      px >>>= 0;
      for (let c = 0; c < 4; c++) {
        const [s, n] = sh[c];
        data[i * 4 + c] = !masks[c] ? 255 : n >= 8 ? (px >>> (s + n - 8)) & 255 : (((px >>> s) & ((1 << n) - 1)) * 255 / ((1 << n) - 1)) | 0;
      }
    }
  } else data = decodeBlocks(v, off, lw, lh, fmt);
  return { w: lw, h: lh, data };
}

async function decodeRaster(buf, ext) {
  const blob = new Blob([buf], { type: ext === '.png' ? 'image/png' : 'image/jpeg' });
  let src, w, h;
  if (typeof createImageBitmap === 'function') { src = await createImageBitmap(blob); w = src.width; h = src.height; }
  else {
    src = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('img')); im.src = URL.createObjectURL(blob); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  return { src, w, h };
}
// Returns {w,h,data:RGBA top-down} with power-of-two size <= cap.
export async function decodeImage(entry, path, cap) {
  const ext = (/\.[a-z0-9]+$/i.exec(path) || [''])[0].toLowerCase();
  const buf = await readBuf(entry);
  if (ext === '.dds') return fitPow2(decodeDDS(buf, cap), cap);
  if (ext === '.tga') {
    const t = new TGALoader().parse(buf);
    let img = { w: t.width, h: t.height, data: new Uint8ClampedArray(t.data.buffer, t.data.byteOffset, t.data.byteLength) };
    if (t.flipY) img = flipRows(img);
    return fitPow2(img, cap);
  }
  const { src, w, h } = await decodeRaster(buf, ext);
  const tw = Math.min(cap, pow2floor(w)), th = Math.min(cap, pow2floor(h));
  const c = document.createElement('canvas'); c.width = tw; c.height = th;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, tw, th);
  src.close?.();
  const d = g.getImageData(0, 0, tw, th).data;
  c.width = c.height = 1;
  return { w: tw, h: th, data: d };
}
function flipRows(img) {
  const out = new Uint8ClampedArray(img.data.length), row = img.w * 4;
  for (let y = 0; y < img.h; y++) out.set(img.data.subarray(y * row, y * row + row), (img.h - 1 - y) * row);
  return { w: img.w, h: img.h, data: out };
}
export function avgColor(img) {
  let r = 0, g = 0, b = 0, n = 0; const step = Math.max(1, (img.w * img.h / 4096) | 0) * 4;
  for (let i = 0; i < img.data.length; i += step) { if (img.data[i + 3] < 40) continue; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : [0.6, 0.6, 0.6];
}
function hasAlpha(img) { for (let i = 3; i < img.data.length; i += 16) if (img.data[i] < 250) return true; return false; }

/* ---------- asset store (one per loaded level) ---------- */
export class AssetStore {
  constructor(files, phone) {
    this.files = files; this.index = buildIndex(files); this.cap = phone ? 512 : 1024; this.phone = phone;
    this.mats = null; this.tex = new Map(); this.pix = new Map(); this.matCache = new Map(); this.shapes = new Map();
    this.texStats = { found: 0, missing: 0, failed: 0, bc7: 0 }; this.disposed = false;
  }
  async init() { this.mats = await loadMaterials(this.files); return this; }
  resolveImage(ref, bases) { return this.index.resolve(ref, bases, IMG_EXT); }
  // GPU texture for a material colour map; cached per resolved file.
  async texture(ref, bases) {
    const hit = this.resolveImage(ref, bases);
    if (!hit) { this.texStats.missing++; return null; }
    if (this.tex.has(hit.path)) return this.tex.get(hit.path);
    const p = (async () => {
      try {
        const img = await decodeImage(hit.entry, hit.path, this.cap);
        const flipped = flipRows(img);
        const t = new THREE.DataTexture(new Uint8Array(flipped.data.buffer), img.w, img.h, THREE.RGBAFormat);
        t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
        t.anisotropy = this.phone ? 2 : 4; t.needsUpdate = true; t.name = hit.path;
        t.userData.alpha = hasAlpha(img); t.userData.avg = avgColor(img);
        t.onUpdate = () => { t.image = { width: img.w, height: img.h, data: null }; }; // free CPU copy once uploaded
        this.texStats.found++;
        return t;
      } catch (e) { this.texStats.failed++; if (/BC7/.test(e.message)) this.texStats.bc7++; return null; }
    })();
    this.tex.set(hit.path, p);
    return p;
  }
  // Small CPU-side pixels (terrain baking).
  async pixels(ref, bases, cap = 256) {
    const hit = this.resolveImage(ref, bases); if (!hit) return null;
    const k = hit.path + '@' + cap;
    if (!this.pix.has(k)) this.pix.set(k, decodeImage(hit.entry, hit.path, cap).catch(() => null));
    return this.pix.get(k);
  }
  async material(name, fallback) {
    const def = this.mats.find(name);
    const key = (def ? 'm:' + def.key : 'c:' + name) + '|' + (fallback?.src || '');
    if (this.matCache.has(key)) return this.matCache.get(key);
    const p = (async () => {
      const opts = { side: THREE.FrontSide };
      let map = null;
      if (def && def.colorMap) map = await this.texture(def.colorMap, [def.dir, fallback?.dir || '']);
      if (!map && fallback?.src) map = await this.texture(fallback.src, [fallback.dir]);
      const col = def?.color || null;
      if (map) { opts.map = map; if (col) opts.color = new THREE.Color(col[0], col[1], col[2]); }
      else if (col) opts.color = new THREE.Color(col[0], col[1], col[2]);
      else if (fallback?.color) opts.color = fallback.color.clone();
      else opts.color = new THREE.Color(0.75, 0.75, 0.72);
      if (def?.translucent) { opts.transparent = true; opts.depthWrite = false; }
      if (def?.alphaTest || (map && map.userData.alpha && !def?.translucent)) { opts.alphaTest = def?.alphaRef ? Math.min(0.9, def.alphaRef / 255) : 0.4; opts.side = THREE.DoubleSide; }
      if (def?.doubleSided) opts.side = THREE.DoubleSide;
      const m = new THREE.MeshLambertMaterial(opts);
      m.name = def ? def.key : name; m.userData.shared = true; m.userData.textured = !!map;
      return m;
    })();
    this.matCache.set(key, p);
    return p;
  }
  // Load + bake one .dae; result cached per resolved file. null => missing.
  async shape(ref, bases) {
    const hit = this.index.resolve(ref, bases);
    if (!hit || !hit.path.endsWith('.dae')) return null;
    if (this.shapes.has(hit.path)) return this.shapes.get(hit.path);
    const p = this._loadShape(hit).catch(e => ({ error: e.message || String(e), path: hit.path }));
    this.shapes.set(hit.path, p);
    return p;
  }
  async _loadShape(hit) {
    const sz = hit.entry._data ? hit.entry._data.uncompressedSize : hit.entry.size;
    if (sz > 60e6) throw new Error('ملف كبير');
    const txt = await readText(hit.entry);
    const up = ((/<up_axis>\s*([XYZ])_UP/i.exec(txt) || [])[1] || 'Y').toUpperCase();
    const col = new ColladaLoader().parse(txt, '');
    const root = col.scene;
    root.rotation.set(up === 'Y' ? Math.PI / 2 : 0, 0, up === 'X' ? Math.PI / 2 : 0);
    root.updateMatrixWorld(true);
    const dir = dirOf(hit.path);
    const lodMode = /<node[^>]*name="(base0*\d*|start0*1|detail\d+)"/i.test(txt);
    const meshes = [];
    root.traverse(o => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      for (let a = o; a && a !== root; a = a.parent) if (isHelper(a.name)) return;
      meshes.push(o);
    });
    let keep = meshes;
    if (lodMode) {
      const best = new Map();
      const lod = m => { const r = /^(.*?[^\d.])(-?\d+)$/.exec(m.name || ''); return r ? [r[1].toLowerCase(), +r[2]] : [String(m.name).toLowerCase(), Infinity]; };
      for (const m of meshes) { const [b, n] = lod(m); if (!best.has(b) || n > best.get(b)) best.set(b, n); }
      keep = meshes.filter(m => { const [b, n] = lod(m); return n === best.get(b); });
    }
    // bucket by material, bake node transforms into shape space (Z-up metres)
    const buckets = new Map();
    for (const m of keep) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const g = m.geometry;
      const groups = g.groups && g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : g.attributes.position.count, materialIndex: 0 }];
      for (const gr of groups) {
        const mt = mats[gr.materialIndex ?? 0] || mats[0];
        const nm = mt?.name || 'default';
        const src = mt?.map?.userData?.src || null;
        const k = nm + '|' + (src || '');
        if (!buckets.has(k)) buckets.set(k, { name: nm, src, color: mt?.color, parts: [] });
        buckets.get(k).parts.push({ g, matrix: m.matrixWorld, start: gr.start, count: gr.count });
      }
    }
    const parts = []; const bb = new THREE.Box3();
    for (const b of buckets.values()) {
      const geo = bake(b.parts); if (!geo) continue;
      geo.computeBoundingBox(); bb.union(geo.boundingBox); geo.computeBoundingSphere();
      geo.userData.shared = true;
      const mat = await this.material(b.name, { src: b.src, dir, color: b.color });
      parts.push({ geo, mat });
    }
    root.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    if (!parts.length) throw new Error('no meshes');
    return { path: hit.path, parts, bounds: { x0: bb.min.x, x1: bb.max.x, y0: bb.min.y, y1: bb.max.y, z0: bb.min.z, z1: bb.max.z }, textured: parts.some(p => p.mat.userData.textured) };
  }
  dispose() {
    this.disposed = true;
    for (const p of this.shapes.values()) Promise.resolve(p).then(s => { s?.parts?.forEach(x => x.geo.dispose()); s?.proxyGeo?.dispose(); }).catch(() => {});
    for (const p of this.matCache.values()) Promise.resolve(p).then(m => m?.dispose()).catch(() => {});
    for (const p of this.tex.values()) Promise.resolve(p).then(t => t?.dispose()).catch(() => {});
    this.shapes.clear(); this.matCache.clear(); this.tex.clear(); this.pix.clear();
  }
}
export function isHelper(name) {
  const n = String(name || '').toLowerCase();
  return /^(col|colmesh|collision|los)([-_\d]|$)/.test(n) || n.startsWith('colmesh') || n.includes('autobillboard') || n.startsWith('nulldetail') || n.startsWith('bb_');
}
// Merge index ranges of several geometries (with their world matrices) into one indexed geometry.
function bake(parts) {
  let nv = 0, ni = 0;
  for (const p of parts) { ni += p.count; nv += Math.min(p.count, p.g.attributes.position.count); }
  if (!ni) return null;
  const pos = new Float32Array(nv * 3), nor = new Float32Array(pos.length), uv = new Float32Array(nv * 2);
  const idx = new Uint32Array(ni);
  let v = 0, k = 0; let hasN = true, hasUV = false;
  const nm = new THREE.Matrix3(), tv = new THREE.Vector3();
  for (const p of parts) {
    const g = p.g, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, I = g.index;
    if (!N) hasN = false; if (U) hasUV = true;
    nm.getNormalMatrix(p.matrix); const flip = p.matrix.determinant() < 0;
    const remap = new Int32Array(P.count).fill(-1);
    for (let t = 0; t + 2 < p.count; t += 3) {
      const tri = [0, 1, 2].map(q => I ? I.getX(p.start + t + q) : p.start + t + q);
      if (flip) { const s = tri[1]; tri[1] = tri[2]; tri[2] = s; }
      for (const src of tri) {
        if (remap[src] < 0) {
          if (v * 3 >= pos.length) return null;
          remap[src] = v;
          tv.fromBufferAttribute(P, src).applyMatrix4(p.matrix); pos[v * 3] = tv.x; pos[v * 3 + 1] = tv.y; pos[v * 3 + 2] = tv.z;
          if (N) { tv.fromBufferAttribute(N, src).applyMatrix3(nm).normalize(); nor[v * 3] = tv.x; nor[v * 3 + 1] = tv.y; nor[v * 3 + 2] = tv.z; }
          if (U) { uv[v * 2] = U.getX(src); uv[v * 2 + 1] = U.getY(src); }
          v++;
        }
        idx[k++] = remap[src];
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, v * 3), 3));
  if (hasN) geo.setAttribute('normal', new THREE.BufferAttribute(nor.slice(0, v * 3), 3));
  if (hasUV) geo.setAttribute('uv', new THREE.BufferAttribute(uv.slice(0, v * 2), 2));
  geo.setIndex(new THREE.BufferAttribute(v > 65535 ? idx.slice(0, k) : Uint16Array.from(idx.subarray(0, k)), 1));
  if (!hasN) geo.computeVertexNormals();
  return geo;
}
