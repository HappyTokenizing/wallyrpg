/* p3 — THE LEFT-BEHIND BICYCLE. Ride to a door, leave the bicycle, get on
   the scooter, and ask three questions of the BICYCLE, not of a flag:
     is it still where he left it, standing, leaning on its stand
     is it still DRAWN (visible, in the scene, and actually rasterised —
       counted by walking the render list, not by trusting .visible)
     did anything leak — parent, a second copy, or draw cost that never
       goes away when he rides out of sight
   Draw cost is renderer.info.render.calls/triangles, sampled with the
   machine near and again 80 m away, which is past PARK_DRAW_M. */
import { boot } from './lib.mjs';

const { page, browser, server, errs } = await boot({ w: 1100, h: 660 });

await page.evaluate(() => {
  const c = window.WALLY.ctx;
  window.__P = {
    /* every prop wally owns, by id, described from the SCENE GRAPH */
    props() {
      const w = c.wally;
      const out = {};
      const seen = [];
      c.scene.traverse((o) => { if (o.name && /bike|scoot|moto|cycle/i.test(o.name)) seen.push(o.name); });
      for (const id of ['bike', 'scooter', 'motorcycle']) {
        const p = w.propFor ? w.propFor(id) : null;
        out[id] = p ? null : null;
      }
      return { seen };
    },
    snap() {
      const w = c.wally, T = window.WALLY.THREE;
      const s = w.bikeState || {};
      /* find EVERY bicycle-shaped group in the scene, whoever owns it:
         a group with >=2 wheel subgroups and a crank */
      const found = [];
      c.scene.traverse((o) => {
        if (!o.isGroup) return;
        const wheels = o.children.filter((k) => k.isGroup && k.children.length >= 5 && k.children.every((m) => m.isMesh));
        if (wheels.length < 2) return;
        const P = new T.Vector3(); o.getWorldPosition(P);
        let vis = o.visible, n = o;
        while (n) { if (!n.visible) vis = false; n = n.parent; }
        let tri = 0, meshes = 0;
        o.traverse((m) => { if (m.isMesh && m.geometry && m.geometry.index) { tri += m.geometry.index.count / 3; meshes++; } else if (m.isMesh && m.geometry) { tri += m.geometry.attributes.position.count / 3; meshes++; } });
        found.push({ name: o.name || '(unnamed)', parent: o.parent === c.scene ? 'scene' : (o.parent === w.root ? 'wallyRoot' : (o.parent ? o.parent.name || o.parent.type : 'none')),
          localVisible: o.visible, effectiveVisible: vis,
          world: [+P.x.toFixed(3), +P.y.toFixed(3), +P.z.toFixed(3)],
          rot: [+o.rotation.x.toFixed(4), +o.rotation.y.toFixed(4), +o.rotation.z.toFixed(4), o.rotation.order],
          meshes, tri });
      });
      return { state: JSON.parse(JSON.stringify(s)), riding: w.riding, rideId: w.rideId, found,
        wallyPos: [+w.root.position.x.toFixed(2), +w.root.position.y.toFixed(2), +w.root.position.z.toFixed(2)] };
    },
    /* draw cost, averaged over N frames of the REAL render loop */
    async cost(n = 40) {
      const r = c.render && c.render.renderer ? c.render.renderer : (c.renderer || null);
      if (!r) return null;
      const calls = [], tris = [];
      await new Promise((res) => {
        let i = 0;
        const tick = () => { calls.push(r.info.render.calls); tris.push(r.info.render.triangles); if (++i >= n) res(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
      return { calls: med(calls), triangles: med(tris) };
    },
  };
});

async function hold(keys, secs) {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(secs * 1000);
  for (const k of keys) await page.keyboard.up(k);
  await page.waitForTimeout(700);
}

const door = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const v = (c.world.city || c.city).doorPosition('apartment');
  c.game.actions.grantRide('bike');
  c.game.actions.grantRide('scooter');
  c.game.actions.equipRide('bike');
  const h = c.world.heightAt(v.x + 6, v.z + 2);
  c.wally.setPosition(v.x + 6, h, v.z + 2);
  return [v.x, v.y, v.z];
});
await page.waitForTimeout(2500);

/* ride the last stretch on the real controls */
await page.evaluate((d) => {
  const c = window.WALLY.ctx, w = c.wally;
  const dx = d[0] - w.root.position.x, dz = d[2] - w.root.position.z;
  w.setYaw(Math.atan2(dx, dz));
}, door);
await hold(['KeyW'], 1.1);

const beforePark = await page.evaluate(() => window.__P.snap());
const costRiding = await page.evaluate(() => window.__P.cost());

/* ---- LEAVE THE BICYCLE (the call the garage button makes) ---- */
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2400);
const parked = await page.evaluate(() => window.__P.snap());
await page.screenshot({ path: '/tmp/vjJ-park-1-left.png' });

/* ---- GET ON THE SCOOTER ---- */
const mount = await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide('scooter'));
await page.waitForTimeout(2600);
const onScooter = await page.evaluate(() => window.__P.snap());
const costScooterNear = await page.evaluate(() => window.__P.cost());
await page.screenshot({ path: '/tmp/vjJ-park-2-scooter.png' });

/* back the camera off so both are in frame */
await page.mouse.move(550, 380);
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(70); }
await page.waitForTimeout(900);
await page.screenshot({ path: '/tmp/vjJ-park-3-both.png' });

/* ---- RIDE AWAY, past PARK_DRAW_M ---- */
await page.evaluate((d) => {
  const c = window.WALLY.ctx, w = c.wally;
  const dx = w.root.position.x - d[0], dz = w.root.position.z - d[2];
  w.setYaw(Math.atan2(dx, dz));
}, door);
await hold(['ShiftLeft', 'KeyW'], 7.5);
const away = await page.evaluate(() => window.__P.snap());
const costFar = await page.evaluate(() => window.__P.cost());
const dist = await page.evaluate((d) => {
  const w = window.WALLY.ctx.wally;
  return +Math.hypot(w.root.position.x - d[0], w.root.position.z - d[2]).toFixed(2);
}, door);
await page.screenshot({ path: '/tmp/vjJ-park-4-away.png' });

/* ---- COME BACK AND RE-MOUNT IT ---- */
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide('bike'));
await page.waitForTimeout(2600);
const remount = await page.evaluate(() => window.__P.snap());

console.log(JSON.stringify({ door, beforePark, parked, mount, onScooter, away, awayDistM: dist, remount,
  cost: { riding: costRiding, scooterNear: costScooterNear, far: costFar }, errs: errs.slice(0, 8) }, null, 1));
await browser.close(); server.close();
