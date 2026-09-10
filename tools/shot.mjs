#!/usr/bin/env node
/* ============================================================
   shot.mjs — headless screenshot harness for WALLY RPG.

   Boots a static server on a random free port, loads the game in
   headless Chrome with real WebGL2, waits for the renderer to
   signal readiness, optionally runs a scripted camera/state setup,
   and writes a PNG.

   Usage:
     node tools/shot.mjs out.png
     node tools/shot.mjs out.png --wait 4000
     node tools/shot.mjs out.png --scene city --w 1920 --h 1080
     node tools/shot.mjs out.png --eval "WALLY.debug.pose('welcome')"
     node tools/shot.mjs out.png --url ref/original-wally.html --wait 9000
     node tools/shot.mjs out.png --seq 0,2,4 --prefix shots/intro

   Flags:
     --w, --h      viewport size            (default 1600x900)
     --wait ms     extra settle time        (default 2500)
     --scene name  passes ?scene=name
     --url path    load something else (relative to project root)
     --eval js     run in page before the shot (after ready)
     --console     print browser console + page errors
     --dpr n       device pixel ratio       (default 1)
     --ready ms    how long to wait for __WALLY_READY__ (default 30000).
                   MISSING IT IS FATAL on index.html — see the block at
                   the wait itself. Raise it on a loaded box.
     --allow-unready  shoot anyway if the flag never arrives
     --becalm      hold the wind at ZERO for the shot (wind.pin(0))
     --wind n      hold the wind at n instead   (e.g. --wind 0.42)

   TWO CAPTURES OF THE SAME FRAME WERE NEVER THE SAME FRAME.
   Every blade, banner, awning and ear in this world is driven by
   wind.js's gust machine, which is running the whole time the harness
   waits, so a before/after pair taken an hour apart differed by
   whatever gust happened to be blowing — and `setStrength(0)` did not
   help, because weather.js damps the base back to nominal EVERY FRAME
   and never touches the gust term at all (see THE PIN in
   src/core/wind.js). `--becalm` uses the real pin: it holds both
   terms and the bearing, so the foliage in two captures is in the
   same place. It runs AFTER --eval, so it wins over any wind an eval
   set; pick the held value with --wind if you want air in the frame.
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';

/* NOTE: do NOT add --disable-frame-rate-limit to the Chrome args below.
   It starves page.screenshot() and every capture times out. Learned
   the hard way; the symptom is 'waiting for fonts to load' then a
   30s timeout with no other clue. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.glsl': 'text/plain', '.wasm': 'application/wasm',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }

const out = process.argv[2];
if (!out || out.startsWith('--')) {
  console.error('usage: node tools/shot.mjs <out.png> [flags]');
  process.exit(1);
}

const W = +arg('w', 1600), H = +arg('h', 900);
const WAIT = +arg('wait', 2500);
const DPR = +arg('dpr', 1);
const SCENE = arg('scene', null);
const URLPATH = arg('url', 'index.html');
const EVAL = arg('eval', null);
const BECALM = flag('becalm');
const WINDAT = arg('wind', null);
const READY = +arg('ready', 30000);
const ALLOW_UNREADY = flag('allow-unready');

/* ---------- static server ---------- */
const server = createServer(async (req, res) => {
  try {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, clean === '/' ? 'index.html' : clean);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

/* ---------- browser ---------- */
const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--mute-audio',
  ],
});

const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: DPR,
});

const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}\n${e.stack || ''}`));
page.on('requestfailed', r => {
  if (!/favicon\.ico/.test(r.url())) logs.push(`[404] ${r.url()}`);
});
page.on('response', r => {
  if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) {
    logs.push(`[${r.status()}] ${r.url()}`);
  }
});

const qs = SCENE ? `?scene=${encodeURIComponent(SCENE)}&shot=1` : '?shot=1';
const url = `http://127.0.0.1:${PORT}/${URLPATH}${URLPATH.includes('?') ? '' : qs}`;

