#!/usr/bin/env node
/* ============================================================
   _j26-tier.mjs — WHAT DOES EACH REAL DEVICE ACTUALLY GET?

   pickQuality(renderer, env) now reads TWO things: the GPU string and
   the device class (touch + UA + CSS box). _fa-tier.mjs, the rig that
   found the old bug, drives only the first — it calls
   pickQuality(renderer) with no env, from a page with NO touch
   emulation, so every one of its rows takes the DESKTOP branch. Run
   against today's code it would report the desktop answer for a phone
   and call it a phone's answer.

   So this rig drives BOTH inputs, and it drives them two ways:

     REAL   a page booted with hasTouch + isMobile + a mobile UA at the
            device's own CSS box, GPU string patched, and pickQuality
            called with NO SECOND ARGUMENT — byte for byte the call
            createContext() makes in production.
     STUB   the same function handed an explicit env object, for the
            boxes one browser context cannot be (an iPad's 1194x834
            with touch and a desktop UA, a touchscreen laptop).

   The two must agree wherever they overlap, and they are printed
   together so a disagreement is visible rather than averaged away.
   ============================================================ */
import { boot, ENVSTATE, load1 } from './_j26-lib.mjs';

const GPUS = {
  appleGPU:  'Apple GPU',                                                     // iOS/iPadOS Safari 15+
  withheld:  '',                                                              // extension refused
  adreno740: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)',              // S8 Gen 2 flagship
  adreno640: 'ANGLE (Qualcomm, Adreno (TM) 640, OpenGL ES 3.2)',              // S855, 2019
  adreno530: 'ANGLE (Qualcomm, Adreno (TM) 530, OpenGL ES 3.2)',              // S820, 2016
  maliG715:  'ANGLE (ARM, Mali-G715-Immortalis MC11, OpenGL ES 3.2)',         // Tensor G3 / D9200
  maliT880:  'ANGLE (ARM, Mali-T880, OpenGL ES 3.2)',                         // 2016
  appleA11:  'Apple A11 GPU',                                                 // iPhone X
  appleM2:   'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
  irisXe:    'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, OpenGL 4.6)',
  rtx3080:   'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11, D3D11)',
  swift:     'Google SwiftShader',
  m1max:     'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)',
};

/* env stubs: [label, gpu, cssW, cssH, maxTouchPoints, uadMobile|null, ua] */
const IOS_UA   = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD_UA  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const ANDR_UA  = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';
const TAB_UA   = 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const WIN_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MAC_UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const STUBS = [
  ['iPhone 15 Safari',            GPUS.appleGPU,  393, 852, 5, null, IOS_UA,  3],
  ['iPhone, ext withheld',        GPUS.withheld,  393, 852, 5, null, IOS_UA,  3],
  ['iPhone X (A11) Safari',       GPUS.appleA11,  375, 812, 5, null, IOS_UA,  3],
  ['iPhone landscape',            GPUS.appleGPU,  852, 393, 5, null, IOS_UA,  3],
  ['Pixel 8, Adreno 740',         GPUS.adreno740, 412, 915, 5, true, ANDR_UA, 2.63],
  ['Android mid, Mali-G715',      GPUS.maliG715,  412, 892, 5, true, ANDR_UA, 2.63],
  ['S10 era, Adreno 640',         GPUS.adreno640, 412, 869, 5, true, ANDR_UA, 2.63],
  ['2016 handset, Adreno 530',    GPUS.adreno530, 360, 640, 5, true, ANDR_UA, 3],
  ['2016 handset, Mali-T880',     GPUS.maliT880,  360, 640, 5, true, ANDR_UA, 3],
  ['iPad Pro 11 M2 Safari',       GPUS.appleM2,  1194, 834, 5, null, IPAD_UA, 2],
  ['iPad Pro 11, Apple GPU',      GPUS.appleGPU, 1194, 834, 5, null, IPAD_UA, 2],
  ['iPad mini portrait',          GPUS.appleGPU,  768,1024, 5, null, IPAD_UA, 2],
  ['Android tablet, Adreno 740',  GPUS.adreno740,1280, 800, 5, false, TAB_UA, 2],
  ['Surface, Iris Xe, touch',     GPUS.irisXe,   1440, 960, 10, false, WIN_UA, 2],
  ['touch laptop, RTX 3080',      GPUS.rtx3080,  1600, 900, 10, false, WIN_UA, 2],
  ['touch laptop RTX, narrow win', GPUS.rtx3080,   420, 900, 10, false, WIN_UA, 2],
  ['desktop, Iris Xe, no touch',  GPUS.irisXe,   1600, 900, 0, false, WIN_UA, 1],
  ['desktop, RTX 3080',           GPUS.rtx3080,  1920,1080, 0, false, WIN_UA, 1],
  ['MacBook M2, no touch',        GPUS.appleM2,  1600, 900, 0, false, MAC_UA, 2],
  ['this box, M1 Max',            GPUS.m1max,    1600, 900, 0, false, MAC_UA, 2],
  ['desktop, ext withheld',       GPUS.withheld, 1600, 900, 0, false, MAC_UA, 2],
  ['headless SwiftShader',        GPUS.swift,    1600, 900, 0, false, MAC_UA, 1],
];

