/* paneltest.mjs — find which UI panel kills movement, and whether a
   reposition can drive the controller to NaN.

   playtest.mjs showed the player frozen for the rest of the session after
   P/M/O were opened, but movetest.mjs showed movement surviving P alone.
   So one specific panel is responsible. This tests each in isolation. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 90000 });
await page.waitForTimeout(3500);

const pos = () => page.evaluate(() => {
  const w = WALLY.ctx.wally;
  const p = w && w.root && w.root.position;
  const ok = p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  return { ok, x: ok ? +p.x.toFixed(2) : String(p && p.x), z: ok ? +p.z.toFixed(2) : String(p && p.z) };
});

async function walk(seconds = 3) {
  const a = await pos();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
  const b = await pos();
  if (!a.ok || !b.ok) return { moved: NaN, a, b };
  return { moved: +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2), a, b };
}

console.log('--- baseline ---');
console.log('  moved', (await walk()).moved, 'm');

for (const key of ['KeyP', 'KeyM', 'KeyO']) {
  await page.keyboard.press(key);
  await page.waitForTimeout(1200);
  const open = await page.evaluate(() => ({
    modal: !!document.querySelector('[data-modal],.modal,.panel.open,#phone.open'),
    activeEl: document.activeElement ? document.activeElement.tagName : null,
  }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  const r = await walk();
  console.log(`  after ${key} + Esc: moved ${r.moved} m   (modal seen: ${open.modal}, focus ${open.activeEl})`);
}

console.log('--- all three in sequence, as playtest does ---');
for (const k of ['KeyP', 'Escape', 'KeyM', 'Escape', 'KeyO', 'Escape']) {
  await page.keyboard.press(k);
  await page.waitForTimeout(800);
}
console.log('  moved', (await walk(4)).moved, 'm');

console.log('--- NaN probe: reposition high above terrain ---');
await page.evaluate(() => {
  const w = WALLY.ctx.wally, c = w.controller;
  if (c && c.teleport) c.teleport(40, 60, 40);
  else w.root.position.set(40, 60, 40);
});
await page.waitForTimeout(2500);
const p2 = await pos();
console.log('  position finite after reposition:', p2.ok, JSON.stringify(p2));
const r2 = await walk();
console.log('  moved after reposition:', r2.moved, 'm');

console.log('\nPAGE ERRORS:', errs.length);
for (const e of [...new Set(errs)].slice(0, 6)) console.log('  -', e.slice(0, 150));

await browser.close();
server.close();
