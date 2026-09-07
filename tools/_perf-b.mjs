/* _perf-b.mjs — ABLATION. One boot, one site, N states. Each state is
   applied, settled, sampled, then reverted, and the whole sweep runs
   twice so a drifting scene shows up as disagreement between rounds. */
import { boot, INJECT, NAMEHANDLES, sample } from './_perf-lib.mjs';

const argv = process.argv.slice(2);
const W = +(argv.find(a => a.startsWith('--w='))?.slice(4) ?? 1600);
const H = +(argv.find(a => a.startsWith('--h='))?.slice(4) ?? 900);
const SITE = argv.find(a => a.startsWith('--site='))?.slice(7) ?? 'cafe';
const DUR = +(argv.find(a => a.startsWith('--dur='))?.slice(6) ?? 2200);
const ROUNDS = +(argv.find(a => a.startsWith('--rounds='))?.slice(9) ?? 2);
const ONLY = argv.find(a => a.startsWith('--only='))?.slice(7) ?? null;
const EXTRA = +(argv.find(a => a.startsWith('--extra='))?.slice(8) ?? 0);

const STATES = {
  base:      ['', ''],
  noOutline: [`WALLY.ctx.mat.setOutline({ minPx: 1e9 })`, `WALLY.ctx.mat.setOutline({ minPx: 9 })`],
  noShadow:  [`(()=>{const s=WALLY.ctx.renderer.shadowMap; if(!s.__ab){s.__ab=Object.getOwnPropertyDescriptor(s,'needsUpdate')||{value:true,writable:true};}
                Object.defineProperty(s,'needsUpdate',{get:()=>false,set:()=>{},configurable:true}); return 1;})()`,
              `(()=>{const s=WALLY.ctx.renderer.shadowMap; Object.defineProperty(s,'needsUpdate',{value:true,writable:true,configurable:true}); return 1;})()`],
  noSSAO:    [`WALLY.ctx.render.post.params.ssao=false`, `WALLY.ctx.render.post.params.ssao=true`],
  noBloom:   [`WALLY.ctx.render.post.params.bloom=false`, `WALLY.ctx.render.post.params.bloom=true`],
  noDOF:     [`WALLY.ctx.render.post.params.dof=false`, `WALLY.ctx.render.post.params.dof=true`],
  noFXAA:    [`WALLY.ctx.render.post.params.fxaa=false`, `WALLY.ctx.render.post.params.fxaa=true`],
  noPost:    [`WALLY.debug.post(false)`, `WALLY.debug.post(true)`],
  noGrass:   [`(()=>{const o=WALLY.ctx.scene.getObjectByName('foliage.chunks'); if(o)o.visible=false; return !!o;})()`,
              `(()=>{const o=WALLY.ctx.scene.getObjectByName('foliage.chunks'); if(o)o.visible=true; return !!o;})()`],
  noTrees:   [`(()=>{const o=WALLY.ctx.scene.getObjectByName('foliage.trees'); if(o)o.visible=false; return !!o;})()`,
              `(()=>{const o=WALLY.ctx.scene.getObjectByName('foliage.trees'); if(o)o.visible=true; return !!o;})()`],
  noNPC:     [`(()=>{const o=WALLY.ctx.scene.getObjectByName('npc'); if(o)o.visible=false; return !!o;})()`,
              `(()=>{const o=WALLY.ctx.scene.getObjectByName('npc'); if(o)o.visible=true; return !!o;})()`],
  noProps:   [`(()=>{const o=WALLY.ctx.scene.getObjectByName('city.propsRoot'); if(o)o.visible=false; return !!o;})()`,
              `(()=>{const o=WALLY.ctx.scene.getObjectByName('city.propsRoot'); if(o)o.visible=true; return !!o;})()`],
  aoUnfold:  [`WALLY.ctx.render.post.params.aoFold=false`, `WALLY.ctx.render.post.params.aoFold=true`],
  aoMax45:   [`WALLY.ctx.render.post.materials.ssao.uniforms.uMaxDist.value=45`,
              `WALLY.ctx.render.post.materials.ssao.uniforms.uMaxDist.value=90`],
  aoMax28:   [`WALLY.ctx.render.post.materials.ssao.uniforms.uMaxDist.value=28`,
              `WALLY.ctx.render.post.materials.ssao.uniforms.uMaxDist.value=90`],
  aoR05:     [`WALLY.ctx.render.post.materials.ssao.uniforms.uRadius.value=0.5`,
              `WALLY.ctx.render.post.materials.ssao.uniforms.uRadius.value=0.9`],
  noWater:   [`(()=>{const o=WALLY.ctx.scene.getObjectByName('water'); if(o)o.visible=false; return !!o;})()`,
              `(()=>{const o=WALLY.ctx.scene.getObjectByName('water'); if(o)o.visible=true; return !!o;})()`],
};

const logs = [];
const { page, close } = await boot({ w: W, h: H, logs });
await page.evaluate(NAMEHANDLES);
await page.evaluate(INJECT);
await page.evaluate((l) => { const d = window.WALLY.debug; d.arrive(l, true); d.arriveNow && d.arriveNow(); }, SITE);
await page.waitForTimeout(2500);
await page.evaluate((n) => { window.__PROF__.extra = n; }, EXTRA);

const keys = Object.keys(STATES).filter(k => !ONLY || ONLY.split(',').includes(k) || k === 'base');
const rows = {};
for (let r = 0; r < ROUNDS; r++) {
  for (const k of keys) {
    const [on, off] = STATES[k];
    if (on) await page.evaluate(on).catch(e => console.log(`  ${k} on failed: ${e.message}`));
    await page.waitForTimeout(500);
    const s = await sample(page, DUR);
    if (off) await page.evaluate(off).catch(() => {});
    (rows[k] ||= []).push(s);
    console.log(`r${r} ${k.padEnd(10)} gpu ${String(s.gpuMs).padStart(6)} ms  renderCPU ${String(s.renderCpuPer).padStart(6)}  cpuTot ${String(s.cpuTotal).padStart(5)}  calls ${String(s.calls).padStart(5)}  tris ${s.tris}`);
  }
}
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const B = rows.base;
const bg = med(B.map(s => s.gpuMs)), bc = med(B.map(s => s.renderCpuPer ?? 0));
console.log('\n--- medians over ' + ROUNDS + ' rounds, delta vs base ---');
for (const k of keys) {
  const g = med(rows[k].map(s => s.gpuMs)), c = med(rows[k].map(s => s.renderCpuPer ?? 0));
  const ca = med(rows[k].map(s => s.calls)), tr = med(rows[k].map(s => s.tris));
  console.log(`${k.padEnd(10)} gpu ${String(g).padStart(6)} (${(g - bg >= 0 ? '+' : '') + (g - bg).toFixed(2)})  renderCPU ${String(c).padStart(6)} (${(c - bc >= 0 ? '+' : '') + (c - bc).toFixed(2)})  calls ${ca}  tris ${tr}`);
}
const errs = logs.filter(l => /PAGEERROR|\[error\]/.test(l));
if (errs.length) console.log('\nERRORS:\n' + errs.slice(0, 6).join('\n'));
await close();
