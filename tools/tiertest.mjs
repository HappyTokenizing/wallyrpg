#!/usr/bin/env node
/* ============================================================
   tiertest.mjs — THE TIER AXIS. A durable suite, not a probe.

   WHY THIS FILE EXISTS. Every number this project has published for
   weeks was taken at tier `high`, 1600x900, deviceScaleFactor 1, on
   ANGLE-Metal. One tier, one viewport, one pixel ratio, one GPU class.
   That is four configurations collapsed into one, and contracts.js
   rule 3 says exactly what such a number is worth: "A claim about a
   general property that was only ever measured in one configuration is
   a claim about that configuration."

   AND THE COLLAPSE WAS INVISIBLE, because at deviceScaleFactor 1 EVERY
   TIER DRAWS THE SAME PIXELS. renderer.js's pixelRatioCeiling() is
   min(tierMax, devicePixelRatio, sqrt(budget/area)) — with dpr 1 the
   middle term pins all four tiers to 1.000, so low's 0.75 Mpx budget
   and ultra's 6.00 never applied to anything. Any run that did not set
   deviceScaleFactor above 1 measured the pixel axis not at all, and
   `--dpr 2` on tools/shot.mjs does not fix it either: the tier clamps
   the ratio straight back down and the [rig] line prints the truth.
   Every suite here therefore states the CSS box, the deviceScaleFactor,
   the ratio three.js actually used, and the drawing buffer in real
   pixels, on every row.

   HOW IT OBEYS THE PROJECT'S RULES (contracts.js, "HOW THIS PROJECT
   PROVES A FIX"):

   · Rule 1 — every A/B here is PAIRED INSIDE ONE PAGE LOAD with the
     arms ALTERNATED (A B A B ...), through the switch the module owns:
     WALLY.debug.propSweep('merge'|'spare') under ?propsweep=ab,
     WALLY.debug.shadowCadence(n), ctx.foliage.trees.setCanopies(on,
     'stream'|'island'). Two runs compared across time are not a result
     on a box whose 1-minute load has been seen at 20 and at 122.
   · Rule 2 — every assertion names the line it exercises. Grep this
     file for BRANCH: to find them.
   · Rule 3 — the whole point. tiers x viewports x GPU class.
   · Rule 4 — `load` (1-minute) is printed beside every millisecond,
     and any timing set taken above load 10 is marked DISCARD by the
     suite itself rather than by the reader. Counts, triangles, draw
     calls, bytes and distances are load-independent and are the
     preferred evidence throughout.
   · Rule 5 — a rig that cannot reach its subject dies. Every suite
     exits non-zero if the tier it asked for is not the tier that
     booted, if a switch returns a refusal string, or if the page threw.

   THE SOFTWARE TIER CANNOT BE FORCED. pickQuality() only returns
   'med(sw)' when it actually finds a software rasteriser, and
   'med(sw)' is not a key in QUALITY_TIERS, so ?quality=med(sw) is
   ignored (Object.hasOwn, deliberately). The only honest way to
   measure it is to run Chrome on SwiftShader — `--gpu sw` here, which
   adds --use-angle=swiftshader. SwiftShader is a legitimate LOW-END
   PROXY and it is NOT comparable to ANGLE-Metal: its rows are printed
   in their own block and the suite refuses to rank them against GPU
   rows.

   USAGE
     node tools/tiertest.mjs tiers                 # pure Node, no browser
     node tools/tiertest.mjs census
     node tools/tiertest.mjs sites
     node tools/tiertest.mjs shadowcell
     node tools/tiertest.mjs wins   [--reps 6]
     node tools/tiertest.mjs cliff  [--reps 5]
     node tools/tiertest.mjs all

   FLAGS
     --tiers low,med,high,ultra   which tiers          (default low,med,high)
     --views desktop,phone        which viewports      (default both)
     --gpu   angle|sw|both        GPU class            (default angle)
     --reps  n                    A/B pairs per arm    (default 6)
     --wait  ms                   settle after ready   (default 3500)
     --json                       machine-readable dump as well as the table
     --console                    print the browser console

   VIEWPORTS
     desktop  1600x900  CSS, deviceScaleFactor 2, no touch
     phone     390x844  CSS, deviceScaleFactor 3, touch + mobile UA
   Both are the stands the rest of the repo already uses (_k27-ref,
   _k28-acuity). deviceScaleFactor 2 and 3 are what make the tier's own
   pixel budget the binding term instead of the harness's dpr 1.
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUALITY_TIERS, tierName, pickQuality, deviceClass } from '../src/core/contracts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOAD_CEILING = 10;          // above this, timing sets are DISCARDed

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const SUITE = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'census';
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const TIERS = arg('tiers', 'low,med,high').split(',').filter(Boolean);
const VIEWS = arg('views', 'desktop,phone').split(',').filter(Boolean);
const GPUS = arg('gpu', 'angle') === 'both' ? ['angle', 'sw'] : [arg('gpu', 'angle')];
const REPS = +arg('reps', 6);
const WAIT = +arg('wait', 3500);
const READY = +arg('ready', 60000);
const JSON_OUT = flag('json');
const SHOW_CONSOLE = flag('console');

const load1 = () => +loadavg()[0].toFixed(2);
const hot = () => load1() > LOAD_CEILING;
const say = (s) => console.log(s);
const num = (v, w = 8, d = 2) => (v == null || Number.isNaN(v) ? '—' : (+v).toFixed(d)).padStart(w);
const pad = (s, w) => String(s).padEnd(w);

const VIEWPORTS = {
  desktop: { w: 1600, h: 900, dsf: 2, mobile: false,
             ua: null },
  phone:   { w: 390, h: 844, dsf: 3, mobile: true,
             ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
                 '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' },
};

/* ---------------- static server (same rules as shot.mjs) ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glsl': 'text/plain',
};
let server = null, PORT = 0;
async function serve() {
  if (server) return;
  server = createServer(async (req, res) => {
    try {
      const clean = decodeURIComponent(req.url.split('?')[0]);
      const path = join(ROOT, clean === '/' ? 'index.html' : clean);
      if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream',
                           'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
}

/* ---------------- one page load ----------------
   SHADER CAPTURE. The compiled tap counts are the only load-independent
   proof that a tier took the branch it was supposed to take, and no
   module exposes them. So we wrap WebGL2RenderingContext.shaderSource
   BEFORE the page runs and keep every source string. That reads the
   SHIPPED SHADER, not a setter's return value (rule 5). */
