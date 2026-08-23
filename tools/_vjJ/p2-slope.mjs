/* p2 — SLOPE CONFORM. Park a machine on a flat door pad and on a
   measured gradient, and measure BOTH wheels' clearance two ways:
     tyreMinMM   the lowest TYRE VERTEX of that wheel, world-transformed,
                 against ctx.world.heightAt under it. This is the honest
                 one: it accounts for the park lean, the pitch and the
                 torus section, none of which parkProp reasons about.
     axleMM      the point directly under the axle in the MACHINE's own
                 frame, which is the point parkProp is actually placing
                 and therefore the number comparable to the -114/+90 the
                 defect was reported with.
   Nothing is read from a debug ruler. */
import { boot } from './lib.mjs';

const RIDE = process.argv[2] || 'bike';
const { page, browser, server, errs } = await boot({ w: 900, h: 560 });

await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  window.__M = {
    H: (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : NaN; } catch (e) { return NaN; } },
    /* gradient by central differences over a 1 m span */
    slopeDeg(x, z) {
      const H = window.__M.H, d = 0.5;
      const gx = (H(x + d, z) - H(x - d, z)) / (2 * d);
      const gz = (H(x, z + d) - H(x, z - d)) / (2 * d);
      return { deg: +(Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI).toFixed(3), gx: +gx.toFixed(4), gz: +gz.toFixed(4) };
    },
    /* every wheel of the current prop, measured */
    wheels() {
      const w = c.wally, b = w.bike;
      if (!b) return null;
      b.group.updateMatrixWorld(true);
      const H = window.__M.H;
      const out = [];
      b.wheels.forEach((wh, i) => {
        wh.updateMatrixWorld(true);
        /* the TYRE is the torus mesh */
        let tyre = null;
        wh.traverse((o) => { if (!tyre && o.isMesh && o.geometry && o.geometry.type === 'TorusGeometry' && o.geometry.parameters.radius > 0.1) tyre = o; });
        if (!tyre) wh.traverse((o) => { if (!tyre && o.isMesh && o.geometry && o.geometry.type === 'TorusGeometry') tyre = o; });
        let minC = Infinity, at = null;
        if (tyre) {
          const pos = tyre.geometry.attributes.position;
          const V = new T.Vector3();
          for (let k = 0; k < pos.count; k++) {
            V.fromBufferAttribute(pos, k); tyre.localToWorld(V);
            const cl = V.y - H(V.x, V.z);
            if (cl < minC) { minC = cl; at = [+V.x.toFixed(3), +V.y.toFixed(3), +V.z.toFixed(3)]; }
          }
        }
        /* UNDER-AXLE POINT IN THE MACHINE'S OWN FRAME — the point
           parkProp is placing. NOT wheel-local (0,-R,0): the wheel group
           carries the rolling angle on x, so that is a material point on
           the rim that has spun away from the bottom. It cost me 131 mm
           of phantom clearance on a flat pad before I caught it. Take the
           axle's world position and step R along the MACHINE's own down
           axis instead. */
        const R = wh.position.y;
        const AW = new T.Vector3(); wh.getWorldPosition(AW);
        const DN = new T.Vector3(0, -1, 0).transformDirection(b.group.matrixWorld).normalize();
        const A = AW.clone().addScaledVector(DN, R);
        const axleC = A.y - H(A.x, A.z);
        out.push({ i, R: +R.toFixed(4), tyreMinMM: +(minC * 1000).toFixed(1), tyreAt: at,
          axleMM: +(axleC * 1000).toFixed(1), axleWorld: [+AW.x.toFixed(3), +AW.y.toFixed(3), +AW.z.toFixed(3)],
          localZ: +wh.position.z.toFixed(3) });
      });
      return out;
    },
    state() {
      const w = c.wally, b = w.bike;
      return { ride: w.bikeState && w.bikeState.ride, id: w.bikeState && w.bikeState.id,
        parked: w.bikeState && w.bikeState.parked,
        gpar: b ? (b.group.parent === c.scene ? 'scene' : (b.group.parent === w.root ? 'root' : 'other')) : null,
        gpos: b ? [+b.group.position.x.toFixed(3), +b.group.position.y.toFixed(3), +b.group.position.z.toFixed(3)] : null,
        grot: b ? [+b.group.rotation.x.toFixed(4), +b.group.rotation.y.toFixed(4), +b.group.rotation.z.toFixed(4), b.group.rotation.order] : null,
        vis: b ? b.group.visible : null, stand: b && b.stand ? b.stand.visible : null };
    },
  };
});

async function walk(secs, keys = ['KeyW']) {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(secs * 1000);
  for (const k of keys) await page.keyboard.up(k);
  await page.waitForTimeout(900);
}

