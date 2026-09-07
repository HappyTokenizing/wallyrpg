#!/usr/bin/env node
/* _j31-landscape.mjs — JUDGE 31. inSync at five desktop shapes AND on a
   REAL phone, under BOTH sizing rules on one page load, plus three
   deliberate desynchronisations.

   WHY NOT JUST RE-RUN _k30-insync: its 390x844 row is booted with
   phone:false, so navigator.maxTouchPoints is 0 and deviceClass()
   returns 'desktop' — that row is a narrow desktop window, not a
   phone, and it has never exercised the med tier's ceiling. This adds
   the real one (hasTouch + isMobile + Pixel 7 UA, dsf 3).

   THE CONTROLS. inSync now has THREE clauses (canvas.w === floor,
   canvas.h === floor, rtScene === canvas). mobilebugs VP-4 breaks the
   first two only. D2 below breaks the THIRD and nothing else — the
   post chain running at a different size than the surface, which is
   the exact bug the clause was added for. */
import { boot, sleep, load1, ENVSTATE } from './_j26-lib.mjs';

const SHAPES = [
  { w: 844, h: 390, dsf: 3, phone: true  },
  { w: 390,  h: 844, dsf: 3, phone: true  },
];
const F = (s, n) => String(s).padEnd(n);

console.log('# _j31-landscape — headless Chrome channel=chrome, ANGLE Metal, M1 Max. Governor takes its own notch (3x governorStep, no override).');
console.log('# floor = Math.floor(css*pr) = what three.js allocates and what SHIPS. round = the rule it replaced.');
console.log('');
console.log('  ' + F('css box', 11) + F('kind', 8) + F('dsf', 5) + F('tier', 7) + F('ceil', 8) +
  F('pixelRatio', 20) + F('buffer', 12) + F('sceneRT', 12) + F('want(floor)', 13) + F('want(round)', 13) +
  F('inSync fl', 11) + F('inSync rd', 11) + 'slack CSS px');