const INIT_SCRIPT = () => {
  window.__SHADERS__ = [];
  for (const P of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!P || !P.prototype) continue;
    const orig = P.prototype.shaderSource;
    P.prototype.shaderSource = function (sh, src) {
      try { window.__SHADERS__.push(String(src)); } catch (e) {}
      return orig.call(this, sh, src);
    };
  }
};

const browsers = new Map();
async function browserFor(gpu) {
  if (browsers.has(gpu)) return browsers.get(gpu);
  const args = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
                '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'];
  if (gpu === 'sw') args.push('--use-angle=swiftshader', '--disable-gpu-rasterization');
  else args.push('--enable-gpu-rasterization');
  const b = await chromium.launch({ channel: 'chrome', args });
  browsers.set(gpu, b);
  return b;
}

/**
 * Boot the game once and hand the page to `fn`.
 * Dies (throws) if the tier that booted is not the tier asked for.
 */
async function withPage({ view = 'desktop', gpu = 'angle', quality = null, qs = '', wait = WAIT }, fn) {
  await serve();
  const V = VIEWPORTS[view];
  if (!V) throw new Error(`unknown view ${view}`);
  const browser = await browserFor(gpu);
  const ctxOpts = {
    viewport: { width: V.w, height: V.h },
    deviceScaleFactor: V.dsf,
    hasTouch: V.mobile, isMobile: V.mobile,
  };
  if (V.ua) ctxOpts.userAgent = V.ua;
  const bctx = await browser.newContext(ctxOpts);
  const page = await bctx.newPage();
  await page.addInitScript(INIT_SCRIPT);
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));

  const query = ['shot=1', quality ? `quality=${quality}` : '', qs].filter(Boolean).join('&');
  const url = `http://127.0.0.1:${PORT}/index.html?${query}`;
  let out, err = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    /* NOT `waitForFunction(fn, {timeout})` — the second argument is
       `arg`, and an options object there silently uses the 30 s
       default. shot.mjs's header records the same bite. */
    /* SwiftShader on a busy box can take minutes to reach ready — it is
       rasterising ~450 draw calls in software. --ready raises it. */
    await page.waitForFunction('window.__WALLY_READY__ === true', null, { timeout: READY });

    /* PIN THE WIND before anything is counted. setStrength(0) never
       becalmed anything (weather.js damps the base back every frame);
       wind.pin(0) is the real one. Reported, never assumed. */
    const held = await page.evaluate(() => {
      const w = window.WALLY?.ctx?.wind;
      if (!w || typeof w.pin !== 'function') return 'NO wind.pin ON THIS BUILD';
      return w.pin(0);
    });
    if (typeof held === 'string') logs.push(`[wind] ${held}`);

    await page.waitForTimeout(wait);

    /* RULE 5: die if we did not reach the subject. */
    const got = await page.evaluate(() => window.WALLY?.ctx?.quality?.name ?? null);
    if (quality && got !== quality) throw new Error(`asked for tier '${quality}', booted '${got}'`);
    if (!quality && gpu === 'sw' && got !== 'med(sw)') {
      throw new Error(`--gpu sw did not reach the software tier: booted '${got}' ` +
                      `(renderer string did not match /swiftshader|llvmpipe|software/)`);
    }
    out = await fn(page, { view, gpu, tier: got, V });
  } catch (e) {
    err = e;
  }
  if (SHOW_CONSOLE || err) {
    const bad = logs.filter(l => /PAGEERROR|\[error\]/.test(l));
    if (bad.length) say(bad.slice(0, 12).join('\n'));
  }
  await bctx.close();
  if (err) throw err;
  return out;
}

