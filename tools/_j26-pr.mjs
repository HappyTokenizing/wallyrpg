#!/usr/bin/env node
/* ============================================================
   _j26-pr.mjs — WHAT PIXEL RATIO AND WHAT DRAWING BUFFER, REALLY.

   The claim under test is that the frame no longer renders 390x844 on
   a 1170x2532 phone. The previous state was: renderer.getPixelRatio()
   was 1 at devicePixelRatio 1, 2 AND 3, backing store 390x844 in all
   three. So this reports, per (viewport x dpr):

     BOOT      what the very first frames render at, before the
               governor has any evidence — the frame that shipped
               before the governor existed. It must still be 1.
     SETTLED   what it converges to after ~14 s of unloaded frames,
               and the governor's own decision log.
     CEILING   pixelRatioCeiling(cssW,cssH) read out of the LIVE
               closure through WALLY.debug.viewport(), not
               re-implemented here.

   The drawing buffer is read from the GL context
   (gl.drawingBufferWidth/Height) as well as canvas.width/height and
   the scene render target, because those three going out of step with
   each other IS the landscape bug this project already shipped once.

   devicePixelRatio is the browser's, set by deviceScaleFactor at
   context creation — not faked. A faked one would not move the
   compositor and would prove nothing about the delivered image.
   ============================================================ */
import { boot, ENVSTATE, sleep, load1, loadGate } from './_j26-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SETTLE = +arg('settle', 14000);
const PLACE = arg('place', 'mainstreet');
const MAXLOAD = +arg('maxload', 4);

const VIEWPORTS = [
  { label: 'phone   390x844  (touch, mobile UA)', w: 390, h: 844, phone: true },
  { label: 'desktop 1600x900 (no touch)', w: 1600, h: 900, phone: false },
];
const DPRS = [1, 2, 3];

const S = (o) => `${o.buffer[0]}x${o.buffer[1]}`;
const F = (s, n) => String(s).padEnd(n);

console.log('# _j26-pr — pixel ratio and drawing buffer, at devicePixelRatio 1/2/3, phone and desktop.');
console.log('# rig: headless Chrome (channel chrome), real WebGL2 ANGLE Metal on Apple M1 Max, 10 cores.');
console.log(`# ?skipIntro&hour=12.5, arrive('${PLACE}'), governor ON (it is only off under ?shot).`);
console.log('# BOOT is read immediately after arrival; SETTLED after ' + (SETTLE / 1000) + ' s of frames.');
console.log('# GOVERNOR IS TIME-SENSITIVE: a loaded box makes frames late and the governor will refuse');
console.log('# to lift. Load is gated to <= ' + MAXLOAD + ' before each viewport and printed for every row.\n');

for (const V of VIEWPORTS) {
  for (const dpr of DPRS) {
    const l0 = await loadGate(MAXLOAD);
    const logs = [];
    const { page, close } = await boot({ w: V.w, h: V.h, phone: V.phone, dpr, logs, qs: '?skipIntro&hour=12.5' });
    await sleep(5000);
    await page.evaluate((p) => { try { WALLY.debug.arrive(p, true); } catch (e) {} }, PLACE);
    await sleep(4000);

    const env = await page.evaluate(ENVSTATE);
    const glLimit = await page.evaluate(() => {
      const g = WALLY.ctx.renderer.getContext();
      return Math.min(g.getParameter(g.MAX_TEXTURE_SIZE), g.getParameter(g.MAX_RENDERBUFFER_SIZE));
    });
    const bootS = await page.evaluate(() => ({
      vp: WALLY.debug.viewport(),
      gov: WALLY.debug.governorState(),
      gl: (() => { const g = WALLY.ctx.renderer.getContext(); return [g.drawingBufferWidth, g.drawingBufferHeight]; })(),
      canvas: [WALLY.ctx.renderer.domElement.width, WALLY.ctx.renderer.domElement.height],
      cssBox: [WALLY.ctx.renderer.domElement.clientWidth, WALLY.ctx.renderer.domElement.clientHeight],
    }));
    await sleep(SETTLE);
    const setS = await page.evaluate(() => ({
      vp: WALLY.debug.viewport(),
      gov: WALLY.debug.governorState(),
      gl: (() => { const g = WALLY.ctx.renderer.getContext(); return [g.drawingBufferWidth, g.drawingBufferHeight]; })(),
      canvas: [WALLY.ctx.renderer.domElement.width, WALLY.ctx.renderer.domElement.height],
      cssBox: [WALLY.ctx.renderer.domElement.clientWidth, WALLY.ctx.renderer.domElement.clientHeight],
    }));
    const l1 = load1();

    console.log(`=== ${V.label}   deviceScaleFactor ${dpr}`);
    console.log(`    page: innerWidth ${env.innerWidth}x${env.innerHeight}  devicePixelRatio ${env.dpr}  ` +
      `maxTouchPoints ${env.maxTouchPoints}  uad.mobile ${env.uadMobile}`);
    console.log(`    tier '${env.tier}'  pixelRatioMax ${env.pixelRatioMax}  pixelBudget ${env.pixelBudget} Mpx  ` +
      `msaa ${env.msaa}   GL_LIMIT ${glLimit}`);
    console.log('    ' + F('phase', 9) + F('getPixelRatio', 15) + F('gl.drawingBuffer', 18) + F('canvas', 12) +
      F('sceneRT', 12) + F('Mpx', 7) + F('cssBox', 11) + F('ceiling', 9) + F('step', 6) + F('cap', 5) + F('inSync', 8) + 'load');
    for (const [nm, s, ld] of [['BOOT', bootS, l0], ['SETTLED', setS, l1]]) {
      console.log('    ' + F(nm, 9) + F(s.vp.pixelRatio, 15) + F(s.gl.join('x'), 18) + F(s.canvas.join('x'), 12) +
        F(s.vp.sceneRT.join('x'), 12) + F(((s.canvas[0] * s.canvas[1]) / 1e6).toFixed(3), 7) +
        F(s.cssBox.join('x'), 11) + F(s.vp.prCeiling, 9) + F(s.gov.step, 6) + F(s.gov.cap, 5) +
        F(String(s.vp.inSync), 8) + ld);
    }
    const physical = [Math.round(V.w * env.dpr), Math.round(V.h * env.dpr)];
    console.log(`    physical panel would be ${physical.join('x')} = ${((physical[0] * physical[1]) / 1e6).toFixed(2)} Mpx;  ` +
      `settled buffer is ${((setS.canvas[0] * setS.canvas[1]) / (physical[0] * physical[1]) * 100).toFixed(0)} % of it`);
    console.log('    governor log: ' + (setS.gov.log.length ? JSON.stringify(setS.gov.log) : '(no moves)') +
      `   ignored ${setS.gov.ignored}  inWindow ${setS.gov.inWindow}  lateInWindow ${setS.gov.lateInWindow}`);
    const errs = logs.filter(l => /PAGEERROR/.test(l));
    console.log('    page errors: ' + errs.length + (errs.length ? ' ' + errs[0] : ''));
    console.log('');
    await close();
  }
}
console.log(`# load (1-min) at end: ${load1()}`);
