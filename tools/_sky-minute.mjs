#!/usr/bin/env node
/* ============================================================
   _sky-minute.mjs — the sky measured at ONE MINUTE.

   WHY THIS EXISTS AND WHY THE TEN-MINUTE RIG DID NOT DO.
   tools/_sky-table.mjs samples an hour list. Every defect this file
   has been used to find was invisible to it, and then invisible to
   the ten-minute grid that replaced it, because the crossing's
   colourless window is four minutes wide and a grid is a sampling
   (contracts.js, "HOW THIS PROJECT PROVES A FIX", rule 3). The clock
   runs at half an in-game minute per real second, so one in-game
   minute is two real seconds of sky — short, and exactly the kind of
   thing a player notices once and cannot un-see.

   So: minutes, not hours, and a range rather than a list.

   THE REVERT CHECK IS TWO DIFFERENT THINGS AND THEY ARE NOT
   INTERCHANGEABLE (rule 1):

     --rules lerp,prev,ship   drives lighting.js's own switch,
        WALLY.debug.skyRule(). All three rules run on ONE page load,
        against one build, one GPU, one grade. This isolates the
        crossing repair: `lerp` is this build with deMud and crossFade
        removed, `prev` is the rule the judge accepted, `ship` is what
        is shipping.

     --swap-head   is the other direction, and it is the one that is
        easy to get backwards. It puts HEAD's src/world/lighting.js
        into the tree, runs TODAY'S measurement against YESTERDAY'S
        code, and puts the file back. HEAD's update() has no
        opposition term in the band blend at all, so `--rules lerp` is
        NOT a HEAD baseline and this rig will not let you call it one.
        The swap is restored in a finally block; if the process is
        killed mid-run, `git checkout src/world/lighting.js` — the
        backup is written to /tmp first and its path is printed.

   WHAT IS MEASURED, over the sky region only, on the FINAL composited
   frame (ACES + grade + bloom + vignette + grain, because that is
   what a player sees):

     sat     HSV saturation of the mean sky colour, gamma space. The
             "is it a colour or a wash" number ART_DIRECTION §2.1
             cares about, and the number the notch was found in.
     mean    the mean sky colour
     gSmall  % of sky pixels whose GREEN is the smallest channel —
             the magenta tell
     grad    sum |top row - row above the horizon| over rgb, out of
             765: a sky against a lid

   The horizon row is PROJECTED from the live camera every shot.

   AND THE FOURTH ROUND'S DEFECT WAS NOT A COLOUR AT ALL, SO THIS RIG
   NOW MEASURES A SPEED AS WELL.

   Round 4 cleared every colour column in this table and shipped a sky
   the player watches ANIMATE: the crossing moved the horizon 62.7 sRGB
   codes per REAL second. Nothing above can see that, because every
   number above is a property of ONE frame and a rate is a property of
   two. A grid of still frames is a sampling in exactly the sense of
   contracts.js rule 3, and "which minute is this colour" is not the
   only question a time-of-day system can get wrong.

   Two rate figures, and they are not interchangeable:

     --analytic   NO BROWSER. Imports sampleTOD/setSkyRule from
        src/world/lighting.js and walks the clock at 0.05 in-game
        minutes over all 1440. Deterministic and repeatable to the
        bit, so it can compare rules at a resolution no screenshot rig
        can reach, and it is the only figure that is free of the cloud
        drift documented below. It measures the TABLE's horizon and
        fog, which is where the crossing lives; it cannot see the band
        blend, the boost or the tone map.

     the `d/s` column in the rendered table is the same quantity taken
        off the FINAL COMPOSITED FRAME between adjacent sampled
        minutes of the same rule and mode. It sees everything the
        player sees and it carries the cloud drift as noise — run
        --repeat and compare against the drift row before believing a
        difference smaller than about 2.

   The clock runs at half an in-game minute per real second, so one
   in-game minute is TWO real seconds and every rate here is
   |dRGB| / (2 * dMinutes), in 8-bit sRGB codes per real second.

   usage:
     node tools/_sky-minute.mjs --from 7:30 --to 7:48 \
          --rules lerp,prev,warp,ship --modes anti,sun --json /tmp/m.json
     node tools/_sky-minute.mjs --analytic --rules lerp,prev,warp,ship
     node tools/_sky-minute.mjs --analytic --from 7:30 --to 7:50
     node tools/_sky-minute.mjs --from 17:16 --to 17:22 \
          --weather clear,cloudy,rain,storm --rules prev,warp,ship
     node tools/_sky-minute.mjs --from 7:30 --to 7:48 --swap-head
     node tools/_sky-minute.mjs --from 7:36 --to 7:42 --out shots/_min
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIGHTING = join(ROOT, 'src/world/lighting.js');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
};
function arg(n, f) { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : f; }
const has = (n) => process.argv.includes(`--${n}`);
const mins = (s) => { const [h, m] = String(s).split(':'); return (+h) * 60 + (+(m ?? 0)); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const W = +arg('w', 960), H = +arg('h', 540);
/* --from/--to may be repeated: two windows in one run, one page load */
const WINDOWS = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--from') WINDOWS.push([mins(process.argv[i + 1]), null]);
  if (process.argv[i] === '--to' && WINDOWS.length) WINDOWS[WINDOWS.length - 1][1] = mins(process.argv[i + 1]);
}
if (!WINDOWS.length) WINDOWS.push([mins('7:30'), mins('7:48')]);
const MINUTES = [];
for (const [a, b] of WINDOWS) for (let m = a; m <= (b ?? a); m++) MINUTES.push(m);

