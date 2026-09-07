/* _perf-a.mjs — PROFILE FIRST. Five loads, one boot each where the
   viewport differs. Reports fps / frame ms / GPU ms / calls / tris and
   a per-module CPU table. */
import { boot, INJECT, NAMEHANDLES, sample } from './_perf-lib.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const W = +(argv.find(a => a.startsWith('--w='))?.slice(4) ?? 1600);
const H = +(argv.find(a => a.startsWith('--h='))?.slice(4) ?? 900);
const ONLY = argv.find(a => a.startsWith('--site='))?.slice(7) ?? null;
const SETTLE = +(argv.find(a => a.startsWith('--settle='))?.slice(9) ?? 2200);
const DUR = +(argv.find(a => a.startsWith('--dur='))?.slice(6) ?? 3000);

const logs = [];
const MSAA = argv.find(a => a.startsWith('--msaa='))?.slice(7) ?? null;
const { page, close } = await boot({ w: W, h: H, logs, qs: MSAA == null ? '?shot=1' : `?shot=1&msaa=${MSAA}` });
await page.evaluate(NAMEHANDLES);
await page.evaluate(INJECT);

/* THE DOORSTEP, NOT THE ZONE ANCHOR. Warping to ZONES[z].world puts
   the capsule INSIDE a building and the boom inside its wall — a full
   screen of interior stucco that measures nothing the player ever
   sees. d.arrive() is the game's own arrival placement, in front of a
   real door, with the gameplay camera. */
const AT = async (loc) => page.evaluate((l) => {
  const d = window.WALLY.debug;
  d.releaseCamera && d.releaseCamera();
  d.arrive(l, true); d.arriveNow && d.arriveNow();
  const p = window.WALLY.ctx.wally.position || window.WALLY.ctx.wally.root?.position;
  return { at: l, pos: p ? [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)] : null };
}, loc);

const SITES = {
  street:  async () => AT('cafe'),          // Main Street, the busiest
  market:  async () => AT('markethall'),    // Market Square
  quiet:   async () => AT('farmcoop'),      // Green Edge, the quiet one
  docks:   async () => AT('docks'),         // waterfront: sky+water
  indoors: async () => { const r = await AT('apartment');
    await page.evaluate(() => window.WALLY.debug.ui('place', 'apartment')); return { ...r, sheet: 'place' }; },
  balloon: async () => { await AT('cafe');
    await page.evaluate(() => { window.WALLY.debug.ui('hud'); });
    return page.evaluate(() => { window.WALLY.debug.balloon({ alt: 120 }); return 'balloon alt120'; }); },
};

const out = {};
for (const [name, fn] of Object.entries(SITES)) {
  if (ONLY && !ONLY.split(',').includes(name)) continue;
  const where = await fn().catch(e => ({ err: String(e.message) }));
  await page.waitForTimeout(SETTLE);
  const r = await sample(page, DUR);
  await page.evaluate(() => { window.__PROF__.extra = 3; });
  await page.waitForTimeout(700);
  const g = await sample(page, 2400);
  await page.evaluate(() => { window.__PROF__.extra = 0; });
  r.gpuMsSat = g.gpuMs; r.renderCpuPerSat = g.renderCpuPer;
  out[name] = { where, ...r };
  console.log(`\n== ${name} @ ${W}x${H} ==`, JSON.stringify(where));
  console.log(`  fps ${r.fps}  frame ${r.wallMs} ms  gpu(vsync) ${r.gpuMs} ms  gpu(saturated) ${r.gpuMsSat} ms  renderCPU ${r.renderCpuPer} ms`);
  console.log(`  calls ${r.calls}  tris ${r.tris}  cpuTotal ${r.cpuTotal} ms`);
  console.log(`  cpu: ${JSON.stringify(r.cpu)}`);
}
if (has('--json')) console.log('\nJSON ' + JSON.stringify(out));
const errs = logs.filter(l => /PAGEERROR|\[error\]/.test(l));
if (errs.length) console.log('\nERRORS:\n' + errs.slice(0, 10).join('\n'));
await close();
