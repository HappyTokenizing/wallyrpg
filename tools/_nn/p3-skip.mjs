/* SKIP. Boot the real opener, press the real Space key at a chosen
   moment mid-ride, and look at what is left standing.
   node tools/_nn/p3-skip.mjs <seconds> */
import { boot, P } from './lib.mjs';
const AT = +(process.argv[2] || 24);
const { page, errs, close } = await boot({ query: '', wait: 1500 });

const marks = await page.evaluate(() => {
  const W = window.WALLY;
  W.debug.begin?.();
  return { marks: W.debug.introMarks ? W.debug.introMarks() : null, state: W.debug.introState?.() };
});
P('MARKS', marks);
await page.waitForTimeout(600);
await page.evaluate(() => { if (!window.WALLY.debug.introState().running) window.WALLY.debug.playIntro(); });

/* run to the chosen moment */
await page.waitForFunction((t) => (window.WALLY.debug.introState().t || 0) >= t, AT, { timeout: 120000, polling: 100 });
const before = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const g = c.scene.getObjectByName('intro.bicycle');
  return { t: W.debug.introState().t, seq: W.debug.introState().seq,
    bikeVisible: g ? g.visible : null, bikeAt: g ? g.position.toArray().map((v) => +v.toFixed(2)) : null };
});
P('AT-PRESS', before);

/* the real key, through the real listener */
await page.keyboard.press('Space');
await page.waitForTimeout(1600);

const after = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const g = c.scene.getObjectByName('intro.bicycle');
  const rp = c.wally.root.position;
  if (!g) return { gone: true, state: W.debug.introState() };
  g.updateMatrixWorld(true);
  const stand = g.getObjectByName('kickstand');
  /* both wheel contacts, straight off the world matrix */
  const wheels = [];
  g.traverse((o) => { if (o.isMesh && o.geometry?.type === 'TorusGeometry') wheels.push(o); });
  const cts = wheels.slice(0, 2).map((w) => {
    let x = 0, z = 0;
    for (let n = w; n && n !== g; n = n.parent) { x += n.position.x; z += n.position.z; }
    const v = new W.THREE.Vector3(x, 0, z).applyMatrix4(g.matrixWorld);
    const h = H(v.x, v.z);
    return { z: +z.toFixed(3), clearMM: h == null ? null : +((v.y - h) * 1000).toFixed(1) };
  });
  return {
    state: W.debug.introState(),
    at: g.position.toArray().map((v) => +v.toFixed(2)),
    rot: [+(g.rotation.x * 57.2958).toFixed(2), +(g.rotation.y * 57.2958).toFixed(2), +(g.rotation.z * 57.2958).toFixed(2)],
    order: g.rotation.order,
    visible: g.visible,
    standVisible: stand ? stand.visible : null,
    distToPlayer: +Math.hypot(g.position.x - rp.x, g.position.z - rp.z).toFixed(2),
    playerAt: [+rp.x.toFixed(2), +rp.y.toFixed(2), +rp.z.toFixed(2)],
    contacts: cts,
    nWheelMeshes: wheels.length,
  };
});
P('AFTER-SKIP', after);

/* does it get collected, and when */
for (const w of [1500, 3000, 6000]) {
  await page.waitForTimeout(w);
  const s = await page.evaluate(() => {
    const g = window.WALLY.ctx.scene.getObjectByName('intro.bicycle');
    return { gone: !g, visible: g ? g.visible : null, inScene: !!g };
  });
  P('LATER+' + w, s);
}
P('ERRS', errs.slice(0, 8));
await close();