/* ---- --analytic: the deterministic rate rig. No browser, no drift.
   contracts.js rule 4 still applies — this one runs on the CPU, so
   the rig is node + the checked-out src/world/lighting.js and nothing
   else, and it is identical on every machine. ---- */
if (has('analytic')) {
  const { sampleTOD: STOD, setSkyRule: SRULE, skyRuleNames, setSkyDrain } =
    await import('../src/world/lighting.js');
  const THREE = await import('../vendor/three.module.js');
  /* THE RATE COLUMN WAS CLEAR-ONLY TOO, and round 6 makes the crossing
     path a function of the weather, so the speed is now one number per
     weather. --weather here sets the SAME drain update() computes from
     the same preset, so the analytic figure and the rendered one are
     talking about the same sky. Unknown names are fatal, as above. */
  const { WEATHER: WXT } = await import('../src/world/weather.js');
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const drainOf = (n) => {
    const w = WXT[n];
    if (!w) { console.error(`unknown weather ${n} — weather.js authors ${Object.keys(WXT).join(', ')}`); process.exit(2); }
    return Math.min(1, Math.max(0, (ss(0.34, 1.0, w.cloud) * 0.42 + w.storm * 0.34 - 0.03) / 0.45));
  };
  const AWX = arg('weather', arg('weathers', 'clear')).split(',').map(x => x.trim()).filter(Boolean);
  const mk = () => ({ sun: new THREE.Color(), amb: new THREE.Color(), sky: new THREE.Color(),
    horizon: new THREE.Color(), fog: new THREE.Color(), sunEl: 0, exposure: 0 });
  const A = mk(), B = mk();
  const g8 = (v) => 255 * Math.pow(Math.max(v, 0), 0.45455);
  const f8 = (c) => [g8(c.r), g8(c.g), g8(c.b)];
  const hexOf = (c) => '#' + f8(c).map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const chromaOf = (c) => { const [r, g, b] = f8(c); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx > 1e-4 ? (mx - mn) / mx : 0; };
  const valOf = (c) => Math.max(...f8(c)) / 255;
  const hueOf = (c) => { const [r, g, b] = f8(c); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 1e-6) return -1; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return Math.round(((h * 60) % 360 + 360) % 360); };
  const ST = 0.05, SECS = ST * 2;              /* half an in-game minute per real second */
  const rateOf = (x, y) => { const p = f8(x), q = f8(y); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / SECS; };
  const names = arg('rules', skyRuleNames().join(',')).split(',');
  console.log(`rig: node ${process.version} on the CPU, src/world/lighting.js as checked out; ` +
    `sampleTOD only — no renderer, no tone map, no cloud drift`);
  console.log('rule   wx      drain  worst horizon        worst fog           pale minutes  (horizon chroma < 0.15)');
  for (const rule of names) {
    for (const wxn of AWX) {
      const dr = drainOf(wxn);
      SRULE(rule);
      let w = { r: 0, m: 0 }, wf = { r: 0, m: 0 }, pale = 0;
      for (let m = 0; m < 1440; m += ST) {
        setSkyDrain?.(dr); STOD(m / 60, A); setSkyDrain?.(dr); STOD((m + ST) / 60, B);
        const r = rateOf(A.horizon, B.horizon), rf = rateOf(A.fog, B.fog);
        if (r > w.r) w = { r, m }; if (rf > wf.r) wf = { r: rf, m };
      }
      for (let m = 0; m < 1440; m++) { setSkyDrain?.(dr); STOD(m / 60, A); if (chromaOf(A.horizon) < 0.15) pale++; }
      console.log(`${rule.padEnd(6)} ${wxn.padEnd(7)} ${dr.toFixed(2)}   ${w.r.toFixed(1).padStart(5)} codes/real-s @${hhmm(Math.floor(w.m))}  ` +
        `${wf.r.toFixed(1).padStart(5)} codes/real-s @${hhmm(Math.floor(wf.m))}  ${String(pale).padStart(5)}`);
    }
  }
  setSkyDrain?.(0);
  if (process.argv.includes('--from')) {
    for (const rule of names) {
      SRULE(rule);
      console.log(`\n== ${rule} ==\n time   horizon  chroma  V     hue   d/s  | fog      chroma  V     hue   d/s`);
      for (const m of MINUTES) {
        STOD(m / 60, A); STOD((m + ST) / 60, B);
        console.log(`${hhmm(m)}  ${hexOf(A.horizon)} ${chromaOf(A.horizon).toFixed(3)}  ${valOf(A.horizon).toFixed(2)}  ` +
          `${String(hueOf(A.horizon)).padStart(4)} ${rateOf(A.horizon, B.horizon).toFixed(1).padStart(5)} | ` +
          `${hexOf(A.fog)} ${chromaOf(A.fog).toFixed(3)}  ${valOf(A.fog).toFixed(2)}  ` +
          `${String(hueOf(A.fog)).padStart(4)} ${rateOf(A.fog, B.fog).toFixed(1).padStart(5)}`);
      }
    }
  }
  process.exit(0);
}

