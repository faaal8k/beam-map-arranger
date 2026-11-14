import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadGroup(txt) {
  const recs = [];
  const lines = txt.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) { recs.push({ __raw: ln }); continue; }
    try { const r = JSON.parse(t); r.__src = ln; recs.push(r); }
    catch { recs.push({ __raw: ln }); }
  }
  return recs;
}
function exportTxt(recs) {
  return recs.map(r => {
    if (r.__raw !== undefined) return r.__raw;
    if (!r.__dirty && r.__src !== undefined) return r.__src;
    const o = {}; for (const k in r) if (!['__src','__dirty','__raw','__u'].includes(k)) o[k] = r[k];
    return JSON.stringify(o);
  }).join('\n') + '\n';
}

const src = readFileSync(join(root, 'testdata/items.level.json'), 'utf8');
const recs = loadGroup(src);
const out = exportTxt(recs);
if (out !== src) {
  console.error('FAIL identity\n--- src ---\n', src, '\n--- out ---\n', out);
  process.exit(1);
}
// mutate one TSStatic
const crate = recs.find(r => r.name === 'crate_a');
crate.position[0] += 5; crate.__dirty = true;
const out2 = exportTxt(recs);
const sLines = src.split('\n'), oLines = out2.split('\n');
let changed = 0;
for (let i = 0; i < sLines.length; i++) {
  if (sLines[i] !== oLines[i]) changed++;
}
if (changed !== 1) { console.error('expected 1 changed line, got', changed); process.exit(1); }
if (!oLines.some(l => l.includes('"name":"crate_a"') && l.includes('29'))) {
  console.error('edited line missing new x', oLines.find(l => l.includes('crate_a')));
  process.exit(1);
}

// ter parse
const buf = readFileSync(join(root, 'testdata/terrain.ter'));
const ver = buf[0], size = buf.readUInt32LE(1);
if (ver !== 8 || size < 32 || buf.length < 5 + size * size * 3) { console.error('bad ter header', ver, size); process.exit(1); }
const hm = new Uint16Array(buf.buffer.slice(buf.byteOffset + 5, buf.byteOffset + 5 + size * size * 2));
const mid = hm[(size >> 1) * size + (size >> 1)];
if (!(mid > hm[0])) { console.error('hill expected at center', mid, hm[0]); process.exit(1); }
// layer map + material names follow the heightmap
const layer = buf.subarray(5 + size * size * 2, 5 + size * size * 3);
let off = 5 + size * size * 3; const nMat = buf.readUInt32LE(off); off += 4; const names = [];
for (let i = 0; i < nMat; i++) { const l = buf[off++]; names.push(buf.subarray(off, off + l).toString()); off += l; }
if (!names.length || Math.max(...layer) >= names.length) { console.error('bad layer data', names); process.exit(1); }
console.log('roundtrip OK', recs.filter(r=>r.class).length, 'records, ter', size, 'peak', mid, 'layers', names.join('/'));
