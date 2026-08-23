/* _jj/park.mjs — PARK IDENTITY, measured three ways.
   node tools/_jj/park.mjs <mode>     mode = two | both | one
*/
import { boot, P } from './lib.mjs';
import { writeFile } from 'node:fs/promises';

const MODE = process.argv[2] || 'two';
const { page, errs, close } = await boot();

/* --- helpers injected once --------------------------------------- */
await page.evaluate(() => {
  const W = window.WALLY, T = W.THREE, c = W.ctx;
  /* EFFECTIVE VISIBILITY, not object.visible. three r180's Raycaster
     does NOT skip invisible objects (vendor/three.core.js intersect()),
     so a raw hit proves nothing about whether the thing is DRAWN. Walk
     the parent chain. */
  const drawn = (o) => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
  const ownerOf = (o) => {
    const props = c.wally.rideProps;
    for (let n = o; n; n = n.parent) for (const k in props) if (props[k].group === n) return k;
    for (let n = o; n; n = n.parent) if (n === c.wally.root) return 'wally-root';
    /* NAME IT ANYWAY. Returning null for "some world mesh" made my own
       first run unreadable: drawnFirstHit read null next to a non-null
       hit distance. */
    return 'world:' + (o.name || o.type);
  };
  window.__JJ = {
    drawn, ownerOf,
    /* Where a prop sits on screen, and what rays through its own
       screen footprint actually hit.

       NOT ONE RAY THROUGH THE BOUNDING-BOX CENTRE. That was my first
       instrument and it reported the bicycle missing while it was
       plainly standing there: a bicycle is mostly air, and the centre
       of its box is the hole inside the frame triangle. It is a grid
       over the projected footprint, and the prop counts as struck when
       it is the nearest DRAWN hit — with the ground-shadow decal
       skipped, because that is a transparent projector plane that sits
       between the camera and everything and occludes nothing. */
    probe(key, N = 21) {
      const p = c.wally.rideProps[key];
      if (!p) return { key, error: 'no prop built' };
      const g = p.group;
      g.updateMatrixWorld(true);
      const box = new T.Box3().setFromObject(g, true);
      const ctr = box.getCenter(new T.Vector3());
      const cam = c.camera;
      const el = c.renderer.domElement;
      const corners = [];
      for (let i = 0; i < 8; i++) {
        corners.push(new T.Vector3(
          i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z,
        ).project(cam));
      }
      const anyBehind = corners.some((v) => v.z >= 1);
      const x0 = Math.max(-1, Math.min(...corners.map((v) => v.x)));
      const x1 = Math.min(1, Math.max(...corners.map((v) => v.x)));
      const y0 = Math.max(-1, Math.min(...corners.map((v) => v.y)));
      const y1 = Math.min(1, Math.max(...corners.map((v) => v.y)));
      const ndc = ctr.clone().project(cam);
      const onScreen = !anyBehind && x1 > x0 && y1 > y0;
      let struck = 0, tested = 0, nearest = null, occluder = null;
      if (onScreen) {
        const rc = new T.Raycaster();
        for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
          const nx = x0 + ((x1 - x0) * (a + 0.5)) / N;
          const ny = y0 + ((y1 - y0) * (b + 0.5)) / N;
          rc.setFromCamera(new T.Vector2(nx, ny), cam);
          const vis = rc.intersectObject(c.scene, true)
            .filter((h) => drawn(h.object) && ownerOf(h.object) !== 'world:wally.groundShadow');
          tested++;
          if (!vis.length) continue;
          const o = ownerOf(vis[0].object);
          if (o === key) {
            struck++;
            if (nearest == null || vis[0].distance < nearest) nearest = vis[0].distance;
          } else if (vis.some((h) => ownerOf(h.object) === key)) occluder = o;
        }
      }
      return {
        key,
        parentIsScene: g.parent === c.scene,
        groupVisible: g.visible,
        effectivelyDrawn: drawn(g),
        at: g.position.toArray().map((v) => +v.toFixed(2)),
        leanZ: +g.rotation.z.toFixed(3),
        standOut: p.stand ? p.stand.visible : null,
        distFromCam: +cam.position.distanceTo(ctr).toFixed(2),
        onScreen,
        screen: [Math.round((ndc.x * 0.5 + 0.5) * el.clientWidth), Math.round((-ndc.y * 0.5 + 0.5) * el.clientHeight)],
        raysStruck: struck, raysTested: tested,
        nearestPropHitM: nearest == null ? null : +nearest.toFixed(2),
        occludedBy: occluder,
      };
    },
    /* AN INDEPENDENT "IS IT DRAWN", sharing nothing with the raycast
       or with the visible flag: render one frame with the prop in and
       one with it collapsed to zero scale, and difference
       renderer.info. A thing that is not drawn costs nothing. Scale,
       not `visible`, because parkedCull rewrites `visible` every frame
       and would undo the toggle before the frame it is measuring. */
    infoDelta(key) {
      const p = c.wally.rideProps[key];
      if (!p) return null;
      const r = c.renderer, g = p.group;
      const rd = () => { r.info.reset(); r.render(c.scene, c.camera); return { calls: r.info.render.calls, tris: r.info.render.triangles }; };
      rd();
      const on = rd();
      /* `visible`, not scale — my first attempt used scale 1e-6 and
         measured a delta of 0 calls / 0 triangles, because a shrunken
         mesh is still submitted. Draw calls do not care how big it is.
         The toggle is safe inside one synchronous evaluate: no rAF can
         land between the two renders, so parkedCull cannot undo it. */
      const was = g.visible;
      g.visible = false;
      const off = rd();
      g.visible = was;
      rd();
      return { calls: on.calls - off.calls, tris: on.tris - off.tris, callsWith: on.calls, trisWith: on.tris };
    },
  };
});

