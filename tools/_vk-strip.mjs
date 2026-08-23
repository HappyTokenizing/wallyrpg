/* _vk-strip.mjs — side-view frames across the pedal stroke at each rung
   of the bicycle ladder, assembled into one contact sheet per rung, plus
   the intro's bicycle shot. node tools/_vk-strip.mjs <outdir> */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || '/tmp/vkstrip';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
await mkdir(OUT, { recursive: true });
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('PAGEERROR ' + e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);

const CLIP = { x: 175, y: 90, width: 550, height: 470 };
const sheets = {};
for (const [name, spd] of [['coast', 0.9], ['ride-bicycle', 3.4], ['sprint', 8.2]]) {
  await page.evaluate(([s]) => window.WALLY.debug.ride('bike', s, 'bikeSide'), [spd]);
  await page.waitForTimeout(2200);
  const shots = [];
  for (let i = 0; i < 6; i++) {
    const ph = i / 6;
    await page.evaluate((p) => window.WALLY.debug.locoStep(p, 10), ph);
    await page.waitForTimeout(420);
    const buf = await page.screenshot({ clip: CLIP });
    shots.push(buf.toString('base64'));
  }
  sheets[name] = shots;
  const info = await page.evaluate(() => window.WALLY.debug.rideInfo && window.WALLY.debug.rideInfo());
  console.error(name + ' rideInfo ' + JSON.stringify(info).slice(0, 400));
}
await page.evaluate(() => window.WALLY.debug.locoPhase(null));

/* the intro's own bicycle shot, via the director's own seek */
const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await p2.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 180000 });
await p2.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await p2.waitForTimeout(2000);
const marks = await p2.evaluate(() => (window.WALLY.debug.introMarks ? window.WALLY.debug.introMarks() : null));
console.error('MARKS ' + JSON.stringify(marks));
const introShots = [];
for (let n = 0; n < (marks ? marks.length : 0); n++) {
  await p2.evaluate((i) => window.WALLY.debug.introShot(i), n);
  await p2.waitForTimeout(1700);
  const st = await p2.evaluate(() => {
    const c = window.WALLY.ctx;
    const a = c.wally.animator;
    return { clip: a && a.action ? a.action.name : null, loco: a ? a.locoName : null };
  });
  if (st.clip === 'ride-bicycle') {
    introShots.push((await p2.screenshot()).toString('base64'));
    console.error('intro mark ' + n + ' is the bicycle: ' + JSON.stringify(st) + ' | ' + (marks[n] || ''));
    await p2.waitForTimeout(1400);
    introShots.push((await p2.screenshot()).toString('base64'));
    if (introShots.length >= 4) break;
  }
}
console.error('intro frames captured: ' + introShots.length);

/* contact sheets, built in the browser and screenshotted */
const sheet = await browser.newPage({ viewport: { width: 1460, height: 560 } });
for (const [name, shots] of Object.entries(sheets)) {
  const html = `<body style="margin:0;background:#111;display:flex;flex-wrap:wrap;">
    ${shots.map((b, i) => `<div style="position:relative"><img src="data:image/png;base64,${b}" style="width:480px;display:block">
    <div style="position:absolute;left:6px;top:4px;color:#ffb;font:16px monospace">ph ${(i / 6).toFixed(2)}</div></div>`).join('')}</body>`;
  await sheet.setContent(html);
  await sheet.waitForTimeout(400);
  await sheet.screenshot({ path: join(OUT, `sheet-${name}.png`), fullPage: true });
}
if (introShots.length) {
  await sheet.setContent(`<body style="margin:0;background:#111">${introShots.map((b) => `<img src="data:image/png;base64,${b}" style="width:1440px;display:block">`).join('')}</body>`);
  await sheet.waitForTimeout(400);
  await sheet.screenshot({ path: join(OUT, 'sheet-intro.png'), fullPage: true });
}
console.error('wrote ' + OUT);
await browser.close();
server.close();
