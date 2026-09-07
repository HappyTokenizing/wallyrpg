#!/usr/bin/env node
/* JUDGE PROBE — measured geometry and render state, no screenshots. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try { const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await chromium.launch({ channel:'chrome', args:['--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio'] });
const page = await browser.newPage({ viewport:{ width:1600, height:900 } });
const errs=[]; page.on('pageerror',e=>errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro&shot=1`, { waitUntil:'load', timeout:120000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout:120000 });
await page.waitForTimeout(4000);

const R = {};
/* 1. CROWN RING GAP — measured off the drawn geometry, at several inflations */
R.crown = await page.evaluate(async () => {
  const THREE = WALLY.ctx.THREE || null;
  const out = [];
  for (const t of [1.0, 0.9, 0.75, 0.5, 0.25, 0.0]) {
    WALLY.debug.balloonPose(t);
    // find the prop group in the scene graph
    let env=null, crown=null, tapes=null, group=null;
    WALLY.ctx.scene.traverse(o => { if (o.name === 'balloon.envGroup') group = o; });
    if (!group) { out.push({ t, err:'no envGroup' }); continue; }
    group.updateWorldMatrix(true, true);
    const box = (o) => { const b = new (o.constructor.prototype.constructor, window.__B || Object)(); return null; };
    // manual world-space bbox by walking position attributes
    const bb = (obj) => {
      let miny=1e9,maxy=-1e9,minr=1e9,maxr=0, n=0, v={x:0,y:0,z:0};
      obj.traverse(o => {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
        if (o.userData.isOutlineHull) return;
        const p = o.geometry.attributes.position; const m = o.matrixWorld.elements;
        for (let i=0;i<p.count;i++){
          const x=p.getX(i), y=p.getY(i), z=p.getZ(i);
          const wx=m[0]*x+m[4]*y+m[8]*z+m[12], wy=m[1]*x+m[5]*y+m[9]*z+m[13], wz=m[2]*x+m[6]*y+m[10]*z+m[14];
          if (wy<miny) miny=wy; if (wy>maxy) maxy=wy;
          const r=Math.hypot(wx,wz); if(r<minr)minr=r; if(r>maxr)maxr=r; n++;
        }
      });
      return { miny:+miny.toFixed(4), maxy:+maxy.toFixed(4), maxr:+maxr.toFixed(4), n };
    };
    const parts = {};
    group.children.forEach((c,i) => { parts[c.name || ('child'+i)] = bb(c); });
    out.push({ t, parts });
  }
  WALLY.debug.balloonPose(1);
  return out;
});

/* 2. CAMERA / FOG / SHADOW at altitude */
R.altitude = [];
for (const alt of [0, 20, 60, 120, 200, 400, 800, 1600]) {
  const r = await page.evaluate(async (a) => {
    WALLY.debug.balloon({ alt: a });
    await new Promise(r2 => { let n=0; const t=()=>(++n>20?r2():requestAnimationFrame(t)); requestAnimationFrame(t); });
    const cam = WALLY.ctx.camera, fog = WALLY.ctx.scene.fog;
    const info = WALLY.debug.balloonInfo();
    const csm = WALLY.ctx.render?.csm?.cfg || null;
    // count visible city buildings at full LOD
    const cs = WALLY.debug.cityStats ? WALLY.debug.cityStats() : null;
    return { alt: +info.alt.toFixed(1), camY: +cam.position.y.toFixed(1), camFar: cam.far, camNear: cam.near,
      fov: +cam.fov.toFixed(1),
      fog: fog ? { near:+fog.near.toFixed(0), far:+fog.far.toFixed(0) } : null,
      shadowFar: csm ? csm.far : null, cascades: csm ? csm.cascades : null,
      city: cs, calls: WALLY.__perf ? null : (window.__WALLY_PERF__||{}).calls,
      perf: window.__WALLY_PERF__ };
  }, alt);
  R.altitude.push(r);
}

/* 3. THE COST OF THE MACHINE, differenced */
R.cost = await page.evaluate(async () => {
  WALLY.debug.balloon({ alt: 30 });
  await new Promise(r => setTimeout(r, 600));
  const aloft = await WALLY.debug.balloonCost(30);
  return { aloft };
});

/* 4. Ceiling: is there one? burn for 120 s of simulated flight */
R.ceiling = await page.evaluate(async () => {
  WALLY.debug.balloon({ alt: 5 });
  WALLY.debug.balloonBurn(true);
  const t0 = performance.now(); const marks = [];
  while (performance.now() - t0 < 60000) {
    await new Promise(r => requestAnimationFrame(r));
    const i = WALLY.debug.balloonInfo();
    if (marks.length === 0 || performance.now() - marks[marks.length-1].ms > 5000)
      marks.push({ ms: performance.now(), alt: +i.alt.toFixed(1), vy: +i.vy.toFixed(2), y: +i.at[1].toFixed(1), fogFar: i.fog[1] });
  }
  const i = WALLY.debug.balloonInfo();
  WALLY.debug.balloonBurn(false);
  return { marks, final: { alt:+i.alt.toFixed(1), y:+i.at[1].toFixed(1), vy:+i.vy.toFixed(2), fog:i.fog } };
});

await writeFile(join(ROOT,'shots/judge/probe.json'), JSON.stringify(R,null,1));
console.log(JSON.stringify(R, null, 1));
if (errs.length) console.log('ERRORS', errs.slice(0,10));
await browser.close(); server.close();
