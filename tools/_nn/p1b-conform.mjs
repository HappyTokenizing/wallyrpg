/* THE CONFORM, measured through the REAL gameplay path (grant + equip,
   then unequip -> the animated dismount -> parkProp), never through
   parkProbe. Every number here is computed from the prop's own world
   matrix and ctx.world.heightAt, independently of anything the game
   reports about itself.
   node tools/_nn/p1b-conform.mjs [ride] [sitesJson] */
import { boot, P } from './lib.mjs';
import { readFile } from 'node:fs/promises';

const RIDE = process.argv[2] || 'bike';
const SITES = JSON.parse(await readFile(process.argv[3] || new URL('./sites.json', import.meta.url), 'utf8'));

const { page, errs, close } = await boot({ wait: 4000 });

await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  window.__NN = {
    H: (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } },
    /* both wheel contacts of a prop, in world, straight off its matrix */
    contacts: (p) => {
      const g = p.group; g.updateMatrixWorld(true);
      return (p.wheels || []).map((w, i) => {
        let x = 0, z = 0;
        for (let n = w; n && n !== g; n = n.parent) { x += n.position.x; z += n.position.z; }
        const v = new W.THREE.Vector3(x, 0, z).applyMatrix4(g.matrixWorld);
        const h = window.__NN.H(v.x, v.z);
        return { i, at: [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)],
          terrain: h == null ? null : +h.toFixed(4),
          clearMM: h == null ? null : +((v.y - h) * 1000).toFixed(1) };
      });
    },
    /* the gradient of the GROUND under a machine standing at (px,pz)
       facing yaw, by parkProp's own two-pass rule, recomputed here */
    ground: (px, pz, yaw, zf, zr) => {
      const H = window.__NN.H, base = zf - zr;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const hf0 = H(px + fx * zf, pz + fz * zf), hr0 = H(px + fx * zr, pz + fz * zr);
      if (hf0 == null || hr0 == null) return null;
      const raw1 = Math.atan2(hr0 - hf0, base);
      const cl = Math.max(-0.838, Math.min(0.838, raw1));
      const cf = Math.cos(cl);
      const hf = H(px + fx * zf * cf, pz + fz * zf * cf), hr = H(px + fx * zr * cf, pz + fz * zr * cf);
      if (hf == null || hr == null) return { deg1: raw1 * 180 / Math.PI, deg: raw1 * 180 / Math.PI, pass: 1 };
      const raw2 = Math.asin(Math.max(-1, Math.min(1, (hr - hf) / base)));
      return { deg1: +(raw1 * 180 / Math.PI).toFixed(3), deg: +(raw2 * 180 / Math.PI).toFixed(3), pass: 2 };
    },
    zOf: (p) => {
      const g = p.group;
      const cz = (w) => { let z = 0; for (let n = w; n && n !== g; n = n.parent) z += n.position.z; return z; };
      return [cz(p.wheels[0]), cz(p.wheels[1])];
    },
  };
});

const rows = [];
for (const s of SITES) {
  /* --- 1. the probe's own answer, first, on a clean slate --- */
  const probe = await page.evaluate(([q, ride]) => window.WALLY.debug.parkProbe(q.x, q.z, q.yaw, ride), [s, RIDE]);

  /* --- 2. the real thing: teleport, own it, ride it, unequip --- */
  await page.evaluate(([q, ride]) => {
    const W = window.WALLY;
    const h = window.__NN.H(q.x, q.z) ?? 0;
    W.ctx.wally.setPosition(q.x, h, q.z);
    W.ctx.wally.setYaw(q.yaw);
    W.debug.giveRide(ride);
  }, [s, RIDE]);
  await page.waitForTimeout(500);
  await page.evaluate(([q]) => {
    const W = window.WALLY;
    const h = window.__NN.H(q.x, q.z) ?? 0;
    W.ctx.wally.setPosition(q.x, h, q.z);      // hold him still for the dismount
    W.ctx.wally.setYaw(q.yaw);
    W.ctx.game.actions.equipRide(null);
  }, [s]);
  await page.waitForTimeout(900);

  const m = await page.evaluate(([q, ride]) => {
    const W = window.WALLY, N = window.__NN;
    const p = W.ctx.wally.rideProps[ride];
    if (!p) return { error: 'no prop' };
    const g = p.group;
    const [zf, zr] = N.zOf(p);
    const cts = N.contacts(p);
    const gp = g.position;
    const gr = N.ground(gp.x, gp.z, g.rotation.y, zf, zr);
    const stand = g.getObjectByName('kickstand');
    const rp = W.ctx.wally.root.position;
    return {
      parkedIds: W.ctx.wally.bikeState.parked.map((r) => r.id),
      riderAt: [+rp.x.toFixed(2), +rp.z.toFixed(2)],
      machineAt: [+gp.x.toFixed(3), +gp.z.toFixed(3)], machineY: +gp.y.toFixed(4),
      offsetM: +Math.hypot(gp.x - rp.x, gp.z - rp.z).toFixed(3),
      order: g.rotation.order,
      pitchDeg: +(g.rotation.x * 180 / Math.PI).toFixed(3),
      rollDeg: +(g.rotation.z * 180 / Math.PI).toFixed(3),
      groundDeg: gr ? gr.deg : null, groundDeg1: gr ? gr.deg1 : null,
      parentIsScene: g.parent === W.ctx.scene,
      visible: g.visible, standVisible: stand ? stand.visible : null,
      clearMM: cts.map((c) => c.clearMM),
    };
  }, [s, RIDE]);

  /* --- 3. recompute the ground gradient at the position the PROBE says
         it used, so the probe's own number can be checked --- */
  const chk = await page.evaluate(([pr, ride]) => {
    const W = window.WALLY, N = window.__NN;
    const p = W.ctx.wally.rideProps[ride];
    if (!p || !pr.machineAt) return null;
    const [zf, zr] = N.zOf(p);
    return N.ground(pr.machineAt[0], pr.machineAt[1], pr.yaw, zf, zr);
  }, [probe, RIDE]);

  /* put it away so the next site starts clean */
  await page.evaluate(() => { window.WALLY.ctx.wally.setBike(false, { instant: true }); });
  await page.waitForTimeout(120);

  const row = { target: s.deg, ride: RIDE,
    real: { groundDeg: m.groundDeg, pitchDeg: m.pitchDeg, clearMM: m.clearMM, offsetM: m.offsetM,
      roll: m.rollDeg, stand: m.standVisible, scene: m.parentIsScene, vis: m.visible, order: m.order,
      parked: m.parkedIds },
    probe: { gradientDeg: probe.gradientDeg, clamped: probe.clamped, pitchDeg: probe.pitchDeg,
      wheels: (probe.wheels || []).map((w) => w.errMM), machineAt: probe.machineAt, offsetX: probe.offsetX },
    probeGroundDeg: chk ? chk.deg : null,
    probeErrDeg: (chk && probe.gradientDeg != null) ? +(probe.gradientDeg - chk.deg).toFixed(2) : null,
    trueClamped: chk ? Math.abs(chk.deg) > 48.0 : null };
  rows.push(row);
  P('ROW', row);
}
P('ERRS', errs.slice(0, 8));
await close();