const SWAP = has('swap-head');
const RULES = SWAP ? ['head'] : arg('rules', 'ship').split(',');
/* MODES: `anti` and `sun` are RELATIVE to the sun's own azimuth, which
   is what the crossing work has always been judged on. `--bearings N`
   adds N ABSOLUTE compass bearings (`b0`, `b22.5`, ...), because a
   defect that is a function of the angle between the view and the sun
   has no reason to land on the two bearings this rig happens to pick —
   contracts.js rule 3. az=0 in the morning had never been sampled. */
const MODES = arg('modes', 'anti').split(',');
{
  const nb = +arg('bearings', 0);
  for (let i = 0; i < nb; i++) MODES.push(`b${+(i * 360 / nb).toFixed(1)}`);
}
/* weather.js authors exactly these four. See the block in the page-load
   section below for why this list is validated on the page rather than
   trusted here. */
const WEATHERS = arg('weather', arg('weathers', 'clear')).split(',').map(s => s.trim()).filter(Boolean);
const OUTPNG = arg('out', null);
const JSONOUT = arg('json', null);

/* ---- THE REVERT SWAP. Backup first, restore in finally. ---- */
let backup = null;
if (SWAP) {
  backup = join(tmpdir(), `lighting.worktree.${process.pid}.js`);
  await copyFile(LIGHTING, backup);
  console.log(`# working-tree lighting.js backed up to ${backup}`);
  const head = execFileSync('git', ['show', 'HEAD:src/world/lighting.js'], { cwd: ROOT, maxBuffer: 1 << 26 });
  await writeFile(LIGHTING, head);
  console.log('# HEAD src/world/lighting.js swapped in — TODAY\'S measurement against YESTERDAY\'S code');
}