/* The rows the shipping call is re-checked on, in a REAL page whose
   touch/UA/box the browser itself provides. */
const REAL = [
  ['phone 390x844 touch',   { w: 390,  h: 844,  phone: true },
    ['appleGPU', 'withheld', 'adreno740', 'adreno640', 'maliG715', 'adreno530', 'appleA11', 'appleM2', 'irisXe', 'rtx3080', 'm1max']],
  ['tablet 1194x834 touch', { w: 1194, h: 834,  phone: false, touch: true },
    ['appleGPU', 'appleM2', 'adreno740', 'irisXe', 'rtx3080']],
  ['desktop 1600x900',      { w: 1600, h: 900,  phone: false },
    ['appleGPU', 'withheld', 'appleM2', 'irisXe', 'rtx3080', 'm1max']],
];

const F = (s, n) => String(s).padEnd(n);
console.log('# _j26-tier — pickQuality() driven down every branch on both of its inputs.');
console.log('# rig: headless Chrome (channel chrome), real WebGL2 (ANGLE Metal, Apple M1 Max).');
console.log(`# load (1-min) at start: ${load1()}\n`);

/* ---------- STUB: explicit env, every device box ---------- */
{
  const logs = [];
  const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro&hour=12.5', logs });
  const rows = await page.evaluate(async (stubs) => {
    const mod = await import('./src/core/contracts.js');
    const gl = WALLY.ctx.renderer.getContext();
    const realGet = gl.getParameter.bind(gl), realExt = gl.getExtension.bind(gl);
    const out = [];
    for (const [label, gpu, w, h, mtp, uadMobile, ua, dpr] of stubs) {
      gl.getExtension = (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : realExt(n));
      gl.getParameter = (p) => (p === 0x9246 ? gpu : realGet(p));
      const env = {
        innerWidth: w, innerHeight: h,
        navigator: { maxTouchPoints: mtp, userAgent: ua,
          ...(uadMobile === null ? {} : { userAgentData: { mobile: uadMobile } }) },
        screen: { width: w, height: h },
        location: { search: '' },
      };
      const cls = mod.deviceClass(env);
      let t; try { t = mod.pickQuality(WALLY.ctx.renderer, env); } catch (e) { t = { name: 'THREW ' + e.message }; }
      /* the shipped ceiling formula, evaluated for this device's own
         box and dpr — arithmetic here, cross-checked against the live
         closure in _j26-pr.mjs */
      const budget = Number.isFinite(t.pixelBudget) ? t.pixelBudget : 1.6;
      const byBudget = Math.sqrt((budget * 1e6) / (w * h));
      const ceil = Math.max(1, Math.min(t.pixelRatioMax ?? 1, dpr, byBudget));
      out.push({ label, gpu: gpu || '(withheld)', cls, tier: t.name, msaa: t.msaa, dof: t.dof,
        cascades: t.shadowCascades, grassDist: t.grassDist,
        max: t.pixelRatioMax, budget: t.pixelBudget, dpr,
        ceil: +ceil.toFixed(2), mpx: +((w * ceil) * (h * ceil) / 1e6).toFixed(2),
        mpxAt1: +((w * h) / 1e6).toFixed(2) });
    }
    gl.getParameter = realGet; gl.getExtension = realExt;
    return out;
  }, STUBS);

  console.log('## STUB env — pickQuality(renderer, env), the real module, one row per real device');
  console.log('  ' + F('device', 30) + F('class', 9) + F('tier', 7) + F('msaa', 6) + F('dof', 6) +
    F('casc', 6) + F('grass', 7) + F('prMax', 7) + F('budget', 8) + F('dpr', 6) + F('ceiling', 9) + F('Mpx@ceil', 10) + 'Mpx@1');
  for (const r of rows) {
    console.log('  ' + F(r.label, 30) + F(r.cls, 9) + F(r.tier, 7) + F(r.msaa, 6) + F(r.dof, 6) +
      F(r.cascades, 6) + F(r.grassDist, 7) + F(r.max, 7) + F(r.budget, 8) + F(r.dpr, 6) +
      F(r.ceil, 9) + F(r.mpx, 10) + r.mpxAt1);
  }
  console.log('  page errors:', logs.filter(l => /PAGEERROR/.test(l)).length);
  await close();
}

