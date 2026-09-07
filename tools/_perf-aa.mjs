/* _perf-aa.mjs — ALIASING, MEASURED AGAINST A SUPERSAMPLED REFERENCE.
   One boot per configuration (msaa is a render-target property, fixed
   at init), same doorstep, same hour, same framing. The 2x run is the
   reference: box-downsampled it is a 4x-supersampled ground truth. */
import { boot } from './_perf-lib.mjs';
import { INJECT, NAMEHANDLES, sample } from './_perf-lib.mjs';
import { mkdir } from 'node:fs/promises';
const argv = process.argv.slice(2);
const SITE = argv.find(a => a.startsWith('--site='))?.slice(7) ?? 'cafe';
const CONFIGS = (argv.find(a => a.startsWith('--set='))?.slice(6) ?? '0,2,4,ref').split(',');
await mkdir('shots/qp', { recursive: true }).catch(() => {});

for (const c of CONFIGS) {
  const ref = c === 'ref';
  const MW = +(argv.find(a => a.startsWith('--vw='))?.slice(5) ?? 1600), MH = +(argv.find(a => a.startsWith('--vh='))?.slice(5) ?? 900);
  const w = ref ? MW * 2 : MW, h = ref ? MH * 2 : MH;
  const qs = `?shot=1&msaa=${ref ? 0 : c}`;
  const logs = [];
  const { page, close } = await boot({ w, h, qs, logs });
  await page.evaluate(NAMEHANDLES); await page.evaluate(INJECT);
  await page.evaluate((l) => { const d = window.WALLY.debug; d.arrive(l, true); d.arriveNow && d.arriveNow(); }, SITE);
  await page.evaluate(() => window.WALLY.debug.setHour(12.5));
  await page.waitForTimeout(2600);
  await page.evaluate(() => { window.__PROF__.extra = 3; });
  const s = await sample(page, 2200);
  await page.screenshot({ path: `shots/qp/aa-${c}.png`, animations: 'allow' });
  const tier = await page.evaluate(() => ({ q: window.WALLY.ctx.quality.name, msaa: window.WALLY.ctx.quality.msaa,
    samples: window.WALLY.ctx.render.targets.scene.samples }));
  console.log(`msaa=${c} ${w}x${h}  tier ${tier.q} msaa ${tier.msaa} rtSamples ${tier.samples}  gpu ${s.gpuMs} ms  renderCPU ${s.renderCpuPer} ms  calls ${s.calls} tris ${s.tris}`);
  const errs = logs.filter(l => /PAGEERROR|\[error\]/.test(l));
  if (errs.length) console.log('  ERRORS ' + errs.slice(0, 3).join(' | '));
  await close();
}