const server = createServer(async (req, res) => {
  try {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const p = join(ROOT, clean === '/' ? 'index.html' : clean);
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

let browser = null;
const results = [];
let env = null, loadS = 0, logs = [];
try {
  browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`); });

  const t0 = Date.now();
  /* TWO AXES THIS RIG WAS BLIND ON UNTIL ROUND 5, both of them
     contracts.js rule 3: every number this file has ever printed came
     off quality=high in clear weather, and a crossing is a colour
     path that the tone map, the bloom mips and the storm desaturation
     all rewrite. --quality low|med|high|ultra is one page load;
     --weather is a PLAN AXIS, below, so every weather is sampled at
     the same minute one shot apart and the cloud drift is common-mode.

     AND THE WEATHER NAMES WERE WRONG, WHICH IS THE NINTH INSTRUMENT ON
     THIS PROJECT TO REPORT SOMETHING OTHER THAN WHAT IT MEASURED.
     This block documented its axis as "storm | overcast | clear".
     weather.js authors clear / cloudy / rain / storm and its set()
     returns FALSE for anything else — sky.js passes that boolean
     straight out of WALLY.debug.setWeather — so `--weather overcast`
     left the sky on the boot default and printed a CLEAR run under an
     overcast heading. Every name is now validated against the page
     before a single shot is taken, and an unknown one is fatal. */
  const QUAL = arg('quality', null);
  await page.goto(`http://127.0.0.1:${PORT}/index.html?shot=1${QUAL ? `&quality=${QUAL}` : ''}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', null, { timeout: 90000 });
  loadS = (Date.now() - t0) / 1000;

  /* rule 4: state the rig beside the number, measured at the moment
     of use, not assumed */
  env = await page.evaluate(() => {
    const gl = WALLY.ctx.renderer.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gpu: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown',
      tier: WALLY.ctx.quality.name || 'high',
      hasSwitch: typeof WALLY.debug.skyRule === 'function',
      rules: WALLY.debug.skyRules ? WALLY.debug.skyRules() : [],
      perf: window.__WALLY_PERF__ || null,
    };
  });
  if (!SWAP && !env.hasSwitch) throw new Error('lighting.js exposes no WALLY.debug.skyRule — nothing to revert against');

  /* --- the weather names are checked, not assumed --- */
  const wxCheck = await page.evaluate((names) => {
    if (typeof WALLY.debug.setWeather !== 'function') return { noHook: true };
    const bad = [];
    for (const n of names) if (WALLY.debug.setWeather(n, 0) !== true) bad.push(n);
    WALLY.debug.setWeather('clear', 0);
    return { bad };
  }, WEATHERS);
  if (wxCheck.noHook) throw new Error('no WALLY.debug.setWeather — cannot sweep the weather axis');
  if (wxCheck.bad.length) {
    const { WEATHER } = await import('../src/world/weather.js');
    throw new Error(`unknown weather ${wxCheck.bad.join(',')} — weather.js authors ` +
      `${Object.keys(WEATHER).join(', ')} and set() returned false, so this run would have MEASURED CLEAR`);
  }

  /* The HUD is DOM over the canvas and its pills are dark grey — left
     in frame they walk the mean and the green-smallest count. */
  await page.evaluate(() => { for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none'; });

  const settle = () => page.evaluate(() => new Promise(r => {
    let n = 0; const t = () => (++n > 20 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t);
  }));

  /* 150 m: above every building, below the lowest cloud deck (210 m).
     A dead-level look puts the horizon at frame centre with nothing
     but sky above it. The dome follows the camera and is a function of
     direction only, so the colours are the ones at eye level with the
     occluders gone. Same camera as tools/_sky-table.mjs, deliberately:
     the ten-minute numbers this is being compared against came off it. */
  const aim = ([hh, mode, rule, wx]) => {
    if (rule && WALLY.debug.skyRule) WALLY.debug.skyRule(rule);
    if (wx && WALLY.debug.setWeather) WALLY.debug.setWeather(wx, 0);
    WALLY.debug.setHour(hh);
    const { ctx } = WALLY;
    ctx.cam?.setEnabled?.(false);
    const cam = ctx.camera;
    const d = ctx.sky.sunDirection;
    /* `r<deg>` is a SUN-RELATIVE bearing: r0 is `sun`, r180 is `anti`,
       and r-45..r45 is the "within 45 degrees of the sun" wedge the
       green-smallest ruling is written in. It exists because `b<deg>`
       is an ABSOLUTE compass bearing and the sun MOVES between the two
       notch minutes (272.5 deg at 07:38, 57.8 deg at 17:19), so no one
       fixed compass list samples the same wedge at both. Reading the
       wedge off a b-sweep by hand needs the azimuth convention to be
       right, and getting that backwards is exactly the class of error
       this rig's own comments keep catching. */
    const az = mode[0] === 'b'
      ? parseFloat(mode.slice(1)) * Math.PI / 180
      : (mode[0] === 'r' && mode.length > 1)
        ? Math.atan2(d.x, d.z) + parseFloat(mode.slice(1)) * Math.PI / 180
        : Math.atan2(d.x, d.z) + (mode === 'anti' ? Math.PI : 0);
    cam.position.set(0, 150, 0);
    cam.lookAt(Math.sin(az) * 4000, 150, Math.cos(az) * 4000);
    cam.updateMatrixWorld();
    return +(az * 180 / Math.PI).toFixed(1);
  };

  const MEASURE = async ([url, horizonY]) => {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const w = bmp.width, h = bmp.height;
    const d = g.getImageData(0, 0, w, h).data;
    const y1 = Math.max(2, Math.min(h - 2, Math.floor(horizonY) - 10));
    const y0 = 2;
    if (y1 - y0 < 20) return null;
    let R = 0, G = 0, B = 0, n = 0, gs = 0;
    const rows = [];
    for (let y = y0; y <= y1; y++) {
      let rr = 0, gg = 0, bb = 0, m = 0;
      for (let x = 0; x < w; x += 2) {
        const o = (y * w + x) * 4;
        const r = d[o], gv = d[o + 1], b = d[o + 2];
        rr += r; gg += gv; bb += b; m++;
        R += r; G += gv; B += b; n++;
        if (gv < r && gv < b) gs++;
      }
      rows.push([rr / m, gg / m, bb / m]);
    }
    const nb = Math.max(2, Math.round(rows.length * 0.06));
    const avg = (a, s, e) => { let r = 0, g2 = 0, b = 0; for (let i = s; i < e; i++) { r += a[i][0]; g2 += a[i][1]; b += a[i][2]; } const k = e - s; return [r / k, g2 / k, b / k]; };
    const top = avg(rows, 0, nb), bot = avg(rows, rows.length - nb, rows.length);
    const grad = Math.abs(top[0] - bot[0]) + Math.abs(top[1] - bot[1]) + Math.abs(top[2] - bot[2]);
    const hex = (a) => '#' + a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    const mean = [R / n, G / n, B / n];
    const satOf = (a) => { const x = Math.max(...a), y = Math.min(...a); return +(x > 0 ? (x - y) / x : 0).toFixed(3); };
    /* THE FRAME MEAN'S SATURATION IS NOT ONE QUANTITY, AND ON THIS
       DEFECT IT IS TWO THAT PULL OPPOSITE WAYS.

       `sat` averages the whole sky column, so it falls both when the
       band goes grey (the defect) AND when the band is a saturated
       WARM colour under a saturated blue zenith (a dawn — the thing
       §2.1 actually asks for). Measured on this build at 07:38 in the
       anti-sun view: a pale MINT band read sat 0.154 and a pale CREAM
       band read 0.080, and the cream is the better sky by every rule
       in ART_DIRECTION. The metric was rewarding the band for
       agreeing with the zenith.

       So the column is also reported split. bandSat is the saturation
       of the mean of the rows just above the horizon — the band the
       crossing actually paints, and the only place the notch lives.
       It cannot be paid off against the zenith. */
    const bandMean = avg(rows, rows.length - Math.max(2, Math.round(rows.length * 0.18)), rows.length);
    const zenMean = avg(rows, 0, Math.max(2, Math.round(rows.length * 0.18)));
    return {
      mean: hex(mean), sat: satOf(mean),
      bandSat: satOf(bandMean), zenSat: satOf(zenMean),
      band: hex(bandMean), bandV: +(Math.max(...bandMean) / 255).toFixed(3),
      bandRGB: bandMean.map(v => +v.toFixed(2)),
      gSmall: +(100 * gs / n).toFixed(1), grad: +grad.toFixed(1),
      top: hex(top), bot: hex(bot),
    };
  };

  /* MINUTE-MAJOR, RULE-MINOR, AND THAT ORDER IS THE MEASUREMENT.

     clouds.js drifts on the global wind field and on `elapsed`, and
     nothing in this rig can reset its phase — so the sky mean at a
     fixed hour is NOT reproducible across a long run. Measured, the
     same minute on the same rule three times in one page load:

       07:38  sat 0.144 / 0.135 / 0.164     (grad 102 / 114 / 136)
       07:41  sat 0.364 / 0.370 / 0.395

     +/- 0.02 and rising with wall-clock, which is the same size as
     some of the differences being argued about. Rule-major sampling
     puts every `ship` reading a hundred shots of cloud drift away
     from its `prev` counterpart and calls the difference a fix.

     So the rules are compared AT THE SAME MINUTE, one shot apart,
     where the drift is common-mode and cancels in the difference.
     --repeat re-runs the first minute at the end, so every table
     carries its own drift figure.

     WEATHER IS THE INNERMOST AXIS FOR THE SAME REASON. A weather-major
     sweep would put the storm reading a hundred shots of drift away
     from the clear one it is being differenced against. */
  const PLAN = [];
  for (const m of MINUTES) for (const rule of RULES) for (const wx of WEATHERS) PLAN.push([m, rule, wx]);
  if (has('repeat')) for (const rule of RULES) for (const wx of WEATHERS) PLAN.push([MINUTES[0], rule, wx]);
  {
    for (const [m, rule, WX] of PLAN) {
      for (const mode of MODES) {
        await page.evaluate(aim, [m / 60, mode, SWAP ? null : rule, WX]);
        await settle();
        const info = await page.evaluate(() => {
          const { ctx, THREE } = WALLY;
          const cam = ctx.camera;
          const f = new THREE.Vector3(); cam.getWorldDirection(f);
          f.y = 0; f.normalize();
          const p = new THREE.Vector3().copy(cam.position).addScaledVector(f, 100000).project(cam);
          const L = ctx.sky.lighting;
          return {
            horizonY: (1 - (p.y * 0.5 + 0.5)) * window.innerHeight,
            dawn: +L.dawn.toFixed(3),
            haze: '#' + L.fogOut.getHexString(THREE.SRGBColorSpace).toUpperCase(),
            hor: '#' + L.horizonOut.getHexString(THREE.SRGBColorSpace).toUpperCase(),
            zen: '#' + L.skyOut.getHexString(THREE.SRGBColorSpace).toUpperCase(),
          };
        });
        const buf = await page.screenshot({ animations: 'allow', timeout: 30000 });
        const url = `data:image/png;base64,${buf.toString('base64')}`;
        const st = await page.evaluate(MEASURE, [url, info.horizonY]);
        results.push({ minute: m, time: hhmm(m), rule, mode, wx: WX, ...st, state: info });
        if (OUTPNG) {
          await mkdir(resolve(ROOT, OUTPNG), { recursive: true }).catch(() => {});
          await writeFile(resolve(ROOT, OUTPNG, `${rule}-${WX}-${hhmm(m).replace(':', '')}-${mode}.png`), buf);
        }
      }
    }
  }
} finally {
  if (browser) await browser.close();
  server.close();
  if (SWAP && backup) {
    await copyFile(backup, LIGHTING);
    console.log('# working-tree lighting.js restored');
  }
}

console.log(`GPU: ${env?.gpu}   tier: ${env?.tier}   load: ${loadS.toFixed(2)}s   ${W}x${H}   rules: ${RULES.join(',')}` +
  `   weather: ${WEATHERS.join(',')}${SWAP ? '  (HEAD SWAP)' : ''}`);
/* d/s — THE RENDERED RATE. |dRGB| of the band between the PREVIOUS
   sampled minute of the same rule and mode and this one, over the real
   seconds between them (2 per in-game minute). Blank where the
   previous sample is not the adjacent minute, because a gap makes the
   quotient an average over a gap and not a speed. Carries cloud drift
   as noise: --repeat prints the drift row to compare against. */
const prevOf = new Map();
for (const r of results) {
  const k = `${r.rule}|${r.mode}|${r.wx}`;
  const p = prevOf.get(k);
  r.dps = (p && r.bandRGB && p.bandRGB && r.minute === p.minute + 1)
    ? +(Math.hypot(r.bandRGB[0] - p.bandRGB[0], r.bandRGB[1] - p.bandRGB[1], r.bandRGB[2] - p.bandRGB[2]) / 2).toFixed(1)
    : null;
  prevOf.set(k, r);
}
console.log('time   rule  wx      mode  mean     sat    bandSat band     bandV  zenSat gSmall  grad    d/s   dawn   haze     horizon');
for (const r of results) {
  if (!r.mean) { console.log(`${r.time} ${r.rule} ${r.wx} ${r.mode} FAILED`); continue; }
  console.log(`${r.time}  ${r.rule.padEnd(5)} ${String(r.wx).padEnd(7)} ${r.mode.padEnd(5)} ${r.mean} ${String(r.sat).padEnd(6)} ` +
    `${String(r.bandSat).padEnd(6)}  ${r.band}  ${String(r.bandV).padEnd(5)}  ${String(r.zenSat).padEnd(6)} ` +
    `${String(r.gSmall).padStart(5)}% ${String(r.grad).padStart(6)}  ${String(r.dps ?? '-').padStart(5)} ` +
    `${String(r.state.dawn).padEnd(6)} ${r.state.haze} ${r.state.hor}`);
}
if (JSONOUT) await writeFile(JSONOUT, JSON.stringify({ env, loadS, swapHead: SWAP, results }, null, 1));
if (logs.length) console.log('--- page errors ---\n' + logs.slice(0, 10).join('\n'));