/* The rig line. Never print a number without it (rule 4). */
const RIG = () => {
  const c = window.WALLY.ctx;
  const r = c.renderer, d = r.domElement;
  const sc = c.render?.targets?.scene;
  return {
    tier: c.quality?.name,
    tierBase: String(c.quality?.name || '').replace(/\(.*$/, ''),
    cssW: Math.round(d.clientWidth || innerWidth), cssH: Math.round(d.clientHeight || innerHeight),
    dsf: window.devicePixelRatio,
    pr: +r.getPixelRatio().toFixed(4),
    bufW: d.width, bufH: d.height,
    mpx: +((d.width * d.height) / 1e6).toFixed(3),
    /* the POST CHAIN's buffer, which is what SSAO/DOF/bloom actually
       shade — not always the canvas */
    rtW: sc?.width ?? null, rtH: sc?.height ?? null,
    rtMpx: sc ? +((sc.width * sc.height) / 1e6).toFixed(3) : null,
    tierMax: c.quality?.pixelRatioMax, budget: c.quality?.pixelBudget,
    calls: r.info.render.calls, tris: r.info.render.triangles,
    programs: r.info.programs?.length ?? 0,
    gl: (() => { try { const g = r.getContext();
      const e = g.getExtension('WEBGL_debug_renderer_info');
      return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; } catch (e) { return '?'; } })(),
  };
};

/* Read the compiled tap counts out of the captured shader sources.
   BRANCH: postfx.js:250  ssaoTaps = qn==='low'?8:(qn==='med'?10:12)
   BRANCH: postfx.js:506  dofTaps  = ...==='low'?8:(...==='med'?12:20) */
const TAPS = () => {
  const src = window.__SHADERS__ || [];
  const bound = (s) => { const m = s.match(/for\s*\(\s*int i = 0; i < (\d+); i \+\+ \)/); return m ? +m[1] : null; };
  const ssao = src.filter(s => s.includes('W_POISSON12[') && s.includes('uBias'));
  const dof = src.filter(s => s.includes('W_BOKEH[') && s.includes('uFocus'));
  return {
    shaders: src.length,
    ssaoCompiled: ssao.length > 0, ssaoTaps: ssao.length ? bound(ssao[0]) : null,
    dofCompiled: dof.length > 0, dofTaps: dof.length ? bound(dof[0]) : null,
  };
};

/* foam.js's shore skirt is (ANG+1) x RAD vertices, RAD = 7.
   BRANCH: foam.js:48  ANG = tierName(q.name)==='low' ? 192 : 384 */
const FOAM = () => {
  let ang = null, verts = null;
  window.WALLY.ctx.scene.traverse((o) => {
    /* the mesh is named at foam.js:264 — never a shape heuristic, which
       is how this first read 239 off an unrelated 1680-vertex mesh */
    if (o.name !== 'water.shoreSkirt') return;
    const p = o.geometry?.attributes?.position;
    if (!p) return;
    verts = p.count; ang = p.count / 7 - 1;      // nVert = (ANG+1)*RAD, RAD = 7
  });
  return { foamVerts: verts, foamANG: ang };
};

/* WHAT THE PLAYER'S FRAME IS, WHICH IS NOT WHAT ?shot RENDERS.
   renderer.js: `govOn = !ctx.flags?.shot`, and govStep starts at 0 with
   PR_LADDER[0] === 1. So under ?shot the pixel ratio is PINNED AT 1.000
   on EVERY tier, at every deviceScaleFactor — the tier's own
   pixelRatioMax and pixelBudget are never consulted, and every capture
   rig in this repo passes ?shot=1. This reads the shot ratio, computes
   the ceiling the tier would really allow, and then drives the
   governor's own ladder up to it so the number is the renderer's and
   not ours. */
const SHIP_RATIO = () => {
  const c = window.WALLY.ctx, r = c.renderer, d = r.domElement, q = c.quality;
  const cssW = Math.round(d.clientWidth || innerWidth), cssH = Math.round(d.clientHeight || innerHeight);
  const byBudget = Math.sqrt((q.pixelBudget * 1e6) / Math.max(1, cssW * cssH));
  const ceil = Math.max(1, Math.min(q.pixelRatioMax, devicePixelRatio, byBudget));
  const shot = +r.getPixelRatio().toFixed(4);
  const gs = window.WALLY.debug.governorState();
  for (let i = 0; i < 4; i++) window.WALLY.debug.governorStep(1, true);   // climb the real ladder
  const climbed = +r.getPixelRatio().toFixed(4);
  const bw = d.width, bh = d.height;
  window.WALLY.debug.governorStep(-1); window.WALLY.debug.governorStep(-1);
  window.WALLY.debug.governorStep(-1); window.WALLY.debug.governorStep(-1);
  return { shotRatio: shot, govOn: gs.on, govStep: gs.step, ladder: gs.ladder,
           byBudget: +byBudget.toFixed(4), ceiling: +ceil.toFixed(4),
           shipRatio: climbed, shipMpx: +((bw * bh) / 1e6).toFixed(3) };
};

/* ============================================================
   SUITE 1 — tiers.  pickQuality against REAL renderer strings.
   Pure Node: no browser, no load sensitivity, no timing at all.
   BRANCH: contracts.js:921 pickQuality, :802 deviceClass,
           :878 FAST_GPU, :840 DESKTOP_DISCRETE, :830 OLD_MOBILE_GPU
   ============================================================ */
const GPU_CORPUS = [
  /* name,                                            class,   what it is */
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)', 'desktop', 'M1 Max'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'RTX 4090'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'GTX 1650'],
  ['ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'RX 7900 XTX'],
  ['ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'RX 6800 XT'],
  ['ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'RX 580'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'GTX 1080 Ti'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'RTX 3050'],
  ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'Arc A770'],
  ['ANGLE (Intel, Intel(R) Arc(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'Arc iGPU (Meteor Lake)'],
  ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'Iris Xe'],
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'desktop', 'UHD 620'],
  ['SwiftShader Device (Subzero) (0x0000C0DE)', 'desktop', 'SwiftShader'],
  ['Apple GPU', 'phone', 'iPhone (Safari 15+)'],
  ['Apple GPU', 'tablet', 'iPad (Safari 15+)'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'tablet', 'M2 iPad'],
  ['ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)', 'phone', 'Adreno 740 (S8g2)'],
  ['ANGLE (Qualcomm, Adreno (TM) 530, OpenGL ES 3.2)', 'phone', 'Adreno 530 (2016)'],
  ['Mali-G715-Immortalis MC11', 'phone', 'Mali-G715'],
  ['Mali-T860', 'phone', 'Mali-T860 (2015)'],
  ['', 'phone', 'extension withheld'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU Direct3D11, D3D11)', 'phone', 'RTX laptop, narrow window'],
  ['ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'tablet', 'Windows tablet, UHD'],
];

function fakeEnv(cls) {
  const touch = cls !== 'desktop';
  const box = cls === 'phone' ? [390, 844] : cls === 'tablet' ? [820, 1180] : [1600, 900];
  return {
    location: { search: '' },
    navigator: {
      maxTouchPoints: touch ? 5 : 0,
      userAgent: cls === 'phone'
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
        : cls === 'tablet'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'
          : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0.0.0 Safari/537.36',
      userAgentData: cls === 'phone' ? { mobile: true } : cls === 'tablet' ? { mobile: false } : undefined,
    },
    screen: { width: box[0], height: box[1] },
    innerWidth: box[0], innerHeight: box[1],
    localStorage: null,
  };
}
const fakeRenderer = (name) => ({
  getContext: () => ({
    getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 } : null),
    getParameter: () => name,
  }),
});

