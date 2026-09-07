/* RENDERING. (a) ink fraction on the ground vs at altitude, measured by an
   exact difference — the outline hulls are moved to a layer the camera does
   not draw, which cullHulls() cannot undo. (b) the sea, four frames each. */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const OUT = join(ROOT, 'shots/j2/render');
await mkdir(OUT, { recursive: true });
const W = 1600, H = 900;
const { page, errors, close } = await boot({ query: 'skipIntro&shot=1',
  viewport: { width: W, height: H }, settle: 5000 });

await page.evaluate(() => {
  WALLY.debug.setHour(13);
  WALLY.ctx.wind.setStrength(0.20);
  /* FREEZE THE WORLD. main.js derives dt from the rAF timestamp, so a
     frozen timestamp is dt = 0 for every module at once: no waves, no
     grass, no clouds, no drift. Without it a "difference" between two
     screenshots is mostly the sea moving. */
  const raf = window.requestAnimationFrame.bind(window);
  window.__FROZEN = null;
  window.requestAnimationFrame = (cb) => raf((t) => cb(window.__FROZEN !== null ? window.__FROZEN : t));
  window.__FREEZE = (on) => { window.__FROZEN = on ? performance.now() : null; return window.__FROZEN; };
  window.__INK = (off) => {
    const hs = [];
    WALLY.ctx.scene.traverse(o => { if (o.userData && o.userData.isOutlineHull) hs.push(o); });
    hs.forEach(h => { if (off) h.layers.set(31); else h.layers.set(0); });
    return hs.length;
  };
});
const pump = (n=30) => page.evaluate(k => new Promise(r => {
  let i=0; const t=()=>{ window.__PIN&&window.__PIN(); if(++i>=k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }), n);

const cases = [];
/* ---- GROUND: the follow rig, on foot, looking at the town ---- */
for (const [name, alt] of [['ground', 0], ['alt200', 200], ['alt120', 120], ['alt60', 60]]) {
  await page.evaluate((a) => {
    WALLY.debug.balloon(false);
    if (a > 0) { WALLY.debug.balloon({ alt: a }); WALLY.debug.balloonStick(0,0); }
    delete window.__PIN;
  }, alt);
  /* let the world FINISH STREAMING before anything is measured: at 200 m
     the fog is open to 2392 and foliage, city LOD and cloud sprites keep
     arriving for several seconds. A "difference" taken before that has
     the streaming in it, not the ink. */
  await pump(150);
  await page.waitForTimeout(3000);
  await pump(150);
  await page.evaluate(() => window.__FREEZE(true));
  await pump(20);
  const ink = join(OUT, name + '.png');
  await page.screenshot({ path: ink, animations:'allow', timeout:40000 });
  await page.evaluate(() => window.__INK(true));
  await pump(20);
  const noink = join(OUT, name + '_noink.png');
  await page.screenshot({ path: noink, animations:'allow', timeout:40000 });
  await page.evaluate(() => window.__INK(true));
  await pump(20);
  const ctrl = join(OUT, name + '_ctrl.png');
  await page.screenshot({ path: ctrl, animations:'allow', timeout:40000 });
  await page.evaluate(() => { window.__INK(false); window.__FREEZE(false); });
  const state = await page.evaluate(() => {
    const o = WALLY.debug.outline();
    const f = WALLY.ctx.scene.fog;
    let bi = {}; try { bi = WALLY.debug.balloonInfo(); } catch(e){}
    return { hulls:o.hulls, drawn:o.hullsDrawn, hazeK:o.hazeK, cullFar:o.cullFar,
      cullFarNow:o.cullFarNow, near:o.near, far:o.far,
      fogNear:+(f?.near??0).toFixed(1), fogFar:+(f?.far??0).toFixed(1),
      alt: bi.alt ?? 0, camY:+WALLY.ctx.camera.position.y.toFixed(1) };
  });
  cases.push({ name, alt, ink, noink, ctrl, ...state });
  console.log(name, JSON.stringify(state));
}

/* ---- THE SEA. Four independent frames at each height, lens aimed at open
   water away from the island. ---- */
const sea = [];
for (const [name, alt] of [['sea-ground', 0], ['sea-alt200', 200]]) {
  await page.evaluate((a) => {
    WALLY.debug.balloon(false);
    if (a > 0) { WALLY.debug.balloon({ alt: a }); WALLY.debug.balloonStick(0,0); }
    WALLY.debug.camFree();
    const w = WALLY.ctx.wally.position.clone();
    /* aim out to open sea: east, level-ish, so the disc fills the lower frame */
    window.__PIN = () => {
      const c = WALLY.ctx.camera;
      c.position.set(w.x, w.y + (a>0?2:1.2), w.z);
      c.lookAt(w.x + 400, w.y + (a>0? -60 : -1), w.z - 380);
      c.updateMatrixWorld(true);
    };
  }, alt);
  for (let i=0;i<4;i++) {
    await pump(40);
    const p = join(OUT, name + '_f' + i + '.png');
    await page.screenshot({ path: p, animations:'allow', timeout:40000 });
    sea.push({ name, alt, i, p });
  }
}
const waves = await page.evaluate(() => {
  const out = {};
  WALLY.ctx.scene.traverse(o => {
    if (o.material && o.material.uniforms && o.material.uniforms.uWaveFade)
      out[o.name || 'water'] = JSON.parse(JSON.stringify(o.material.uniforms.uWaveFade.value));
  });
  return out;
});
await close();
await writeFile(join(OUT, 'index.json'), JSON.stringify({ cases, sea, waves }, null, 1));
console.log(JSON.stringify({ waves, errors: errors.slice(0,5) }));
