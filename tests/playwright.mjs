import pkg from '/tmp/node_modules/playwright-core/index.js';
const { chromium, devices } = pkg;
import { mkdirSync } from 'fs';

const OUT = '/workspace/beam-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--disable-dev-shm-usage', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader-webgl', '--ignore-gpu-blocklist']
});
const iPhone = devices['iPhone 14 Pro Max'] || {};
const context = await browser.newContext({
  ...iPhone,
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('CONSERR', m.text()); });

await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/3d-intro.png` });

await page.click('#bDemo');
await page.waitForFunction(() => window.__S?.objs?.length >= 10 && document.getElementById('intro').style.display === 'none', { timeout: 30000 });
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/3d-loaded.png` });
const objs = await page.evaluate(() => window.__test.objs());
console.log('loaded', objs.length, objs.map(o => o.cls + ':' + o.name).join(', '));

const ident = await page.evaluate(async () => {
  const src = await (await fetch('testdata/items.level.json')).text();
  const out = window.__test.exportLines();
  return { ok: out === src, srcLen: src.length, outLen: out.length };
});
console.log('identity', JSON.stringify(ident));

// orbit
await page.mouse.move(215, 420);
await page.mouse.down();
await page.mouse.move(310, 470, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(350);
await page.screenshot({ path: `${OUT}/3d-orbit.png` });

// 2D
await page.evaluate(() => { window.__test.setMode('2d'); window.__test.fit(); });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/3d-topview.png` });

// drag crate in 2D
await page.evaluate(() => {
  window.__test.closeMenu();
  const i = window.__test.objs().find(o => o.name === 'crate_a').i;
  window.__test.select(i);
});
await page.waitForTimeout(200);
const before = await page.evaluate(() => window.__test.objs().find(o => o.name === 'crate_a').pos.slice());
const scr = await page.evaluate(() => window.__test.screenOf(window.__test.objs().find(o => o.name === 'crate_a').i));
console.log('crate 2d screen', scr, 'pos', before);
if (scr && scr[0] > 8 && scr[0] < 422 && scr[1] > 8 && scr[1] < 800) {
  await page.mouse.move(scr[0], scr[1]);
  await page.mouse.down();
  await page.mouse.move(scr[0] + 70, scr[1] - 50, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(400);
} else {
  console.log('SCREEN_OFF, skip pointer drag');
}
const after = await page.evaluate(() => window.__test.objs().find(o => o.name === 'crate_a').pos.slice());
console.log('moved', before, '->', after, 'delta', after[0]-before[0], after[1]-before[1]);
await page.screenshot({ path: `${OUT}/3d-moved.png` });

const afterEdit = await page.evaluate(async () => {
  const src = await (await fetch('testdata/items.level.json')).text();
  const out = window.__test.exportLines();
  const a = src.split('\n'), b = out.split('\n');
  let changed = 0, same = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) (a[i] === b[i] ? same++ : changed++);
  return { changed, same, crateLine: b.find(l => l.includes('"name":"crate_a"')), total: a.length };
});
console.log('afterEdit', JSON.stringify(afterEdit));

// back to 3d, screenshot each class with focus + handles
await page.evaluate(() => { window.__test.setMode('3d'); window.__test.closeMenu(); });
const classes = [...new Set(objs.map(o => o.cls))];
for (const cls of classes) {
  const o = objs.find(x => x.cls === cls);
  await page.evaluate(i => { window.__test.closeMenu(); window.__test.focus(i); }, o.i);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/3d-class-${cls}.png` });
  const info = await page.evaluate(() => ({
    handles: document.querySelectorAll('#handles .h3d').length,
    outline: document.getElementById('outline').getAttribute('points')?.length || 0,
    screen: window.__test.screenOf(window.__S.objs.indexOf(window.__S.sel))
  }));
  console.log('class', cls, o.name, info);
}

// menu + handles on crate_b
const crateB = objs.find(o => o.name === 'crate_b');
await page.evaluate(i => { window.__test.closeMenu(); window.__test.focus(i); }, crateB.i);
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/3d-handles.png` });
const hCount = await page.evaluate(() => document.querySelectorAll('#handles .h3d').length);
console.log('handles on crate_b', hCount);
await page.evaluate(i => window.__test.openMenu(i), crateB.i);
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/3d-menu.png` });
console.log('menu', await page.evaluate(() => window.__test.menuOpen()));

await page.evaluate(() => window.__test.closeMenu());
await page.evaluate(() => { window.__test.fit(); });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/3d-loaded.png` });

await browser.close();
console.log('DONE');