function suiteTiers() {
  say(`\n=== SUITE tiers — pickQuality() over real renderer strings (pure Node, no timing) ===`);
  say(`${pad('device', 24)} ${pad('class', 8)} ${pad('picked', 9)} ${pad('tierName()', 10)} px-budget`);
  const rows = [];
  for (const [name, cls, label] of GPU_CORPUS) {
    const env = fakeEnv(cls);
    const q = pickQuality(fakeRenderer(name), env);
    const seen = deviceClass(env);
    rows.push({ label, cls, seen, picked: q.name, base: tierName(q.name), budget: q.pixelBudget });
    say(`${pad(label, 24)} ${pad(seen, 8)} ${pad(q.name, 9)} ${pad(tierName(q.name), 10)} ${q.pixelBudget}`);
  }
  const by = (l) => rows.find(r => r.label === l);
  say('');
  const checks = [
    ['a phone can now reach a phone-shaped tier',
     by('Adreno 530 (2016)').picked === 'low' && by('Mali-T860 (2015)').picked === 'low'],
    ['RX 7900 XTX >= GTX 1650 (the inversion)',
     by('RX 7900 XTX').picked === by('GTX 1650').picked],
    ['GTX 1080 Ti is not below a GTX 1650',
     by('GTX 1080 Ti').picked === by('GTX 1650').picked],
    ['RX 580 (2017, slower than a 1650) is NOT given high',
     by('RX 580').picked !== 'high'],
    ['Arc A770 escapes the intel demotion',
     by('Arc A770').picked === 'high'],
    ['Arc integrated (no model number) keeps low',
     by('Arc iGPU (Meteor Lake)').picked === 'low'],
    ['M2 iPad no longer inherits the M1 Max tier',
     by('M2 iPad').picked !== 'high'],
    ['SwiftShader is named med(sw) and pinned to ratio 1',
     by('SwiftShader').picked === 'med(sw)'],
    ['an RTX laptop dragged narrow keeps the desktop branch',
     by('RTX laptop, narrow window').picked === 'high'],
  ];
  let bad = 0;
  for (const [what, ok] of checks) { if (!ok) bad++; say(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); }
  say(`\n  tierName() collapse: ${['low', 'med', 'high', 'ultra', 'med(sw)', 'high(sw)', 'constructor', '', null]
    .map(n => `${JSON.stringify(n)}->${tierName(n)}`).join('  ')}`);
  if (JSON_OUT) say(JSON.stringify(rows, null, 1));
  return bad;
}

/* ============================================================
   SUITE 2 — census. What each tier x viewport ACTUALLY draws.
   Every figure here is a count, a triangle, or a pixel: none of it
   moves with the box load.
   ============================================================ */
