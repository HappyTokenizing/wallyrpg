#!/usr/bin/env node
/* ============================================================
   _j22-file.mjs — THE DELIVERABLE, FROM file://, NOT FROM A SERVER.

   Every browser rig in this repo (tools/_sky-minute.mjs,
   tools/test-balloon.mjs's browserHalf, tools/shot.mjs) serves src/
   over 127.0.0.1 and loads index.html. NONE of them ever opens
   WALLY-RPG.html, and NONE of them uses the file:// scheme — which is
   the only way the deliverable is ever actually run. tools/build.mjs's
   own verify step does open it, but only on the bundle it just wrote,
   so a WALLY-RPG.html that is on disk without having been written by
   this tree is never opened by anything.

   So: open the file on disk, over file://, and board the balloon.

   usage: node tools/_j22-file.mjs [path-to.html]
   ============================================================ */
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, process.argv[2] || 'WALLY-RPG.html');
const s = await stat(FILE);
const src = await readFile(FILE, 'utf8');
console.log(`file: ${FILE}`);
console.log(`bytes: ${s.size}   utf16 length: ${src.length}   mtime: ${s.mtime.toISOString()}`);
console.log(`crossing rule table in the bundle:`);
{
  const m = src.match(/lerp:\{straight[^;]{0,800}/);
  console.log('  ' + (m ? m[0].slice(0, 460) : 'NOT FOUND'));
  for (const k of ['crossPace', 'haze:.135', 'white:.055', 'tail:.26', 'balloon.envelope'])
    console.log(`  ${k.padEnd(18)} ${src.includes(k) ? 'present' : 'ABSENT'}`);
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--mute-audio', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
page.on('requestfailed', r => errs.push('[net] ' + r.url().slice(0, 120) + ' ' + (r.failure()?.errorText || '')));

const t0 = Date.now();
await page.goto(pathToFileURL(FILE).href + '?shot=1', { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__ === true', null, { timeout: 150000 });
const loadS = (Date.now() - t0) / 1000;
console.log(`\nbooted from ${pathToFileURL(FILE).protocol}// in ${loadS.toFixed(1)}s`);
console.log('url scheme actually used: ' + await page.evaluate(() => location.protocol));

const info = await page.evaluate(() => ({
  gpu: (() => { const gl = WALLY.ctx.renderer.getContext(); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; })(),
  tier: WALLY.ctx.quality.name,
  debugKeys: Object.keys(WALLY.debug).filter(k => /balloon|ride|sky/i.test(k)),
  gameActions: Object.keys(WALLY.ctx.game?.actions || {}),
  hasSkyRule: typeof WALLY.debug.skyRule === 'function',
  skyRules: WALLY.debug.skyRules ? WALLY.debug.skyRules() : null,
}));
console.log(`GPU ${info.gpu}   tier ${info.tier}`);
console.log(`WALLY.debug (ride/balloon/sky): ${info.debugKeys.join(', ')}`);
console.log(`sky rules exposed by the bundle: ${info.skyRules ? info.skyRules.join(',') : 'no skyRule switch'}`);

/* the mooring: is there a balloon to board at all, and where */
const moored = await page.evaluate(() => {
  const out = { props: [], spot: null };
  try { out.spot = WALLY.ctx.game?.actions?.parkSpot?.('balloon') ?? null; } catch { }
  WALLY.ctx.scene.traverse(o => { if (/balloon/i.test(o.name)) out.props.push(o.name); });
  return { spot: out.spot, n: out.props.length, sample: [...new Set(out.props)].slice(0, 8) };
});
console.log(`\nmoored balloon in the scene: ${moored.n} named nodes, e.g. ${moored.sample.join(', ')}`);

/* BOARD IT. Not a teleport into the sky: board at the mooring, then
   fly, then read the flight back from balloonInfo() rather than from
   the arguments that were passed in. */
const flight = await page.evaluate(async () => {
  const sleep = () => new Promise(r => requestAnimationFrame(r));
  const before = { y: WALLY.ctx.wally.position.y, flying: !!WALLY.debug.balloonInfo?.().flying };
  const boarded = WALLY.debug.balloon({ alt: 6 });
  for (let i = 0; i < 60; i++) await sleep();
  const at6 = WALLY.debug.balloonInfo();
  WALLY.debug.balloonBurn?.(true);
  for (let i = 0; i < 180; i++) await sleep();
  const climbing = WALLY.debug.balloonInfo();
  WALLY.debug.balloonStick?.(0.6, 0);
  for (let i = 0; i < 180; i++) await sleep();
  const flying = WALLY.debug.balloonInfo();
  return { before, boarded: typeof boarded === 'object' ? Object.keys(boarded).slice(0, 6) : boarded,
    at6: { alt: at6.alt, flying: at6.flying, phase: at6.phase, inflate: at6.inflate },
    climbing: { alt: climbing.alt, phase: climbing.phase, inflate: climbing.inflate },
    flying: { alt: flying.alt, phase: flying.phase, speed: flying.speed, inflate: flying.inflate } };
});
console.log('\nBOARDING, driven through the bundle\'s own public debug surface:');
console.log('  before        ' + JSON.stringify(flight.before));
console.log('  at alt 6      ' + JSON.stringify(flight.at6));
console.log('  after burn    ' + JSON.stringify(flight.climbing));
console.log('  after stick   ' + JSON.stringify(flight.flying));

const shot = 'shots/_j22file.png';
await page.screenshot({ path: resolve(ROOT, shot) });
console.log(`\nframe written to ${shot}`);
console.log(errs.length ? `\nERRORS (${errs.length}):\n  ` + errs.slice(0, 12).join('\n  ') : '\nno page errors, no console errors, no failed requests');
await browser.close();