let failed = null;
try {
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });

  // Wait for the game to declare itself ready (main.js sets window.__WALLY_READY__).
  // Reference/legacy pages never set it, so fall back to the plain wait.
  /* THE SECOND ARGUMENT IS `arg`, NOT `options`. `waitForFunction(fn,
     null, {timeout})` passes the options object as the polyfill's argument
     and silently uses the DEFAULT 30 s, so raising the number here has
     no effect at all until the null goes in. It bit this probe on a
     loaded box; the value below is now the one that applies. */
  /* A RIG THAT CANNOT REACH ITS SUBJECT MUST DIE, NOT SHRUG.
     This used to swallow the timeout into a `[warn]` line — and
     `[warn]` is not in the `errs` filter at the bottom of this file, so
     a run that never saw __WALLY_READY__ screenshotted whatever was on
     screen at 30 s and EXITED ZERO. The caller got a PNG of a
     half-streamed world (no crowns, no props, terrain still paging)
     that is indistinguishable from a real capture in every way except
     the console it did not print. Not hypothetical: this box has run
     at 1-minute load 20 to 298 today, and at 298 a cold boot of this
     game does not finish inside 30 s.

     So the wait is now `--ready ms` (default 30000 — raise it on a
     loaded box) and missing it is FATAL. Reference and legacy pages
     genuinely never set the flag (the header's `--url
     ref/original-wally.html` case), so the requirement applies only
     when we actually loaded the game; `--allow-unready` waives it. */
  const isGame = /(^|\/)index\.html$/.test(URLPATH.split('?')[0]);
  await page.waitForFunction('window.__WALLY_READY__ === true', null, { timeout: READY })
    .catch(() => {
      const msg = `__WALLY_READY__ never set within ${READY} ms (1-min load ${loadavg()[0].toFixed(2)})`;
      if (isGame && !ALLOW_UNREADY) {
        throw new Error(`${msg} — REFUSING to screenshot a half-built world. ` +
          `Raise it with --ready <ms>, or pass --allow-unready to shoot anyway.`);
      }
      logs.push(`[warn] ${msg} — falling back to timed wait`);
    });

  if (EVAL) {
    const r = await page.evaluate(EVAL).catch(e => `[EVAL ERROR] ${e.message}`);
    if (r !== undefined && r !== null) logs.push(`[eval] ${JSON.stringify(r)}`);
  }

  /* Hold the air. See the header. Reported unconditionally when asked
     for, including the refusal on a build without the pin, so a shot
     can never silently be taken in moving air it claimed to becalm. */
  if (BECALM || WINDAT !== null) {
    const held = await page.evaluate((s) => {
      const w = window.WALLY?.ctx?.wind;
      if (!w || typeof w.pin !== 'function') return 'NO wind.pin ON THIS BUILD — shot taken in moving air';
      return w.pin(s === null ? 0 : +s);
    }, WINDAT).catch(e => `PIN FAILED: ${e.message}`);
    logs.push(`[wind] ${JSON.stringify(held)}`);
  }

  await page.waitForTimeout(WAIT);

  // Force a few animation frames so any post-eval state is rendered.
  await page.evaluate(() => new Promise(r => {
    let n = 0;
    const tick = () => (++n > 6 ? r() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  })).catch(() => {});

  await mkdir(dirname(resolve(ROOT, out)), { recursive: true }).catch(() => {});
  await page.screenshot({ path: resolve(ROOT, out), animations: 'allow', timeout: 20000 });

  // Report perf + any GL errors so agents can see them without a second run.
  /* THE PIXEL COUNT GOES WITH THE NUMBER, ALWAYS (contracts.js rule 4:
     "state the rig beside the number"). This block used to print
     fps/cpuMs/calls/tris with nothing saying how big the frame was, so a
     run at --dpr 2 and a run at the default --dpr 1 produced perf lines
     that look identical in a report for frames with FOUR TIMES the
     pixels between them. Report the CSS viewport, the requested dpr, the
     ratio three.js is actually rendering at (setPixelRatio and the
     quality tier may both clamp it), the drawing buffer in real pixels,
     and the product — the only figure a fill-rate claim may be divided
     by. Printed unconditionally, next to [perf], both to stdout. */
  const rig = await page.evaluate(() => {
    const r = window.WALLY?.ctx?.renderer;
    if (!r) return null;
    const d = r.domElement;
    return { pr: +r.getPixelRatio().toFixed(3), bw: d.width, bh: d.height,
             q: window.WALLY?.ctx?.quality?.name ?? null };
  }).catch(() => null);
  const px = rig ? rig.bw * rig.bh : W * DPR * H * DPR;
  logs.push(`[rig] ${W}x${H} css, dpr ${DPR}` +
            `${rig && rig.pr !== DPR ? ` (renderer ${rig.pr})` : ''}` +
            `, buffer ${rig ? `${rig.bw}x${rig.bh}` : `${W * DPR}x${H * DPR}`}` +
            ` = ${(px / 1e6).toFixed(2)} Mpx${rig?.q ? `, quality ${rig.q}` : ''}`);
  /* RULE 4: STATE THE RIG BESIDE THE NUMBER — and the box load is part
     of the rig for anything measured in milliseconds. This line carried
     fps and cpuMs with nothing saying what else the machine was doing,
     and the 1-minute load here has been seen at 20 and at 298 inside one
     hour. Above 10, every millisecond in it is noise and the line says
     so rather than leaving the reader to know. */
  const perf = await page.evaluate(() => window.__WALLY_PERF__ || null).catch(() => null);
  if (perf) {
    const L = loadavg()[0];
    logs.push(`[perf] ${JSON.stringify(perf)}  load ${L.toFixed(2)}` +
              `${L > 10 ? '  <- DISCARD every ms above: load > 10' : ''}`);
  }
} catch (e) {
  failed = e;
  logs.push(`[FATAL] ${e.message}`);
}

await browser.close();
server.close();

const errs = logs.filter(l =>
  /PAGEERROR|FATAL|\[error\]|\[404\]|EVAL ERROR/.test(l) &&
  !/favicon|status of 404/.test(l)
);
if (flag('console') || errs.length) {
  console.log(logs.join('\n'));
} else {
  console.log(`wrote ${out}  (${W}x${H})`);
  const rigLine = logs.find(l => l.startsWith('[rig]'));
  if (rigLine) console.log(rigLine);
  const windLine = logs.find(l => l.startsWith('[wind]'));
  if (windLine) console.log(windLine);
  const perf = logs.find(l => l.startsWith('[perf]'));
  if (perf) console.log(perf);
}
process.exit(failed || errs.length ? 1 : 0);
