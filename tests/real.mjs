// Real-look + touch/menu checks at iPhone 14 Pro Max size. BROWSER=webkit|chromium
import pkg from '/tmp/node_modules/playwright-core/index.js';
import { mkdirSync } from 'fs';
const OUT = '/workspace/beam-shots'; mkdirSync(OUT, { recursive: true });
const which = process.env.BROWSER || 'webkit';
const URL = process.env.URL || 'http://127.0.0.1:8765/';
const browser = which === 'webkit' ? await pkg.webkit.launch()
  : await pkg.chromium.launch({ channel: 'chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, hasTouch: true, isMobile: which !== 'webkit' ? true : undefined,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => { errs.push(e.message); console.log('PAGEERROR', e.message, (e.stack||'').split('\n').slice(0,4).join(' | ')); });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text().slice(0, 200)); });
const shot = async n => { await page.waitForTimeout(250); await page.screenshot({ path: `${OUT}/real-${n}.png` }); console.log('shot', n); };
const T = (f, a) => page.evaluate(f, a);

await page.goto(URL, { waitUntil: 'networkidle' });
const t0 = Date.now();
await page.click('#bDemo');
await page.waitForFunction(() => window.__test?.ready(), null, { timeout: 120000 });
console.log('real assets ready in', Date.now() - t0, 'ms');
console.log('assets', JSON.stringify(await T(() => window.__test.assets())));
console.log('render', JSON.stringify(await T(() => window.__test.info())));
await shot('demo-loaded');

// export must stay byte-identical when nothing was edited
console.log('identity', await T(async () => (await (await fetch('testdata/items.level.json')).text()) === window.__test.exportLines()));

// close-up of a textured house
const objs = await T(() => window.__test.objs());
const house = objs.find(o => o.name === 'house_1');
const hp = house.pos;
await T(([p]) => window.__test.setCam({ target: [p[0], p[1], p[2] + 2.5], dist: 19, yaw: -1.9, pitch: 0.32 }), [hp]);
await shot('closeup-house');
const tree = objs.find(o => o.name.startsWith('tree_'));
await T(([p]) => window.__test.setCam({ target: [p[0], p[1], p[2] + 3.5], dist: 16, yaw: -2.3, pitch: 0.25 }), [tree.pos]);
await shot('closeup-tree');

// tap the house: selects only, no menu
await T(([p]) => window.__test.setCam({ target: [p[0], p[1], p[2] + 2], dist: 30, yaw: -1.9, pitch: 0.55 }), [hp]);
await page.waitForTimeout(200);
let sp = await T(i => window.__test.screenOf(i), house.i);
console.log('house screen', sp, 'pick', await T(([x, y]) => window.__test.pick(x, y), sp));
await page.touchscreen.tap(sp[0], sp[1]);
await page.waitForTimeout(700);
let st = await T(() => ({ sel: window.__S.sel?.r.name, menu: window.__test.menuOpen(), handles: document.querySelectorAll('#handles .h3d').length }));
console.log('after tap', JSON.stringify(st));
if (st.sel !== 'house_1' || st.menu) console.log('FAIL tap should select without menu');
// second tap on the selected house: still no menu
await page.waitForTimeout(400);
await page.touchscreen.tap(sp[0], sp[1]);
await page.waitForTimeout(700);
console.log('after 2nd tap menu=', await T(() => window.__test.menuOpen()));
await T(() => { const d = document.getElementById('bCloseSheet'); if (d && !d.hidden) d.click(); });
await page.waitForTimeout(400);
await shot('selected-handles');

// long-press via CDP-less touch: dispatch pointer events (0.6 s hold)
async function longPress(x, y) {
  await T(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    const o = { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    window.__lp = () => el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
  }, [x, y]);
  await page.waitForTimeout(650);
  await T(() => window.__lp());
}
sp = await T(i => window.__test.screenOf(i), house.i);
await longPress(sp[0], sp[1]);
await page.waitForTimeout(300);
console.log('long-press menu=', await T(() => window.__test.menuOpen()), 'close btn=', await T(() => !!document.querySelector('#ctxmenu [data-close]')));
await shot('menu-open');
// ✕ closes
await page.locator('#ctxmenu [data-close]').tap();
await page.waitForTimeout(200);
console.log('after ✕ menu=', await T(() => window.__test.menuOpen()), 'sel=', await T(() => window.__S.sel?.r.name));
// outside tap closes and does not deselect
await longPress(sp[0], sp[1]); await page.waitForTimeout(200);
await page.touchscreen.tap(60, 600);
await page.waitForTimeout(500);
console.log('after outside tap menu=', await T(() => window.__test.menuOpen()), 'sel still=', await T(() => window.__S.sel?.r.name));
// Escape closes
await longPress(sp[0], sp[1]); await page.waitForTimeout(200);
await page.keyboard.press('Escape'); await page.waitForTimeout(150);
console.log('after Escape menu=', await T(() => window.__test.menuOpen()));
// drag start outside closes and orbits
await longPress(sp[0], sp[1]); await page.waitForTimeout(200);
const cam0 = await T(() => window.__test.cam().yaw);
await T(() => {
  const el = document.getElementById('cv'); const ev = (t, x, y) => el.dispatchEvent(new PointerEvent(t, { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: t === 'pointerup' ? 0 : 1 }));
  ev('pointerdown', 80, 700); for (let i = 1; i <= 10; i++) ev('pointermove', 80 + i * 12, 700); ev('pointerup', 200, 700);
});
await page.waitForTimeout(300);
console.log('after drag outside menu=', await T(() => window.__test.menuOpen()), 'orbited=', (await T(() => window.__test.cam().yaw)) !== cam0);
// choosing an item closes (copy settings)
await T(([p]) => window.__test.setCam({ target: [p[0], p[1], p[2] + 2], dist: 30, yaw: -1.9, pitch: 0.55 }), [hp]);
sp = await T(i => window.__test.screenOf(i), house.i);
await longPress(sp[0], sp[1]); console.log('menu for', await T(() => window.__test.menuOpen() && window.__S.sel?.r.name)); await page.waitForTimeout(200);
await page.locator('#ctxmenu [data-act="copy"]').tap(); await page.waitForTimeout(200);
console.log('after item menu=', await T(() => window.__test.menuOpen()), 'clipboard=', await T(() => !!window.__S.clipboard));

// drag the house with one finger: real mesh follows (instance matrix)
await T(() => window.__test.select(window.__test.objs().find(o => o.name === 'house_1').i));
sp = await T(i => window.__test.screenOf(i), house.i);
const before = (await T(() => window.__test.objs().find(o => o.name === 'house_1').pos));
await T(([x, y]) => {
  const el = document.getElementById('cv'); const ev = (t, x, y) => el.dispatchEvent(new PointerEvent(t, { pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: t === 'pointerup' ? 0 : 1 }));
  ev('pointerdown', x, y); for (let i = 1; i <= 12; i++) ev('pointermove', x + i * 5, y + i * 2); ev('pointerup', x + 60, y + 24);
}, sp);
await page.waitForTimeout(300);
const after = (await T(() => window.__test.objs().find(o => o.name === 'house_1').pos));
console.log('drag house', before.map(v => v.toFixed(2)), '->', after.map(v => v.toFixed(2)));
const inst = await T(() => { const o = window.__S.sel; const m = new (o.mesh.matrix.constructor)(); o.inst.batches[0].getMatrixAt(o.inst.i, m); return [m.elements[12], m.elements[13], o.r.position[0], o.r.position[1]]; });
console.log('instance follows', inst.map(v => v.toFixed(2)));
await shot('moved-house');
const diff = await T(async () => { const a = (await (await fetch('testdata/items.level.json')).text()).split('\n'), b = window.__test.exportLines().split('\n'); let c = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) c++; return c; });
console.log('changed lines after drag', diff);
// undo restores
await T(() => window.__test.undo()); await page.waitForTimeout(300);
console.log('identity after undo', await T(async () => (await (await fetch('testdata/items.level.json')).text()) === window.__test.exportLines()));

// fps estimate
const fps = await T(() => new Promise(res => { let n = 0; const t = performance.now(); const f = () => { window.__test.setCam({ yaw: window.__test.cam().yaw + 0.01 }); if (++n < 60) requestAnimationFrame(f); else res(60000 / (performance.now() - t)); }; requestAnimationFrame(f); }));
console.log('fps while orbiting', fps.toFixed(1));
console.log('errors', errs.length);
await browser.close();
