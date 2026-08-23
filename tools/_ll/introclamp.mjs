/* _ll/introclamp.mjs — the opener's conform against the game's, on the
   same ground, with no rendering involved.

   WHY THIS EXISTS. intro.js's parkArrival() solves the placement of the
   arrival bicycle with ONE height sample per wheel and clamps the pitch
   at 0.26 rad — 14.9 degrees, the number wally.js's parkProp() used to
   use before it was moved to the controller's own 48-degree slope
   limit. But shots.js's chooseStage() accepts a pad at slope 0.42,
   which is 22.8 degrees: the opener can therefore be handed ground
   steeper than its own clamp allows, by its own stage picker, and
   saturate on it.

   So run both solves over the same sites and print both wheel contacts
   for each. If the numbers are equal everywhere the clamp is academic
   and the code stays as it is. Sites are chosen by the raw gradient at
   the sampling position, exactly as _kk/clamp.mjs picks them. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot();

const out = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const WB = 0.94;                    // measured off the prop, axle to axle
  const ZF = WB * 0.5, ZR = -ZF, BASE = ZF - ZR;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* THE OPENER'S SOLVE, exactly as parkArrival() writes it. */
  const intro = (px, pz, yaw) => {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const hf = H(px + fx * ZF, pz + fz * ZF), hr = H(px + fx * ZR, pz + fz * ZR);
    if (hf == null || hr == null) return null;
    const raw = Math.atan2(hr - hf, BASE);
    return { pitch: clamp(raw, -0.26, 0.26), y: (hf + hr) * 0.5, raw };
  };

  /* THE GAME'S, as parkProp() writes it: pass one for the chord, pass
     two under the contacts as ROTATED, then the anti-burial lift, and
     only when the clamp has actually engaged. */
  const game = (px, pz, yaw, MAX = 0.838) => {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const hf0 = H(px + fx * ZF, pz + fz * ZF), hr0 = H(px + fx * ZR, pz + fz * ZR);
    if (hf0 == null || hr0 == null) return null;
    let raw = Math.atan2(hr0 - hf0, BASE);
    let pitch = clamp(raw, -MAX, MAX);
    let y = (hf0 + hr0) * 0.5;
    const cf = Math.cos(pitch);
    const hf = H(px + fx * ZF * cf, pz + fz * ZF * cf), hr = H(px + fx * ZR * cf, pz + fz * ZR * cf);
    if (hf != null && hr != null) {
      raw = Math.asin(clamp((hr - hf) / BASE, -1, 1));
      pitch = clamp(raw, -MAX, MAX);
      y = (hf + hr) * 0.5 + (ZF + ZR) * 0.5 * Math.sin(pitch);
    }
    if (Math.abs(raw) > MAX) {
      const s = Math.sin(pitch), c2 = Math.cos(pitch);
      const hf2 = H(px + fx * ZF * c2, pz + fz * ZF * c2) ?? hf0;
      const hr2 = H(px + fx * ZR * c2, pz + fz * ZR * c2) ?? hr0;
      const sag = Math.min(y - ZF * s - hf2, y - ZR * s - hr2);
      if (Number.isFinite(sag) && sag < 0) y -= sag;
    }
    return { pitch, y, raw };
  };

  /* WHERE THE WHEELS ACTUALLY END UP. Rx sends (0,0,z) to
     y = -z sin(p) at a horizontal reach of z cos(p). Positive is
     hovering, negative is buried. */
  const err = (px, pz, yaw, sol) => {
    if (!sol) return null;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const s = Math.sin(sol.pitch), cs = Math.cos(sol.pitch);
    return [ZF, ZR].map((z) => {
      const h = H(px + fx * z * cs, pz + fz * z * cs);
      return h == null ? null : +((sol.y - z * s - h) * 1000).toFixed(1);
    });
  };

  /* sites, by the raw gradient at the sampling position */
  const found = {};
  for (let x = -700; x <= 700; x += 5) for (let z = -700; z <= 700; z += 5) {
    for (let k = 0; k < 8; k++) {
      const yaw = (k / 8) * Math.PI * 2;
      const g = game(x, z, yaw, 10);
      if (!g) continue;
      const b = Math.round(Math.abs(g.raw * 180 / Math.PI));
      if (!found[b]) found[b] = { x, z, yaw: +yaw.toFixed(4), deg: +(g.raw * 180 / Math.PI).toFixed(2) };
    }
  }
  const rows = [];
  for (const d of [2, 5, 9, 12, 15, 18, 21, 23, 26, 30, 35, 40, 45, 47]) {
    const f = found[d]; if (!f) continue;
    const gi = intro(f.x, f.z, f.yaw), gg = game(f.x, f.z, f.yaw);
    rows.push({ deg: f.deg,
      introPitchDeg: gi ? +(gi.pitch * 180 / Math.PI).toFixed(2) : null,
      introMM: err(f.x, f.z, f.yaw, gi),
      gamePitchDeg: gg ? +(gg.pitch * 180 / Math.PI).toFixed(2) : null,
      gameMM: err(f.x, f.z, f.yaw, gg) });
  }
  return rows;
});
for (const r of out) P('site', r);
P('ERRS', errs.slice(0, 4));
await close();
