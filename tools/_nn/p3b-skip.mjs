/* SKIP, at several points across the ride window (19.30 -> 26.67), one
   boot per press, with the two wheel groups identified properly rather
   than "the first two toruses". */
import { boot, P } from './lib.mjs';
const TIMES = process.argv.slice(2).map(Number);
for (const AT of TIMES) {
  const { page, errs, close } = await boot({ query: '', wait: 1500 });
  await page.evaluate(() => { window.WALLY.debug.begin?.(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { if (!window.WALLY.debug.introState().running) window.WALLY.debug.playIntro(); });
  await page.waitForFunction((t) => (window.WALLY.debug.introState().t || 0) >= t, AT, { timeout: 180000, polling: 50 });
  const before = await page.evaluate(() => {
    const W = window.WALLY, c = W.ctx;
    const g = c.scene.getObjectByName('intro.bicycle');
    const s = W.debug.introState();
    return { t: s.t, seq: s.seq, vis: g ? g.visible : null,
      at: g ? g.position.toArray().map((v) => +v.toFixed(2)) : null,
      rot: g ? [+(g.rotation.x * 57.3).toFixed(2), +(g.rotation.z * 57.3).toFixed(2)] : null,
      stand: g ? !!g.getObjectByName('kickstand')?.visible : null };
  });
  await page.keyboard.press('Space');
  await page.waitForTimeout(1800);
  const after = await page.evaluate(() => {
    const W = window.WALLY, c = W.ctx, T = W.THREE;
    const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
    const g = c.scene.getObjectByName('intro.bicycle');
    const rp = c.wally.root.position;
    if (!g) return { gone: true };
    g.updateMatrixWorld(true);
    /* the two WHEEL GROUPS: the parents of the torus meshes, deduped by
       their offset along the machine's own z */
    const seen = new Map();
    g.traverse((o) => {
      if (!o.isMesh || o.geometry?.type !== 'TorusGeometry') return;
      let x = 0, z = 0;
      for (let n = o; n && n !== g; n = n.parent) { x += n.position.x; z += n.position.z; }
      const k = z.toFixed(2);
      if (!seen.has(k)) seen.set(k, [x, z]);
    });
    const zs = [...seen.values()].sort((a, b) => b[1] - a[1]);
    const ends = zs.length > 1 ? [zs[0], zs[zs.length - 1]] : zs;
    const cts = ends.map(([x, z]) => {
      const v = new T.Vector3(x, 0, z).applyMatrix4(g.matrixWorld);
      const h = H(v.x, v.z);
      return { z: +z.toFixed(3), clearMM: h == null ? null : +((v.y - h) * 1000).toFixed(1) };
    });
    return { at: g.position.toArray().map((v) => +v.toFixed(2)),
      rotDeg: [+(g.rotation.x * 57.2958).toFixed(2), +(g.rotation.y * 57.2958).toFixed(2), +(g.rotation.z * 57.2958).toFixed(2)],
      order: g.rotation.order, visible: g.visible,
      stand: !!g.getObjectByName('kickstand')?.visible,
      distToPlayer: +Math.hypot(g.position.x - rp.x, g.position.z - rp.z).toFixed(2),
      contacts: cts, nWheelZ: seen.size, state: W.debug.introState() };
  });
  P('SKIP@' + AT, { before, after, errs: errs.slice(0, 3) });
  await close();
}
