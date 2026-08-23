#!/usr/bin/env node
/* After the deletion: boots clean, the group is gone, the frame at the
   A/B cameras is the OFF frame, and what it cost is off the budget. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.WROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/wl7/after';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c)); rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); }
  catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 300000 });
await page.waitForTimeout(5000);
await mkdir(OUT, { recursive: true });
const info = await page.evaluate(() => {
  const c = window.WALLY.ctx, W = c.world;
  for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none';
  const w = c.wally?.root || c.wally?.group; if (w) w.visible = false;
  let want = null;
  window.__lock = (p, t) => { want = { p, t }; };
  const cam = c.camera;
  const tick = () => { if (want) { cam.position.set(...want.p); cam.lookAt(...want.t); cam.updateMatrixWorld(true); } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return {
    lipGroup: !!W.groundGroup.getObjectByName('terrain.lip'),
    lipGroupProp: 'lipGroup' in W.terrain,
    census: typeof W.terrain.lipGateCensus,
    dbgLip: typeof window.WALLY.debug.worldLip + '/' + typeof window.WALLY.debug.lipCam,
    stats: W.terrain.stats,
    perf: window.__WALLY_PERF__,
  };
});
console.log(JSON.stringify(info, null, 1));
const CAMS = [['run6a', [208.2, 57.9, -260.2], [210, -270]], ['run11', [172.7, 55.6, -201.8], [171, -192]], ['divingboard', [268.3, 61.2, -282.6], [276, -289]]];
for (const [label, eye, at] of CAMS) {
  const ty = await page.evaluate(([x, z]) => window.WALLY.ctx.world.heightAt(x, z), at);
  await page.evaluate(([p, t]) => window.__lock(p, t), [eye, [at[0], ty + 0.6, at[1]]]);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, `${label}-deleted.png`) });
}
console.log('errors: ' + (errs.length ? errs.join(' | ') : 'none'));
console.log('perf after: ' + JSON.stringify(await page.evaluate(() => window.__WALLY_PERF__)));
await browser.close(); server.close();
