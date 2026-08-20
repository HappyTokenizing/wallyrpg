/* movetest.mjs — isolate why the player stops moving.
   Four conditions, same held-W input each time:
     A pure movement from spawn, UI never touched
     B after opening and closing the phone panel
     C after clicking the canvas to restore focus
     D after teleporting to open ground (rules out being wedged in geometry)  */
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

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message.split('\n')[0]));

await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 60000 });
await page.waitForTimeout(3000);

const probe = () => page.evaluate(() => {
  const w = WALLY.ctx.wally;
  const c = w && w.controller;
  const v = c && (c.velocity || c.vel);
  return {
    pos: w ? [+w.root.position.x.toFixed(2), +w.root.position.y.toFixed(2), +w.root.position.z.toFixed(2)] : null,
    speed: v ? +Math.hypot(v.x, v.z).toFixed(2) : null,
    grounded: c ? (c.grounded ?? c.onGround ?? null) : null,
    ctrlKeys: Object.keys(c || {}).slice(0, 14),
    docFocus: document.activeElement ? document.activeElement.tagName + (document.activeElement.id ? '#' + document.activeElement.id : '') : null,
  };
});

const dist = (a, b) => Math.hypot(b[0] - a[0], b[2] - a[2]).toFixed(2);

async function walk(label, seconds = 8) {
  const a = await probe();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up('KeyW');
  const b = await probe();
  console.log(` ${label}`);
  console.log(`   start ${JSON.stringify(a.pos)}  end ${JSON.stringify(b.pos)}  moved ${dist(a.pos, b.pos)} m`);
  console.log(`   speed ${b.speed}  grounded ${b.grounded}  focus ${b.docFocus}`);
  return +dist(a.pos, b.pos);
}

console.log('--- A: pure W, UI never touched ---');
const A = await walk('A');

console.log('--- B: open phone (P), close (Esc), then W ---');
await page.keyboard.press('KeyP');
await page.waitForTimeout(1200);
console.log('   focus with panel open:', (await probe()).docFocus);
await page.keyboard.press('Escape');
await page.waitForTimeout(1200);
console.log('   focus after Esc:', (await probe()).docFocus);
const B = await walk('B');

console.log('--- C: click canvas to restore focus, then W ---');
await page.mouse.click(700, 400);
await page.waitForTimeout(600);
const C = await walk('C');

console.log('--- D: teleport to open ground, then W ---');
await page.evaluate(() => {
  const w = WALLY.ctx.wally, c = w.controller;
  if (c && c.teleport) c.teleport(40, 60, 40);
  else w.root.position.set(40, 60, 40);
});
await page.waitForTimeout(2000);
const D = await walk('D');

console.log('\nSUMMARY  A=' + A + 'm  B=' + B + 'm  C=' + C + 'm  D=' + D + 'm');
console.log(await probe().then(p => 'controller fields: ' + p.ctrlKeys.join(', ')));

await browser.close();
server.close();