const st = () => page.evaluate(() => {
  const c = window.WALLY.ctx;
  return { rideState: c.wally.bikeState, gameRide: c.game.actions.bike(),
    props: Object.keys(c.wally.rideProps) };
});
const probe = (k) => page.evaluate((k2) => window.__JJ.probe(k2), k);
const pix = (k) => page.evaluate((k2) => window.__JJ.infoDelta(k2), k);
const pos = () => page.evaluate(() => { const p = window.WALLY.ctx.wally.root.position; return [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]; });

/* AIM THE PLAYER'S OWN CAMERA at a prop by dragging the canvas, which
   is the orbit control the player has. No debug camera. */
async function aim(key, steps = 26) {
  const look = () => page.evaluate((k2) => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE;
    const g = c.wally.rideProps[k2].group; g.updateMatrixWorld(true);
    const bb = new T.Box3().setFromObject(g, true).getCenter(new T.Vector3());
    const n = bb.clone().project(c.camera);
    return { x: n.x, y: n.y, behind: n.z >= 1, camYaw: c.cam ? +c.cam.yaw.toFixed(3) : null };
  }, key);
  /* A FIXED SWEEP, NOT A PROPORTIONAL CONTROLLER. My first aim() scaled
     the drag by the target's NDC x, which is meaningless once the
     target is behind the lens — project() flips the sign there, so it
     steered away and sat at x = 2.0 for ten tries. Drag one direction
     in equal steps until the machine is in frame; a full circle is 26
     of them. */
  let q = await look();
  for (let i = 0; i < steps; i++) {
    if (!q.behind && Math.abs(q.x) < 0.30 && Math.abs(q.y) < 0.85) return { ...q, drags: i };
    await page.mouse.move(640, 380);
    await page.mouse.down();
    for (let k = 1; k <= 6; k++) { await page.mouse.move(640 + (200 * k) / 6, 380); await page.waitForTimeout(35); }
    await page.mouse.up();
    await page.waitForTimeout(650);
    q = await look();
  }
  return { ...q, drags: -1 };
}

async function drive(target, stop, budget = 60) {
  for (let s = 0; s < budget; s++) {
    const q = await page.evaluate(([tx, tz]) => {
      const c = window.WALLY.ctx, p = c.wally.root.position;
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      const f = new window.WALLY.THREE.Vector3();
      c.camera.getWorldDirection(f); f.y = 0; f.normalize();
      return { d, fwd: (dx * f.x + dz * f.z) / (d || 1), right: (dx * -f.z + dz * f.x) / (d || 1) };
    }, target);
    if (q.d < stop) return +q.d.toFixed(2);
    const ks = [];
    if (q.fwd > 0.35) ks.push('KeyW'); else if (q.fwd < -0.35) ks.push('KeyS');
    if (q.right > 0.35) ks.push('KeyD'); else if (q.right < -0.35) ks.push('KeyA');
    if (!ks.length) ks.push(q.fwd >= 0 ? 'KeyW' : 'KeyS');
    for (const k of ks) await page.keyboard.down(k);
    await page.waitForTimeout(Math.min(260, Math.max(90, (q.d - stop) * 55)));
    for (const k of ks) await page.keyboard.up(k);
  }
  return -1;
}

