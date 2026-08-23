#!/usr/bin/env node
/* VERIFY JUDGE #16 — the tier --floor never injects.
   floorTest()'s producer loop is `for (const t of ['low','med','ultra'])`
   and tierMipFloor() only READS QUALITY_TIERS and prints BLOCK_AT's
   stored string, so the `high` row is a citation of med's measurement,
   not a measurement of high. Same recipe, cold boot at high, guard off,
   one non-finite texel — measured here.
   node tools/_vj16/hightier.mjs <outdir> [tier...]                    */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(process.argv[2]);
const TIERS = process.argv.slice(3).length ? process.argv.slice(3) : ['high'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c)); rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b); }
  catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--hide-scrollbars', '--mute-audio'] });

const INJECT = `(() => {
  const c = WALLY.ctx, T = c.THREE, cam = c.camera;
  const d = 2.0;
  const vh = 2 * d * Math.tan(T.MathUtils.degToRad(cam.fov) * 0.5);
  const cssH = c.renderer.domElement.height / c.renderer.getPixelRatio();
  const side = vh * (6 / cssH);
  const m = new T.Mesh(new T.PlaneGeometry(side, side), new T.ShaderMaterial({
    uniforms: { uZero: { value: 0 } },
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
    fragmentShader: 'uniform float uZero; void main(){ gl_FragColor = vec4( 1.0 / uZero ); }',
    depthTest: false, depthWrite: false, fog: false, toneMapped: false,
  }));
  m.position.set(0, 0, -d); m.renderOrder = 9999; m.frustumCulled = false;
  cam.add(m);
  if (!cam.parent) c.scene.add(cam);
  return 1;
})()`;

for (const tier of TIERS) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro&quality=${tier}`, { waitUntil: 'load', timeout: 240000 });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 240000 });
  await page.waitForTimeout(9000);
  const applied = await page.evaluate(async (t) => {
    const m = await import('/src/core/contracts.js');
    return { name: WALLY.ctx.quality.name, mips: (m.QUALITY_TIERS[t] || {}).bloomMips,
      live: WALLY.ctx.quality.bloomMips };
  }, tier);
  const guard = await page.evaluate(() => (typeof WALLY.debug.finiteGuard === 'function' ? WALLY.debug.finiteGuard(false) : 'no-guard-hook'));
  // hide the HUD so nothing fuses with the block
  await page.evaluate(() => { document.querySelectorAll('#ui,.w-hud,#hud').forEach((e) => (e.style.visibility = 'hidden')); });
  await page.waitForTimeout(600);
  await page.evaluate(INJECT);
  await page.waitForTimeout(1200);
  const p = join(OUT, `nan-${tier}.png`);
  await page.screenshot({ path: p });
  console.log(`${tier}: quality.name=${applied.name} QUALITY_TIERS.bloomMips=${applied.mips} live=${applied.live} guard(false)=>${guard}  -> ${p}`);
  await page.close();
}
await browser.close(); server.close();
