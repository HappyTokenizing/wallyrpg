#!/usr/bin/env node
/* ============================================================
   _fa-tier.mjs — WHICH TIER DOES A REAL PHONE GET?

   The fixer reported "mobile still runs quality tier 'high'" at
   390x844. That is TRUE of the rig and says nothing about a phone,
   because pickQuality() in contracts.js reads exactly one thing:

       gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)

   — the GPU string. Not innerWidth, not devicePixelRatio, not
   maxTouchPoints, not the UA. So a 390x844 window on an M1 Max matches
   /apple m[1-9]/ and gets 'high' no matter how phone-shaped it is, and
   NO measurement in this project has ever exercised the branch a real
   handset takes.

   This drives the real function down each branch by patching
   getParameter to return a real device's string, then calling
   pickQuality() itself. It imports the shipped module — no copy of the
   regexes lives here, so it cannot go stale against them.
   ============================================================ */
import { boot } from './_sm-lib.mjs';

const { page, close } = await boot({ w: 390, h: 844, qs: '?skipIntro', limiter: true });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });

const STRINGS = [
  ['iPhone / iPad, Safari 15+', 'Apple GPU'],
  ['iPhone, older Safari', 'Apple A13 GPU'],
  ['iPad Pro M2, Safari', 'Apple M2'],
  ['Android flagship, Chrome', 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)'],
  ['Android mid, Chrome', 'ANGLE (ARM, Mali-G78 MP14, OpenGL ES 3.2)'],
  ['Pixel, Chrome', 'ANGLE (Google, Vulkan 1.3.0 (Adreno (TM) 730), SwiftShader driver)'],
  ['this rig (headless on M1 Max)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)'],
  ['MacBook Air M2, Chrome', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'],
  ['old Intel laptop', 'ANGLE (Intel, Intel(R) UHD Graphics 620, OpenGL 4.1)'],
  ['desktop RTX', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11, D3D11)'],
];

const out = await page.evaluate(async (strings) => {
  const mod = await import('./src/core/contracts.js');
  const gl = WALLY.ctx.renderer.getContext();
  const realGet = gl.getParameter.bind(gl);
  const realExt = gl.getExtension.bind(gl);
  const rows = [];
  for (const [label, name] of strings) {
    gl.getExtension = (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : realExt(n));
    gl.getParameter = (p) => (p === 0x9246 ? name : realGet(p));
    const t = mod.pickQuality(WALLY.ctx.renderer);
    rows.push({ label, name, tier: t.name, pixelRatio: t.pixelRatio, msaa: t.msaa, ssao: t.ssao, dof: t.dof,
      cascades: t.shadowCascades, shadow: t.shadowSize, grassDist: t.grassDist });
  }
  gl.getParameter = realGet; gl.getExtension = realExt;
  return rows;
}, STRINGS);

console.log('# pickQuality() driven down each branch, real module, patched UNMASKED_RENDERER_WEBGL');
console.log('# NOTE: pickQuality reads the GPU string and NOTHING else — no viewport, no devicePixelRatio, no UA.\n');
console.log('  ' + 'device'.padEnd(32) + 'tier'.padEnd(9) + 'pxRatio'.padEnd(9) + 'msaa'.padEnd(6) + 'ssao'.padEnd(7) + 'dof'.padEnd(6) + 'cascades'.padEnd(10) + 'shadow'.padEnd(8) + 'grassDist');
for (const r of out) {
  console.log('  ' + r.label.padEnd(32) + String(r.tier).padEnd(9) + String(r.pixelRatio).padEnd(9) + String(r.msaa).padEnd(6) +
    String(r.ssao).padEnd(7) + String(r.dof).padEnd(6) + String(r.cascades).padEnd(10) + String(r.shadow).padEnd(8) + r.grassDist);
}
await close();
