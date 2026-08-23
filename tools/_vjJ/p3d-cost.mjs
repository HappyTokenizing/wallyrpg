/* p3d — the parked prop's draw cost, measured so the crowd cannot drown
   it. The scene's own LOD and 400 pedestrians move enough between two
   half-second windows to swamp a 100-call prop, so the prop is toggled
   ON EVERY OTHER FRAME and the two interleaved series are differenced:
   adjacent frames share the same crowd, the same LOD and the same
   camera, and the only difference between them is the bicycle. */
import { boot } from './lib.mjs';
const { page, browser, server, errs } = await boot({ w: 1100, h: 660 });

const door = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const v = (c.world.city || c.city).doorPosition('apartment');
  c.game.actions.grantRide('bike');
  c.game.actions.equipRide('bike');
  c.wally.setPosition(v.x + 2, c.world.heightAt(v.x + 2, v.z + 2), v.z + 2);
  return [v.x, v.y, v.z];
});
await page.waitForTimeout(2600);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2400);
await page.evaluate(() => window.WALLY.ctx.game.actions.grantRide('scooter'));
await page.waitForTimeout(900);
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide('scooter'));
await page.waitForTimeout(2400);
await page.mouse.move(550, 380);
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(60); }
await page.keyboard.down('KeyS'); await page.waitForTimeout(800); await page.keyboard.up('KeyS');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/vjJ-p3d-standing.png' });

const res = await page.evaluate(async () => {
  const c = window.WALLY.ctx;
  const r = (c.render && c.render.renderer) || c.renderer;
  const g = c.scene.getObjectByName('wally.bike');
  const was = g.visible;
  let meshes = 0, tri = 0;
  g.traverse((m) => { if (m.isMesh && m.geometry) { meshes++; tri += m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3; } });
  /* NOT g.visible: wally.js's parkedCull() rewrites that flag every
     frame from the camera distance, so a toggle written before the
     frame is gone before the frame renders — which is why the first
     version of this probe measured a one-call difference for a
     106-mesh prop. DETACH it instead; nothing re-parents a parked
     prop until he mounts it. */
  const on = [], off = [];
  await new Promise((res2) => {
    let i = 0;
    const tick = () => {
      const v = (i % 2) === 0;
      if (v) { if (g.parent !== c.scene) c.scene.add(g); } else { c.scene.remove(g); }
      requestAnimationFrame(() => {
        (v ? on : off).push({ calls: r.info.render.calls, tri: r.info.render.triangles });
        if (++i >= 160) res2(); else tick();
      });
    };
    tick();
  });
  c.scene.add(g);
  g.visible = was;
  const med = (a, k) => a.map((x) => x[k]).sort((p, q) => p - q)[Math.floor(a.length / 2)];
  return { meshes, tri, n: on.length,
    onCalls: med(on, 'calls'), offCalls: med(off, 'calls'),
    onTri: med(on, 'tri'), offTri: med(off, 'tri'),
    dCalls: med(on, 'calls') - med(off, 'calls'), dTri: med(on, 'tri') - med(off, 'tri') };
});

/* PARK_DRAW_M: teleport out and back, and watch the flag */
const range = [];
for (const d of [10, 40, 63, 66, 100, 200, 20]) {
  await page.evaluate(([dd, door2]) => {
    const c = window.WALLY.ctx;
    const x = door2[0] + dd, z = door2[2];
    c.wally.setPosition(x, c.world.heightAt(x, z), z);
  }, [d, door]);
  await page.waitForTimeout(900);
  range.push(await page.evaluate(() => {
    const c = window.WALLY.ctx, g = c.scene.getObjectByName('wally.bike');
    return { camDist: +c.camera.position.distanceTo(g.position).toFixed(1), visible: g.visible, parent: g.parent === c.scene ? 'scene' : 'other' };
  }));
}
console.log(JSON.stringify({ propCost: res, rangeSweep: range, errs: errs.slice(0, 5) }, null, 1));
await browser.close(); server.close();
