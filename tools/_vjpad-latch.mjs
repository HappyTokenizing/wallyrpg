/* _vjpad-latch.mjs — WHICH KEY IS LATCHED, and does a keyUp clear it?
   The previous judge's X4-pre reports wally.keyboardInput() reading a unit
   vector with nothing pressed, AFTER flushKeys() ran. keyboardInput is
   camera-relative and returns early on (0,0), so a non-zero read is proof a
   key is latched. This finds which one and whether CDP can release it. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
console.log('LOAD ' + execSync('uptime').toString().trim());
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message.split('\n')[0]));
page.on('console', m => { if (m.type()==='error') console.log('CONSOLE-ERR', m.text().slice(0,200)); });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 420000 });
await page.waitForTimeout(3500);
const cdp = await ctx.newCDPSession(page);
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.hideUI(false); });
await page.waitForTimeout(600);

/* Instrument the REAL listeners: log every key event the page receives, so
   we can see whether a keydown is being synthesised by the page itself. */
await page.evaluate(() => {
  window.__K = [];
  addEventListener('keydown', (e) => window.__K.push(['down', e.code, e.isTrusted]), true);
  addEventListener('keyup', (e) => window.__K.push(['up', e.code, e.isTrusted]), true);
});
const kb = () => page.evaluate(() => { const o = WALLY.ctx.wally.keyboardInput({}); return { x: +o.x.toFixed(2), z: +o.z.toFixed(2), jump: o.jump, run: o.run }; });
const VK = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, ShiftLeft: 16, ShiftRight: 16 };
const up = (code) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code, windowsVirtualKeyCode: VK[code], nativeVirtualKeyCode: VK[code] });

console.log('\n1. at boot, nothing touched:', JSON.stringify(await kb()));
console.log('   key events the page saw:', JSON.stringify(await page.evaluate(() => window.__K)));

/* Walk him with a real key so there IS a latch, then try to clear it. */
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
await page.waitForTimeout(400);
console.log('2. with KeyW genuinely held:', JSON.stringify(await kb()));
await up('KeyW');
await page.waitForTimeout(300);
console.log('3. after a CDP keyUp for KeyW:', JSON.stringify(await kb()), '<- if this is 0,0 then CDP CAN clear a latch');

/* Now reproduce the judge's fixture: arrive at a door, warp, settle. */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.arrive('apartment', true); });
await page.waitForTimeout(3000);
await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
await page.waitForTimeout(1200);
console.log('4. after arrive("apartment"):', JSON.stringify(await kb()));
console.log('   key events since boot:', JSON.stringify(await page.evaluate(() => window.__K)));

/* Which key, if any? Release them one at a time and watch the read. */
for (const c of Object.keys(VK)) {
  const before = await kb();
  if (!before.x && !before.z && !before.jump && !before.run) { console.log('   read is already zero before ' + c); break; }
  await up(c);
  await page.waitForTimeout(120);
  const after = await kb();
  if (JSON.stringify(before) !== JSON.stringify(after)) console.log(`   releasing ${c} CHANGED the read: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
}
console.log('5. after releasing every movement key:', JSON.stringify(await kb()));

/* Is he actually moving, and is it the controller or the input? */
const st = await page.evaluate(() => ({
  v: { x: +WALLY.ctx.wally.controller.velocity.x.toFixed(2), z: +WALLY.ctx.wally.controller.velocity.z.toFixed(2) },
  stick: +(WALLY.debug.touchState().t ?? 0),
  idle: WALLY.debug.idle(),
}));
console.log('6. controller/stick/idle:', JSON.stringify(st));
const p0 = await page.evaluate(() => ({ x: +WALLY.ctx.wally.position.x.toFixed(2), z: +WALLY.ctx.wally.position.z.toFixed(2) }));
await page.waitForTimeout(1500);
const p1 = await page.evaluate(() => ({ x: +WALLY.ctx.wally.position.x.toFixed(2), z: +WALLY.ctx.wally.position.z.toFixed(2) }));
console.log('7. drift with everything released:', JSON.stringify({ p0, p1, d: +Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2) }));
console.log('   final key log:', JSON.stringify(await page.evaluate(() => window.__K)));
console.log('LOAD ' + execSync('uptime').toString().trim());
await browser.close(); server.close();