/* ---------- REAL: the shipping call, in a real emulated context ---------- */
console.log('\n## REAL page — pickQuality(renderer) with NO env, exactly as createContext() calls it');
for (const [label, opts, keys] of REAL) {
  const logs = [];
  const { page, close } = await boot({ ...opts, qs: '?skipIntro&hour=12.5', logs });
  const env = await page.evaluate(ENVSTATE);
  const rows = await page.evaluate(async ({ names, gpus }) => {
    const mod = await import('./src/core/contracts.js');
    const gl = WALLY.ctx.renderer.getContext();
    const realGet = gl.getParameter.bind(gl), realExt = gl.getExtension.bind(gl);
    const out = [];
    for (const k of names) {
      const gpu = gpus[k];
      gl.getExtension = (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : realExt(n));
      gl.getParameter = (p) => (p === 0x9246 ? gpu : realGet(p));
      let t; try { t = mod.pickQuality(WALLY.ctx.renderer); } catch (e) { t = { name: 'THREW ' + e.message }; }
      out.push({ k, tier: t.name, msaa: t.msaa, max: t.pixelRatioMax, budget: t.pixelBudget });
    }
    gl.getParameter = realGet; gl.getExtension = realExt;
    const cls = mod.deviceClass();
    return { out, cls };
  }, { names: keys, gpus: GPUS });

  console.log(`\n  ${label}  ->  deviceClass()='${rows.cls}'   ` +
    `innerWidth ${env.innerWidth}x${env.innerHeight}  maxTouchPoints ${env.maxTouchPoints}  ` +
    `ontouchstart ${env.onTouchStart}  uad.mobile ${env.uadMobile}  boot tier '${env.tier}'`);
  console.log('    UA: ' + env.ua);
  console.log('    ' + F('gpu string', 12) + F('tier', 8) + F('msaa', 6) + F('prMax', 7) + 'budget');
  for (const r of rows.out) console.log('    ' + F(r.k, 12) + F(r.tier, 8) + F(r.msaa, 6) + F(r.max, 7) + r.budget);
  console.log('    page errors:', logs.filter(l => /PAGEERROR/.test(l)).length);
  await close();
}
console.log(`\n# load (1-min) at end: ${load1()}`);