const own = async (ids) => page.evaluate((list) => {
  const a = window.WALLY.ctx.game.actions;
  for (const id of list) a.grantRide(id);
  return a.bike();
}, ids);
const equip = async (id) => { await page.evaluate((i) => window.WALLY.ctx.game.actions.equipRide(i), id); await page.waitForTimeout(1800); };

/* ------------------------------------------------------------------ */
if (MODE === 'one') await own(['bike']); else await own(['bike', 'scooter']);
P('owned', await st().then((s) => s.gameRide));

await equip('bike');
P('mounted-bike', (await st()).rideState);

await equip(null);                       // dismount -> parkProp()
await page.waitForTimeout(1200);
const parkedAt = await page.evaluate(() => window.WALLY.ctx.wally.rideProps.bike.group.position.toArray().map((v) => +v.toFixed(2)));
P('after-dismount', { state: (await st()).rideState, bikeGroupAt: parkedAt, bikeProbe: await probe('bike') });

if (MODE === 'one') {
  await drive([parkedAt[0] + 24, parkedAt[2] + 10], 3);
  P('walked-away', { at: await pos(), bike: await probe('bike') });
  await drive([parkedAt[0], parkedAt[2]], 7);
  await page.waitForTimeout(900);
  P('aimed', await aim('bike'));
  const pr = await probe('bike');
  P('FINAL-one-machine', { state: (await st()).rideState, bike: pr, pixelDelta: await pix('bike') });
  await page.screenshot({ path: '/tmp/jj-park-one.png' });
} else {
  await equip('scooter');
  P('mounted-scooter', { state: (await st()).rideState, bikeProbe: await probe('bike') });

  const away = [parkedAt[0] + 30, parkedAt[2] + 14];
  P('rode-away-dist', await drive(away, 3));
  P('while-away', { at: await pos(), bike: await probe('bike'), state: (await st()).rideState });

  P('came-back-dist', await drive([parkedAt[0], parkedAt[2]], 7));
  await page.waitForTimeout(900);
  P('aimed', await aim('bike'));
  const pr = await probe('bike');
  P('FINAL-parked-bike-after-riding-other', { state: (await st()).rideState, bike: pr, pixelDelta: await pix('bike') });
  await page.screenshot({ path: '/tmp/jj-park-two.png' });

  if (MODE === 'both') {
    /* now park the scooter too */
    await equip(null);
    await page.waitForTimeout(1400);
    const sAt = await page.evaluate(() => window.WALLY.ctx.wally.rideProps.scooter.group.position.toArray().map((v) => +v.toFixed(2)));
    P('scooter-parked-at', sAt);
    await drive([(parkedAt[0] + sAt[0]) / 2 + 9, (parkedAt[2] + sAt[2]) / 2 + 9], 3);
    await drive([(parkedAt[0] + sAt[0]) / 2, (parkedAt[2] + sAt[2]) / 2], 6);
    await page.waitForTimeout(900);
    P('aimed-bike', await aim('bike'));
    const bikeR = { probe: await probe('bike'), info: await pix('bike') };
    await page.screenshot({ path: '/tmp/jj-park-both-bike.png' });
    P('aimed-scooter', await aim('scooter'));
    P('BOTH', { bike: bikeR, scooter: { probe: await probe('scooter'), info: await pix('scooter') } });
    P('FINAL-both-parked', { state: (await st()).rideState,
      bike: await probe('bike'), bikePixels: await pix('bike'),
      scooter: await probe('scooter'), scooterPixels: await pix('scooter') });
    await page.screenshot({ path: '/tmp/jj-park-both.png' });
  }
}
P('ERRS', errs.slice(0, 6));
await close();