const bad = [];
for (const S of SHAPES) {
  const l0 = load1();
  const logs = [];
  const { page, close } = await boot({ w: S.w, h: S.h, dpr: S.dsf, phone: S.phone, logs, qs: '?skipIntro&hour=12.5' });
  await sleep(6000);
  const env = await page.evaluate(ENVSTATE);
  await page.evaluate(() => { for (let i = 0; i < 3; i++) WALLY.debug.governorStep(+1); });
  await sleep(1500);
  const r = await page.evaluate(async () => {
    const V = () => WALLY.debug.viewport();
    const sl = (ms) => new Promise(x => setTimeout(x, ms));
    WALLY.debug.governor(false);
    const probe = async (rule) => {
      WALLY.debug.sizeRule(rule); await sl(150);
      const before = V().resyncs;
      for (let i = 0; i < 20; i++) WALLY.debug.syncViewport(false);
      return { vp: V(), rebuilds: V().resyncs - before };
    };
    const fl = await probe('floor');
    const rd = await probe('round');
    WALLY.debug.sizeRule('floor'); await sl(150);
    return { fl, rd, back: V(), cls: WALLY.ctx.quality.name };
  });
  const kind = S.phone ? 'PHONE' : 'desktop';
  console.log('  ' + F(`${S.w}x${S.h}`, 11) + F(kind, 8) + F(S.dsf, 5) + F(env.tier, 7) + F(r.fl.vp.prCeiling, 8) +
    F(r.fl.vp.pixelRatio, 20) + F(r.fl.vp.buffer.join('x'), 12) + F(r.fl.vp.sceneRT.join('x'), 12) +
    F(r.fl.vp.want.join('x'), 13) + F(r.rd.vp.want.join('x'), 13) +
    F(String(r.fl.vp.inSync), 11) + F(String(r.rd.vp.inSync), 11) + JSON.stringify(r.fl.vp.slackCss));
  console.log('      ' + `maxTouchPoints ${env.maxTouchPoints}  uadMobile ${env.uadMobile}  dpr ${env.dpr}  ` +
    `20 idle polls rebuilt the chain: floor ${r.fl.rebuilds}x  round ${r.rd.rebuilds}x  ` +
    `load ${l0}->${load1()}  pageerrors ${logs.filter(l => /PAGEERROR/.test(l)).length}`);
  if (r.fl.vp.inSync !== true) bad.push(`${S.w}x${S.h} floor`);

  /* ---- the three deliberate desynchronisations ---- */
  const D = await page.evaluate(async () => {
    const V = () => WALLY.debug.viewport();
    const sl = (ms) => new Promise(x => setTimeout(x, ms));
    const out = {};
    WALLY.debug.viewportAuto(false);
    out.healthy = V();
    /* D1 canvas stale: half-size backing store, CSS box untouched */
    WALLY.ctx.renderer.setSize(Math.round(out.healthy.css[0] / 2), Math.round(out.healthy.css[1] / 2), false);
    out.d1 = V();
    WALLY.debug.viewportAuto(true); WALLY.debug.syncViewport(true); await sl(300);
    out.d1heal = V();
    /* D2 SCENE TARGET ONLY: canvas untouched and correct, the post
       chain's target moved. The clause VP-4 cannot reach. */
    WALLY.debug.viewportAuto(false);
    const rt = WALLY.ctx.render.targets.scene;
    const was = [rt.width, rt.height];
    rt.setSize(was[0] - 8, was[1] - 8);
    out.d2 = V(); out.d2was = was;
    out.d2canvasOK = (V().buffer[0] === V().want[0] && V().buffer[1] === V().want[1]);
    WALLY.debug.viewportAuto(true); WALLY.debug.syncViewport(true); await sl(300);
    out.d2heal = V();
    /* D3 ratio moved under a correct canvas: setPixelRatio only, no
       setSize. css and canvas unchanged, want moves. */
    WALLY.debug.viewportAuto(false);
    WALLY.ctx.renderer.setPixelRatio(V().pixelRatio * 1.37);
    out.d3 = V();
    WALLY.debug.viewportAuto(true); WALLY.debug.syncViewport(true); await sl(300);
    out.d3heal = V();
    return out;
  });
  const ok = (x) => x ? 'PASS' : '**FAIL**';
  console.log('      D1 canvas half-size behind the reconciler : inSync ' + D.healthy.inSync + ' -> ' +
    D.d1.inSync + ` (buffer ${D.d1.buffer.join('x')} vs want ${D.d1.want.join('x')})` +
    ' -> healed ' + D.d1heal.inSync + '   ' + ok(D.healthy.inSync === true && D.d1.inSync === false && D.d1heal.inSync === true));
  console.log('      D2 sceneRT only, canvas untouched         : inSync ' + D.d2.inSync +
    ` (canvas still matches want: ${D.d2canvasOK};  sceneRT ${D.d2was.join('x')} -> ${D.d2.sceneRT.join('x')}, canvas ${D.d2.buffer.join('x')})` +
    ' -> healed ' + D.d2heal.inSync + '   ' + ok(D.d2.inSync === false && D.d2canvasOK === true && D.d2heal.inSync === true));
  console.log('      D3 pixelRatio x1.37, no setSize           : inSync ' + D.d3.inSync +
    ` (pr ${D.d3.pixelRatio.toFixed(4)}, buffer ${D.d3.buffer.join('x')}, want ${D.d3.want.join('x')})` +
    ' -> healed ' + D.d3heal.inSync + '   ' + ok(D.d3.inSync === false && D.d3heal.inSync === true));
  if (!(D.d1.inSync === false && D.d2.inSync === false && D.d3.inSync === false)) bad.push(`${S.w}x${S.h} control`);
  console.log('');
  await close();
}
console.log(bad.length ? `# UNHEALTHY ROWS: ${bad.join(', ')}` : '# every shape reads inSync TRUE on a healthy frame, and FALSE on all three deliberate desyncs.');
console.log(`# load (1-min) at end: ${load1()}`);