const door = await page.evaluate((ride) => {
  const c = window.WALLY.ctx;
  const cy = c.world.city || c.city;
  const v = cy.doorPosition('apartment');
  c.game.actions.grantRide(ride); c.game.actions.equipRide(ride);
  return [v.x, v.y, v.z];
}, RIDE);
await page.waitForTimeout(2000);

/* ---- CASE A: the flat door pad ---- */
await page.evaluate((d) => {
  const c = window.WALLY.ctx;
  const h = window.__M.H(d[0] + 1.2, d[2] + 1.2);
  c.wally.setPosition(d[0] + 1.2, h, d[2] + 1.2);
}, door);
await page.waitForTimeout(1200);
await walk(0.45);
const slopeA = await page.evaluate(() => { const p = window.WALLY.ctx.wally.root.position; return { at: [+p.x.toFixed(2), +p.z.toFixed(2)], ...window.__M.slopeDeg(p.x, p.z) }; });
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2200);
const flat = { slope: slopeA, state: await page.evaluate(() => window.__M.state()), wheels: await page.evaluate(() => window.__M.wheels()) };

/* ---- gradient sites: the shallowest ring that hits each band, all
   within ~15 m of that same door ---- */
const spots = await page.evaluate((d) => {
  const M = window.__M;
  const cand = [];
  for (let a = 0; a < 180; a++) {
    for (let r = 6; r <= 15; r += 0.5) {
      const th = (a / 180) * Math.PI * 2;
      const x = d[0] + Math.cos(th) * r, z = d[2] + Math.sin(th) * r;
      const h = M.H(x, z);
      if (!Number.isFinite(h) || h < 1) continue;
      cand.push({ x: +x.toFixed(3), z: +z.toFixed(3), y: +h.toFixed(3), deg: M.slopeDeg(x, z).deg, r: +r.toFixed(1) });
    }
  }
  const pick = (lo, hi) => {
    const inb = cand.filter((c) => c.deg >= lo && c.deg < hi);
    return inb.length ? inb[Math.floor(inb.length / 2)] : null;
  };
  /* the DOWNHILL bearing at each site, so he can be faced straight down
     it and the whole gradient lands on the machine's own pitch axis */
  const withYaw = (c) => {
    if (!c) return null;
    const M = window.__M, d2 = 0.5;
    const gx = (M.H(c.x + d2, c.z) - M.H(c.x - d2, c.z)) / (2 * d2);
    const gz = (M.H(c.x, c.z + d2) - M.H(c.x, c.z - d2)) / (2 * d2);
    /* forward is +z; yaw such that (sin yaw, cos yaw) points DOWNhill */
    c.yaw = Math.atan2(-gx, -gz);
    c.alongDeg = +(Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI).toFixed(2);
    return c;
  };
  return { bands: [pick(3, 6), pick(7, 9), pick(9, 12), pick(13, 15), pick(16, 20), pick(24, 90)].filter(Boolean).map(withYaw), maxDeg: Math.max(...cand.map((c) => c.deg)) };
}, door);

const cases = [];
for (const s of spots.bands) {
  await page.evaluate((r) => { window.WALLY.ctx.game.actions.equipRide(r); }, RIDE);
  await page.waitForTimeout(1500);
  await page.evaluate((q) => { const w = window.WALLY.ctx.wally; w.setPosition(q.x, window.__M.H(q.x, q.z), q.z); w.setYaw(q.yaw); }, s);
  await page.waitForTimeout(1400);
  await page.evaluate((q) => { window.WALLY.ctx.wally.setYaw(q.yaw); }, s);
  await page.waitForTimeout(600);
  const slope = await page.evaluate(() => { const p = window.WALLY.ctx.wally.root.position; return { at: [+p.x.toFixed(2), +p.z.toFixed(2)], ...window.__M.slopeDeg(p.x, p.z) }; });
  await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
  await page.waitForTimeout(2200);
  const st = await page.evaluate(() => window.__M.state());
  const wh = await page.evaluate(() => window.__M.wheels());
  await page.screenshot({ path: `/tmp/vjJ-slope-${RIDE}-${Math.round(slope.deg)}.png` });
  cases.push({ target: s, sepFromDoorM: +Math.hypot(s.x - door[0], s.z - door[2]).toFixed(2), slope, pitchDeg: +(st.grot[0] * 180 / Math.PI).toFixed(2), wheels: wh, state: st });
}

console.log(JSON.stringify({ ride: RIDE, door, flat, maxSlopeNearbyDeg: +spots.maxDeg.toFixed(1), cases, errs: errs.slice(0, 6) }, null, 1));
await browser.close(); server.close();
