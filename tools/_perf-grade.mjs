/* _perf-grade.mjs — tune the night grade against a measurement, not a
   memory. One boot, one framing, N candidate grades, a PNG and a
   histogram for each. */
import { boot } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
const argv = process.argv.slice(2);
const SITE = argv.find(a => a.startsWith('--site='))?.slice(7) ?? 'cafe';
const HOUR = +(argv.find(a => a.startsWith('--hour='))?.slice(7) ?? 22);
const GRADE = argv.find(a => a.startsWith('--grade='))?.slice(8) ?? 'night';
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, logs });
await mkdir('shots/qp', { recursive: true }).catch(() => {});
await page.evaluate((l) => { const d = window.WALLY.debug; d.arrive(l, true); d.arriveNow && d.arriveNow(); }, SITE);
await page.evaluate((h) => window.WALLY.debug.setHour(h), HOUR);
await page.waitForTimeout(2200);

/* LIFT IS LINEAR-LIGHT AND THE FRAME IS sRGB-ENCODED AFTER IT. A lift
   of 0.018 is not a nudge: 0.018 linear lands at 0.128 on screen. The
   first sweep put every candidate's black point at sRGB 0.12 and read
   as fog. These are the sRGB-aware numbers. */
const CANDS = [
  ['base',  null],
  ['n1', { lift: [0.0030, 0.0038, 0.0140], contrast: 1.09, exposure: 0.84 }],
  ['n2', { lift: [0.0050, 0.0060, 0.0165], contrast: 1.06, exposure: 0.86 }],
  ['n3', { lift: [0.0075, 0.0085, 0.0190], contrast: 1.04, exposure: 0.88 }],
  ['n4', { lift: [0.0050, 0.0060, 0.0165], contrast: 1.06, exposure: 0.86, sat: 0.92 }],
];
for (const [name, o] of CANDS) {
  await page.evaluate(([g, patch]) => {
    const G = window.WALLY.ctx.render.grades[g];
    if (!window.__G0__) window.__G0__ = JSON.parse(JSON.stringify(G));
    Object.assign(G, JSON.parse(JSON.stringify(window.__G0__)));
    if (patch) Object.assign(G, patch);
    window.WALLY.ctx.render.setGrade(g);
  }, [GRADE, o]);
  await page.waitForTimeout(500);
  const f = `shots/qp/g-${GRADE}-${name}.png`;
  await page.screenshot({ path: f, animations: 'allow' });
  console.log(`${name} ${JSON.stringify(o)}`);
}
await close();
