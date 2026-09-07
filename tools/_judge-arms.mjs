#!/usr/bin/env node
/* JUDGE'S OWN INSTRUMENT for the C->D cut.
   Independent of tools/introhandover.mjs on purpose:
     · QUATERNIONS, not per-axis Euler. A shoulder near gimbal can move
       30 deg of euler-x for 2 deg of actual rotation, and the reverse.
       Reported as the true geodesic angle between orientations.
     · The DISCONTINUITY is the angle between the last cinematic frame
       and the first non-cinematic one, in degrees, per joint —
       the literal thing asked for — beside the median frame-to-frame
       angle over the 0.4 s before the cut, which is what a healthy
       frame costs on this machine at this load.
     · Both euler-max (introhandover's statistic) and quat angle are
       reported so the two instruments can be compared.
   node tools/_judge-arms.mjs                 all five cases
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome',
  args: ['--enable-unsafe-swiftshader','--hide-scrollbars','--autoplay-policy=user-gesture-required'] });

const JOINTS = ['armL0','armL1','handL','armR0','armR1','handR'];
const seedSave = (id) => `(() => { try { localStorage.setItem('wally_rpg_save_v7',
  JSON.stringify({ version: 6, rides: { owned: { ${id}: true }, equipped: '${id}' } })); } catch (e) {} })()`;

const OUT = [];
async function run(label, ride) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  if (ride) await ctx.addInitScript(seedSave(ride));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
  const rides = await page.evaluate(() => { try { return WALLY.ctx.game.actions.rides()
    .map(r => `${r.id}${r.owned?'+':'-'}${r.equipped?'E':''}`).join(' '); } catch(e){ return null; } });

  await page.evaluate((names) => {
    const w = WALLY.ctx.wally;
    window.__Q = [];
    let last = performance.now();
    const tick = () => {
      const n = performance.now();
      const r = { dt: (n-last)/1000,
        t: WALLY.ctx.intro ? WALLY.ctx.intro.time : -1,
        cam: (WALLY.ctx.cam && WALLY.ctx.cam.mode) || '',
        q: [], e: [] };
      last = n;
      for (const nm of names) {
        const b = w.bones[nm];
        if (b) { r.q.push(b.quaternion.x,b.quaternion.y,b.quaternion.z,b.quaternion.w);
                 r.e.push(b.rotation.x*57.2958,b.rotation.y*57.2958,b.rotation.z*57.2958); }
        else { r.q.push(0,0,0,1); r.e.push(0,0,0); }
      }
      window.__Q.push(r);
      if (window.__Q.length < 6000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, JOINTS);

  // gate: only click if the opener did not start itself. NEVER Space.
  let auto = false;
  for (let i = 0; i < 12 && !auto; i++) {
    auto = await page.evaluate(() => !!(WALLY?.ctx?.intro?.running));
    if (!auto) await page.waitForTimeout(250);
  }
  if (!auto) { await page.mouse.click(640, 360); await page.waitForTimeout(1200); }

  const t0 = Date.now(); let saw = false, far = -1;
  while (Date.now() - t0 < 150000) {
    const s = await page.evaluate(() => ({ up: !!WALLY?.ctx?.intro?.running, t: WALLY?.ctx?.intro?.time ?? -1 }));
    if (s.up) saw = true;
    if (s.t > far) far = s.t;
    if (saw && !s.up) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1500);

  const staged = await page.evaluate(() => (WALLY.ctx.intro ? WALLY.ctx.intro.state() : null));
  const m = await page.evaluate((names) => {
    const S = window.__Q || [];
    const qang = (a,b,k) => { // geodesic angle between two quats, degrees
      const i = k*4;
      let d = a[i]*b[i]+a[i+1]*b[i+1]+a[i+2]*b[i+2]+a[i+3]*b[i+3];
      d = Math.abs(d); if (d > 1) d = 1;
      return 2*Math.acos(d)*57.2958;
    };
    const emax = (a,b,k) => { const i=k*3; let m=0;
      for (let j=0;j<3;j++) m=Math.max(m,Math.abs(a[i+j]-b[i+j])); return m; };
    let cut = -1;
    for (let i=1;i<S.length;i++) if (S[i-1].cam==='cinematic' && S[i].cam!=='cinematic') { cut=i; break; }
    if (cut < 0) return { cut:-1, frames:S.length };
    const per = names.map((nm,k) => {
      const stepQ = qang(S[cut-1].q, S[cut].q, k);
      const stepE = emax(S[cut-1].e, S[cut].e, k);
      // baseline: median per-frame quat step over the 0.4 s before the cut
      const b = [];
      for (let i=cut-1, acc=0; i>1 && acc<0.4; i--, acc+=S[i].dt) b.push(qang(S[i-1].q,S[i].q,k));
      b.sort((x,y)=>x-y);
      // and over the 0.4 s after
      const a = [];
      for (let i=cut+1, acc=0; i<S.length-1 && acc<0.4; i++, acc+=S[i].dt) a.push(qang(S[i-1].q,S[i].q,k));
      a.sort((x,y)=>x-y);
      // total travel across 0.30 s either side (absolute pose change)
      const walk=(from,dir,secs)=>{let i=from,acc=0;
        while(i+dir>0&&i+dir<S.length&&acc<secs){i+=dir;acc+=S[i].dt;} return i;};
      const iA = walk(cut,1,0.30), iB = walk(cut-1,-1,0.30);
      return { joint: nm,
        cutDeg: +stepQ.toFixed(3), cutDegEuler: +stepE.toFixed(3),
        cutDt: +S[cut].dt.toFixed(4),
        cutRate: +(stepQ/Math.max(1e-4,S[cut].dt)).toFixed(1),
        medBefore: +(b.length?b[b.length>>1]:0).toFixed(3),
        maxBefore: +(b.length?b[b.length-1]:0).toFixed(3),
        medAfter: +(a.length?a[a.length>>1]:0).toFixed(3),
        travelAfter30: +qang(S[cut-1].q,S[iA].q,k).toFixed(3),
        travelBefore30: +qang(S[iB].q,S[cut-1].q,k).toFixed(3) };
    });
    return { cut, frames:S.length, tCut:+S[cut].t.toFixed(2),
      camBefore:S[cut-1].cam, camAfter:S[cut].cam,
      dtCut:+S[cut].dt.toFixed(4), per };
  }, JOINTS);
  OUT.push({ label, ride, rides, staged: staged ? { ride: staged.ride, owned: staged.owned } : null,
             reached: +far.toFixed(2), errs, m });
  console.log(JSON.stringify(OUT[OUT.length-1]));
  await ctx.close();
}

await run('no save (brand new player)', null);
await run('bicycle', 'bike');
await run('scooter', 'scooter');
await run('motorcycle', 'motorcycle');
await run('balloon', 'balloon');
console.log('\n=== SUMMARY: discontinuity at the C->D cut, degrees (quaternion) ===');
for (const r of OUT) {
  if (!r.m || r.m.cut < 0) { console.log(`${r.label}: NO CUT SEEN (${r.m?.frames} frames)`); continue; }
  const worst = r.m.per.reduce((a,b)=> b.cutDeg > a.cutDeg ? b : a);
  console.log(`${r.label.padEnd(26)} staged=${r.staged?.ride}/owned=${r.staged?.owned} t=${r.m.tCut}s dt=${r.m.dtCut}s`);
  for (const p of r.m.per) {
    console.log(`   ${p.joint.padEnd(6)} cut ${String(p.cutDeg).padStart(7)} deg  (euler-max ${String(p.cutDegEuler).padStart(7)})  ` +
      `median frame before ${String(p.medBefore).padStart(6)} / after ${String(p.medAfter).padStart(6)}  ` +
      `travel 0.30s after ${String(p.travelAfter30).padStart(6)} vs before ${String(p.travelBefore30).padStart(6)}`);
  }
  console.log(`   WORST joint ${worst.joint}: ${worst.cutDeg} deg across the cut frame (${worst.cutRate} deg/s at dt ${worst.cutDt}s)`);
}
await browser.close(); server.close();