async function suiteCensus() {
  say(`\n=== SUITE census — counts, triangles and the pixels REALLY drawn (load-independent) ===`);
  say(`${pad('tier', 8)} ${pad('view', 8)} ${pad('css', 10)} dsf  ratio   buffer      Mpx   post-Mpx  calls    tris  progs`);
  const rows = [];
  for (const gpu of GPUS) {
    for (const view of VIEWS) {
      for (const t of (gpu === 'sw' ? [null] : TIERS)) {
        let r;
        try {
          r = await withPage({ view, gpu, quality: t }, async (page) => {
            /* several frames so info.render is a real frame, not the boot one */
            await page.evaluate(() => new Promise(res => { let n = 0;
              const tick = () => (++n > 8 ? res() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
            const rig = await page.evaluate(RIG);
            const taps = await page.evaluate(TAPS);
            const foam = await page.evaluate(FOAM);
            const extra = await page.evaluate(() => {
              const c = window.WALLY.ctx;
              const d = window.WALLY.debug;
              return { ...(d.renderInfo ? d.renderInfo() : {}),
                       mapSize: c.quality?.shadowSize ?? null,
                       ssaoOn: c.quality?.ssao, dofOn: c.quality?.dof, msaa: c.quality?.msaa,
                       grass: c.quality?.grass, grassDist: c.quality?.grassDist,
                       trees: c.foliage?.trees?.stats?.().total ?? null };
            });
            const ship = await page.evaluate(SHIP_RATIO);
            return { ...rig, ...taps, ...foam, ...extra, ...ship };
          });
        } catch (e) { say(`  ${pad(t || 'sw', 8)} ${pad(view, 8)} DIED: ${e.message}`); process.exitCode = 1; continue; }
        rows.push({ gpu, view, ask: t, ...r });
        say(`${pad(r.tier, 8)} ${pad(view, 8)} ${pad(`${r.cssW}x${r.cssH}`, 10)} ${r.dsf}  ` +
            `${num(r.pr, 5, 3)}  ${pad(`${r.bufW}x${r.bufH}`, 11)}${num(r.mpx, 5, 2)}  ` +
            `${num(r.rtMpx, 8, 2)} ${num(r.calls, 6, 0)} ${num(r.tris, 8, 0)} ${num(r.programs, 5, 0)}`);
      }
    }
  }
  say(`\n  THE PIXEL AXIS. ?shot turns the governor off and the ladder starts at 1.0, so every rig in`);
  say(`  this repo has measured ratio 1.000 on every tier. 'ship' is the same renderer after its own`);
  say(`  ladder is driven up — what a player on this dsf actually gets:`);
  for (const r of rows) {
    const binding = Math.min(r.tierMax, r.dsf, r.byBudget) === r.byBudget ? 'BUDGET'
      : Math.min(r.tierMax, r.dsf) === r.dsf ? 'device dsf' : 'tier max';
    say(`    ${pad(r.tier, 8)} ${pad(r.view, 8)} tierMax ${r.tierMax}  budget ${r.budget} Mpx -> ratio ` +
        `${r.byBudget.toFixed(3)}  dsf ${r.dsf}  ceiling ${r.ceiling}  | shot ${r.shotRatio} ` +
        `(${r.mpx} Mpx)  ship ${r.shipRatio} (${r.shipMpx} Mpx)  binding: ${binding}`);
  }
  say(`\n  shader branches actually COMPILED (read from gl.shaderSource, not from a setter):`);
  for (const r of rows) {
    say(`    ${pad(r.tier, 8)} ${pad(r.view, 8)} ssao ${r.ssaoCompiled ? `${r.ssaoTaps} taps` : 'not built'}` +
        `   dof ${r.dofCompiled ? `${r.dofTaps} taps` : 'not built'}` +
        `   foam ANG ${r.foamANG ?? '?'}   cascades ${r.cascades ?? '?'}@${r.mapSize ?? '?'}`);
  }
  if (JSON_OUT) say(JSON.stringify(rows, null, 1));
  return rows;
}

/* ============================================================
   SUITE 3 — sites. The five `q.name === 'med'` sites that were just
   moved onto tierName(), proven ON THE TIER THEY WERE FIXED FOR.

   THE REVERT CHECK IS ARITHMETIC HERE, and that is legitimate because
   the fix IS the arithmetic: each site is a two- or three-armed
   ternary over a string. We evaluate the OLD expression and the NEW
   expression against the SAME live q.name read out of the running
   page, and we then confirm the NEW one against what the shipped
   shader / geometry actually contains. So the "before" number is
   computed, not quoted (contracts.js: "a quoted before-number is a
   citation, not a revert check"), and the "after" number is read off
   the frame.
   ============================================================ */
const SITES = [
  { file: 'postfx.js:250', what: 'ssaoTaps',
    old: (n) => (n === 'low' ? 8 : n === 'med' ? 10 : 12),
    now: (n) => (tierName(n) === 'low' ? 8 : tierName(n) === 'med' ? 10 : 12),
    live: (r) => (r.ssaoCompiled ? r.ssaoTaps : null), gate: (r) => r.ssaoCompiled },
  { file: 'postfx.js:506', what: 'dofTaps',
    old: (n) => (n === 'low' ? 8 : n === 'med' ? 12 : 20),
    now: (n) => (tierName(n) === 'low' ? 8 : tierName(n) === 'med' ? 12 : 20),
    live: (r) => (r.dofCompiled ? r.dofTaps : null), gate: (r) => r.dofCompiled },
  { file: 'foam.js:48', what: 'foam ANG',
    old: (n) => (n === 'low' ? 192 : 384),
    now: (n) => (tierName(n) === 'low' ? 192 : 384),
    live: (r) => r.foamANG, gate: () => true },
  { file: 'world.js:581', what: 'processPending/frame',
    old: (n) => (n === 'low' ? 1 : 3),
    now: (n) => (tierName(n) === 'low' ? 1 : 3),
    live: () => null, gate: () => false },
  { file: 'world.js:612', what: 'maxGeo',
    old: (n) => (n === 'low' ? 1 : 3),
    now: (n) => (tierName(n) === 'low' ? 1 : 3),
    live: () => null, gate: () => false },
];

function suiteSites(rows) {
  say(`\n=== SUITE sites — the five tierName() sites, on the tiers they were fixed for ===`);
  say(`  old = the shipped expression at HEAD; now = the working tree's; live = read off the frame`);
  say(`\n${pad('site', 22)} ${pad('what', 20)} ${pad('tier', 9)} ${pad('old', 6)} ${pad('now', 6)} ${pad('live', 6)} verdict`);
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.tier)) seen.set(r.tier, r);
  let moved = 0, checked = 0;
  for (const s of SITES) {
    for (const [tier, r] of seen) {
      const o = s.old(tier), n = s.now(tier), l = s.live(r);
      const changed = o !== n;
      let verdict;
      if (!s.gate(r)) verdict = `not built on ${tier} — the branch is DEAD here`;
      else if (l == null) verdict = 'NOT OBSERVABLE';
      else { checked++; verdict = l === n ? (changed ? 'FIX CONFIRMED IN THE FRAME' : 'unchanged (matches)')
                                          : `MISMATCH — shader says ${l}`; }
      if (changed) moved++;
      say(`${pad(s.file, 22)} ${pad(s.what, 20)} ${pad(tier, 9)} ${pad(o, 6)} ${pad(n, 6)} ` +
          `${pad(l ?? '—', 6)} ${changed ? '' : '[no-op] '}${verdict}`);
    }
  }
  say(`\n  ${moved} of ${SITES.length * seen.size} (site x tier) pairs actually CHANGE VALUE; ` +
      `${checked} of them were confirmed against the shipped frame.`);
  return moved;
}

/* ============================================================
   SUITE 4 — shadowcell. The 288 m prop-merge grid against low's
   single 1024 cascade.
   BRANCH: props.js:1356 SWEEP = 288, props.js cullShadows(camPos, far)
           renderer.js:52 SHADOW_FAR = {low:45, med:70, high:92}
   All counts and metres. No timing.
   ============================================================ */
async function suiteShadowCell() {
  say(`\n=== SUITE shadowcell — 288 m merged cells vs the shadow far distance (metres and counts) ===`);
  say(`${pad('tier', 8)} ${pad('view', 8)} casc@size   far  cull-lim  swept  radius med/max   castShadow on  in-lim`);
  const out = [];
  for (const view of VIEWS) {
    for (const t of TIERS) {
      let r;
      try {
        r = await withPage({ view, gpu: 'angle', quality: t }, async (page) => {
          await page.evaluate(() => new Promise(res => { let n = 0;
            const tick = () => (++n > 8 ? res() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
          return page.evaluate(() => {
            const c = window.WALLY.ctx;
            const info = window.WALLY.debug.renderInfo ? window.WALLY.debug.renderInfo() : {};
            /* renderInfo() carries cascades and farCadence but NEITHER the
               shadow far distance NOR the map size — an earlier draft read
               `info.shadowFar` and `info.mapSize`, got undefined for both,
               and silently fell back to `far ?? 92`, i.e. it printed the
               HIGH tier's distance on every row including low's. The real
               numbers live on the csm's own cfg, which renderer.js exposes
               as ctx.render.csm (Object.assign(api,{... csm ...})). Read
               them there so the row is the tier's own.
               BRANCH: renderer.js:52 SHADOW_FAR {low:45,med:70,high:92,ultra:112}
                       -> csm.setFar() -> csm.js:56 cfg.far */
            const cfg = c.render?.csm?.cfg || {};
            const far = Number.isFinite(cfg.far) ? cfg.far : null;
            const mapSize = Number.isFinite(cfg.mapSize) ? cfg.mapSize : (c.quality?.shadowSize ?? null);
            const cam = c.camera.getWorldPosition(new c.THREE.Vector3());
            const swept = [], radii = [];
            let castOn = 0, castTotal = 0, inLim = 0;
            c.scene.traverse((o) => {
              if (!o.isMesh && !o.isInstancedMesh) return;
              if (o.castShadow !== undefined && (o.isMesh || o.isInstancedMesh)) {
                castTotal++; if (o.castShadow) castOn++;
              }
              const merged = /^prop\./.test(o.name || '') || /sweep|@merge/.test(o.name || '');
              const bs = o.boundingSphere || o.geometry?.boundingSphere;
              if (!bs || !merged) return;
              swept.push(o.name); radii.push(bs.radius);
              const ctr = bs.center.clone().applyMatrix4(o.matrixWorld);
              if (ctr.distanceTo(cam) - bs.radius < (far ?? 92) + 24) inLim++;
            });
            radii.sort((a, b) => a - b);
            return {
              cascades: info.cascades ?? cfg.cascades ?? null, mapSize, far,
              swept: swept.length,
              radMed: radii.length ? radii[radii.length >> 1] : null,
              radMax: radii.length ? radii[radii.length - 1] : null,
              castOn, castTotal, inLim,
              camAt: [+cam.x.toFixed(1), +cam.y.toFixed(1), +cam.z.toFixed(1)],
            };
          });
        });
      } catch (e) { say(`  ${pad(t, 8)} ${pad(view, 8)} DIED: ${e.message}`); process.exitCode = 1; continue; }
      out.push({ tier: t, view, ...r });
      say(`${pad(t, 8)} ${pad(view, 8)} ${pad(`${r.cascades}@${r.mapSize ?? '?'}`, 11)} ${num(r.far, 4, 0)} ` +
          `${num((r.far ?? 0) + 24, 9, 0)} ${num(r.swept, 6, 0)} ${num(r.radMed, 8, 1)}/${num(r.radMax, 6, 1)} ` +
          `${num(r.castOn, 9, 0)}/${num(r.castTotal, 5, 0)} ${num(r.inLim, 7, 0)}   cam ${r.camAt}`);
    }
  }
  say(`\n  SWEEP is 288 m, so a merged cell's half-diagonal is up to 204 m before its contents' own extent.`);
  /* DO NOT SAY "THE CULL CANNOT REMOVE ONE" HERE. An earlier draft
     concluded exactly that from radMed/far > 1, and printed it on a row
     whose OWN in-lim column said 53 of 135 — i.e. the cull had just
     rejected 82 cells. radMed > far does not mean nothing is culled; it
     means a cell is admitted whenever its CENTRE is within (far + 24 +
     radius), which is a much larger sphere than the cascade set, not an
     infinite one. The honest figure is the measured survival rate, and
     the interesting comparison is low's against high's: low's cascade
     set reaches HALF as far as high's, so if the 288 m grid were fine
     enough to track the shadow distance, low would admit far fewer
     cells than high. It admits almost the same number. */
  for (const r of out) {
    const ratio = r.radMed != null && r.far ? (r.radMed / r.far) : null;
    const pct = r.swept ? (100 * r.inLim / r.swept) : null;
    say(`    ${pad(r.tier, 6)} ${pad(r.view, 8)} median merged radius ${num(r.radMed, 6, 1)} m = ` +
        `${ratio ? ratio.toFixed(2) : '?'}x the ${r.far} m shadow far  ->  admits ${r.inLim}/${r.swept} ` +
        `merged cells (${pct == null ? '?' : pct.toFixed(0)}%) into the shadow pass`);
  }
  const lo = out.find(r => r.tier === 'low'), hi = out.find(r => r.tier === 'high');
  if (lo && hi && lo.swept) {
    say(`\n    low reaches ${lo.far} m vs high's ${hi.far} m — ${(100 * (1 - lo.far / hi.far)).toFixed(0)}% less shadow` +
        ` distance — yet admits ${lo.inLim} cells against high's ${hi.inLim}, only ` +
        `${(100 * (1 - lo.inLim / hi.inLim)).toFixed(0)}% fewer. A 288 m cell is far coarser than low's`);
    say(`    ${lo.far} m cascade, so the distance cull cannot follow the tier down: low pays close to high's`);
    say(`    merged-cell shadow cost for a cascade set that reaches half as far.`);
  }
  if (JSON_OUT) say(JSON.stringify(out, null, 1));
  return out;
}

/* ============================================================
   SUITE 5 — wins. Do the last round's three wins survive at low, and
   is the RANKING the same? PAIRED, ALTERNATED, ONE PAGE LOAD.

   Each arm is measured by COUNTS first (draw calls, triangles, shadow
   renders per frame, colliders registered) because those do not move
   with the box load. The frame time is taken too, and it is stamped
   DISCARD when load1 > 10 rather than quietly reported.
   ============================================================ */
async function armPairs(page, arms, reps, sample) {
  /* A B A B ... — never all of A then all of B. */
  const acc = Object.fromEntries(Object.keys(arms).map(k => [k, []]));
  for (let i = 0; i < reps; i++) {
    for (const k of Object.keys(arms)) {
      const refusal = await page.evaluate(arms[k]);
      if (typeof refusal === 'string' && /NO |unknown|FAIL/i.test(refusal)) {
        throw new Error(`arm '${k}' refused: ${refusal}`);
      }
      await page.evaluate(() => new Promise(res => { let n = 0;
        const tick = () => (++n > 12 ? res() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
      acc[k].push(await page.evaluate(sample));
    }
  }
  return acc;
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

async function suiteWins() {
  say(`\n=== SUITE wins — the last round's three wins, paired inside one page load, per tier ===`);
  say(`  load at start: ${load1()}${hot() ? '  (>10 — every MILLISECOND below is DISCARD; counts still stand)' : ''}`);
  const results = [];
  for (const view of VIEWS) {
    for (const t of TIERS) {
      const line = (s) => say(`  [${t}/${view}] ${s}`);
      try {
        const r = await withPage({ view, gpu: 'angle', quality: t, qs: 'propsweep=ab' }, async (page) => {
          const rig = await page.evaluate(RIG);
          const out = { rig };

          /* ---- WIN 1: the @spare prop merge.
             BRANCH: props.js:1755 sweepMode('merge'|'spare') */
          const sweep = await armPairs(page, {
            merge: () => window.WALLY.debug.propSweep('merge'),
            spare: () => window.WALLY.debug.propSweep('spare'),
          }, REPS, () => {
            const r = window.WALLY.ctx.renderer;
            const p = window.__WALLY_PERF__ || {};
            return { calls: r.info.render.calls, tris: r.info.render.triangles, ms: p.p50 ?? null, cpu: p.cpuMs ?? null };
          });
          out.sweep = sweep;

          /* ---- WIN 2: the shadow cadence.
             BRANCH: csm.js:481 setFarCadence(n), csm.js:392 cadenceOf */
          const ship = await page.evaluate(() => window.WALLY.debug.shadowStats(false).farCadence);
          const cad = await armPairs(page, {
            cadenced: (() => { const n = ship; return new Function(`window.WALLY.debug.shadowCadence(${n});` +
              `window.WALLY.debug.shadowStats(true);`); })(),
            every: new Function('window.WALLY.debug.shadowCadence(1);window.WALLY.debug.shadowStats(true);'),
          }, REPS, () => {
            const s = window.WALLY.debug.shadowStats(false);
            const p = window.__WALLY_PERF__ || {};
            return { perFrame: s.perFrame, renders: s.renders, skips: s.skips, frames: s.frames,
                     calls: window.WALLY.ctx.renderer.info.render.calls, ms: p.p50 ?? null };
          });
          out.cadence = { ship, ...cad };
          await page.evaluate((n) => window.WALLY.debug.shadowCadence(n), ship);

          /* ---- WIN 3: canopy streaming.
             BRANCH: trees.js:934 setCanopies(on, 'stream'|'island'),
                     trees.js:905 streamCanopies(CANOPY_BUDGET) */
          const canopy = await page.evaluate(async () => {
            const tr = window.WALLY.ctx.foliage?.trees;
            if (!tr?.setCanopies || !tr.canopyStats) return 'NO canopy API ON THIS BUILD';
            const frames = (n) => new Promise(res => { let i = 0;
              const t = () => (++i > n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
            const runs = [];
            for (let rep = 0; rep < 2; rep++) {
              for (const mode of ['stream', 'island']) {
                tr.setCanopies(false); await frames(4);
                const t0 = performance.now();
                tr.setCanopies(true, mode);
                const spike = performance.now() - t0;      // the init-frame cost
                await frames(6);
                const s = tr.canopyStats();
                runs.push({ mode, spikeMs: +spike.toFixed(2), live: s.live ?? tr.crownCount,
                            streamed: s.streamed, budget: s.budget });
              }
            }
            tr.setCanopies(false);
            return runs;
          });
          out.canopy = canopy;
          return out;
        });

        const s = r.sweep, mc = med(s.merge.map(x => x.calls)), sc = med(s.spare.map(x => x.calls));
        const mt = med(s.merge.map(x => x.tris)), st = med(s.spare.map(x => x.tris));
        line(`rig ${r.rig.bufW}x${r.rig.bufH} = ${r.rig.mpx} Mpx at ratio ${r.rig.pr}`);
        line(`WIN1 prop merge : calls ${sc} spare -> ${mc} merge  (${(100 * (sc - mc) / sc).toFixed(1)}% off), ` +
             `tris ${st} -> ${mt}  [counts, load-independent]`);
        /* THE DRIFT CONTROL, AND WHY IT IS NOT OPTIONAL. The arms are
           alternated inside one page load, which removes drift BETWEEN
           runs — but not drift DURING the run. This world is still
           streaming while the A/B is taken (canopy crowns at 4/frame,
           terrain geometry, NPCs), so the scene can be materially
           bigger at rep 4 than at rep 1 and the median of an arm is then
           a median over a moving world. A first-vs-last spread on the
           SAME arm is the control: it is the drift the world produced
           with the switch held still, and any A-vs-B difference smaller
           than it is not a result. Printed always, so nobody has to
           remember to ask. */
        const spread = (a) => { const v = a.filter(x => Number.isFinite(x));
          return v.length ? { lo: Math.min(...v), hi: Math.max(...v), d: v[v.length - 1] - v[0] } : null; };
        const dm = spread(s.merge.map(x => x.calls)), ds = spread(s.spare.map(x => x.calls));
        const dmt = spread(s.merge.map(x => x.tris));
        const worst = Math.max(Math.abs(dm?.d ?? 0), Math.abs(ds?.d ?? 0));
        const gap = Math.abs(sc - mc);
        line(`     drift ctl : merge arm calls ${dm.lo}..${dm.hi} (first->last ${dm.d >= 0 ? '+' : ''}${dm.d}), ` +
             `spare arm ${ds.lo}..${ds.hi} (${ds.d >= 0 ? '+' : ''}${ds.d}), merge tris ` +
             `${dmt.lo}..${dmt.hi} (${dmt.d >= 0 ? '+' : ''}${dmt.d})`);
        line(`     VERDICT   : A-B gap ${gap} calls vs within-arm drift ${worst} -> ` +
             (gap > 2 * worst ? 'REAL (gap is >2x the drift)'
                              : `NOT RESOLVED — the world moved as much as the switch did; ` +
                                `re-run on a quiet box with more settle before quoting a sign`));
        const cf = med(r.cadence.cadenced.map(x => x.perFrame)), ef = med(r.cadence.every.map(x => x.perFrame));
        line(`WIN2 shadow cad : ${ef} cascade renders/frame at cadence 1 -> ${cf} at cadence ` +
             `${r.cadence.ship}  (${ef ? (100 * (ef - cf) / ef).toFixed(1) : '?'}% of shadow renders removed)`);
        if (typeof r.canopy === 'string') line(`WIN3 canopy     : ${r.canopy}`);
        else {
          const g = (m) => r.canopy.filter(x => x.mode === m);
          const sp = (m) => med(g(m).map(x => x.spikeMs));
          line(`WIN3 canopy     : island spike ${num(sp('island'), 6, 2)} ms vs stream ${num(sp('stream'), 6, 2)} ms ` +
               `— live crowns island ${g('island')[0].live} / stream ${g('stream')[0].live} ` +
               `(budget ${g('stream')[0].budget}/frame)  ${hot() ? '[DISCARD ms — load ' + load1() + ']' : '[load ' + load1() + ']'}`);
        }
        const mm = med(s.merge.map(x => x.ms)), sm = med(s.spare.map(x => x.ms));
        line(`   frame p50: spare ${num(sm, 6, 2)} ms, merge ${num(mm, 6, 2)} ms ` +
             `${hot() ? '<- DISCARD, load ' + load1() : '<- load ' + load1()}`);
        results.push({ tier: t, view, callsSaved: sc - mc, callsPct: 100 * (sc - mc) / sc,
                       trisSaved: st - mt, shadowPct: ef ? 100 * (ef - cf) / ef : null,
                       calls: mc, mpx: r.rig.mpx, canopy: r.canopy });
      } catch (e) { line(`DIED: ${e.message}`); process.exitCode = 1; }
    }
  }
  say(`\n  RANKING, by draw calls removed (the currency of this frame — props.js prices a call at ~3.0 us`);
  say(`  and a thousand triangles at ~0.064 us), per tier:`);
  for (const r of results) {
    say(`    ${pad(r.tier, 6)} ${pad(r.view, 8)} merge -${Math.round(r.callsSaved)} calls ` +
        `(${r.callsPct.toFixed(1)}% of ${Math.round(r.calls + r.callsSaved)}), ` +
        `cadence -${r.shadowPct?.toFixed(1) ?? '?'}% shadow renders, at ${r.mpx} Mpx`);
  }
  if (JSON_OUT) say(JSON.stringify(results, null, 1));
  return results;
}

/* ============================================================
   SUITE 6 — cliff. Where does the frame stop holding 30 fps, and what
   is binding when it does?

   THE STRESS AXIS IS THE PIXEL RATIO, not the tier, because ratio is
   the ONE knob that can be moved live and inside a single page load
   (WALLY.debug.pixelRatio, which stores through the single clamp — see
   renderer.js PR_MIN/PR_MAX). Ratios are ALTERNATED against a fixed
   reference ratio so drift in the box shows up as movement in the
   reference rather than as a result.

   WHAT IS BINDING is read as cpuMs (main.js's own median of the CPU
   half of the frame) against p50: when cpu ~= p50 the frame is
   submission-bound and more pixels are free; when p50 >> cpu it is
   fill-bound. Draw calls and triangles are printed on every row so the
   claim can be checked against the geometry rather than believed.
   ============================================================ */
async function suiteCliff() {
  say(`\n=== SUITE cliff — where 30 fps breaks, and what is binding (TIMING: read the load column) ===`);
  const RATIOS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  for (const view of VIEWS) {
    for (const t of TIERS) {
      say(`\n  ${t} / ${view}   ratio   Mpx    p50 ms   cpu ms   fps   calls    tris   bound      load`);
      try {
        await withPage({ view, gpu: 'angle', quality: t, qs: 'govern=0' }, async (page) => {
          const ref = 1;
          for (const r of RATIOS) {
            /* alternate: reference, then the arm — inside one load */
            for (const want of [ref, r]) {
              const got = await page.evaluate((v) => window.WALLY.debug.pixelRatio(v), want);
              await page.evaluate(() => new Promise(res => { let n = 0;
                const tick = () => (++n > 90 ? res() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }));
              if (want !== r) continue;
              const s = await page.evaluate(() => {
                const p = window.__WALLY_PERF__ || {};
                const rr = window.WALLY.ctx.renderer, d = rr.domElement;
                return { p50: p.p50, cpu: p.cpuMs, settled: p.settled, calls: p.calls, tris: p.tris,
                         mpx: +((d.width * d.height) / 1e6).toFixed(3), pr: +rr.getPixelRatio().toFixed(3) };
              });
              const L = load1();
              const bound = s.cpu == null ? '?' : (s.cpu > s.p50 * 0.75 ? 'CPU/submit' : 'GPU/fill');
              say(`             ${num(got, 7, 3)} ${num(s.mpx, 6, 2)} ${num(s.p50, 8, 2)} ${num(s.cpu, 8, 2)} ` +
                  `${num(s.p50 ? 1000 / s.p50 : null, 5, 0)} ${num(s.calls, 7, 0)} ${num(s.tris, 8, 0)}  ` +
                  `${pad(bound, 10)} ${num(L, 5, 2)}${L > LOAD_CEILING ? ' DISCARD' : ''}` +
                  `${s.settled ? '' : ' (unsettled)'}${Math.abs(got - r) > 1e-6 ? `  [asked ${r}, CLAMPED to ${got} — same arm as another row]` : ''}`);
            }
          }
          await page.evaluate(() => window.WALLY.debug.pixelRatio(null));
        });
      } catch (e) { say(`    DIED: ${e.message}`); process.exitCode = 1; }
    }
  }
  say(`\n  Rows above load ${LOAD_CEILING} are marked DISCARD and must not be quoted. Rows whose ratio was`);
  say(`  CLAMPED collapsed into another row's arm and are the same condition measured twice.`);
}

/* ---------------- main ---------------- */
const t0 = Date.now();
say(`tiertest — box load ${loadavg().map(x => x.toFixed(2)).join(' / ')} (1/5/15 min), ` +
    `tiers ${TIERS.join(',')}, views ${VIEWS.join(',')}, gpu ${GPUS.join(',')}`);
if (hot()) say(`LOAD IS ${load1()} — ABOVE ${LOAD_CEILING}. Count-based suites are valid; every millisecond is DISCARD.`);
try {
  let rows = null;
  if (SUITE === 'tiers' || SUITE === 'all') { if (suiteTiers() > 0) process.exitCode = 1; }
  if (SUITE === 'census' || SUITE === 'sites' || SUITE === 'all') rows = await suiteCensus();
  if (SUITE === 'sites' || SUITE === 'all') suiteSites(rows || []);
  if (SUITE === 'shadowcell' || SUITE === 'all') await suiteShadowCell();
  if (SUITE === 'wins' || SUITE === 'all') await suiteWins();
  if (SUITE === 'cliff' || SUITE === 'all') await suiteCliff();
  if (!['tiers', 'census', 'sites', 'shadowcell', 'wins', 'cliff', 'all'].includes(SUITE)) {
    say(`unknown suite '${SUITE}'. One of: tiers census sites shadowcell wins cliff all`);
    process.exitCode = 2;
  }
} finally {
  for (const b of browsers.values()) await b.close().catch(() => {});
  server?.close();
}
say(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)} s — box load now ${load1()}`);
