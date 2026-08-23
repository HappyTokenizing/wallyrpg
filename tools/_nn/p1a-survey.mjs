/* Survey the island for park sites at a spread of gradients — measured
   where parkProp actually puts the machine (0.62 m to the rider's -x),
   with parkProp's own two-pass arithmetic reproduced here from scratch. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 4000 });
const r = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
  const CLAMP = 0.838;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* prop geometry, read off the real prop */
  W.ctx.wally.setBike(true, { ride: 'bike', instant: true });
  const p = W.ctx.wally.rideProps.bike;
  const g = p.group;
  const cz = (w) => { let z = 0; for (let n = w; n && n !== g; n = n.parent) z += n.position.z; return z; };
  const zf = cz(p.wheels[0]), zr = cz(p.wheels[1]);
  W.ctx.wally.setBike(false, { instant: true });
  const base = zf - zr;

  /* parkProp's own arithmetic, reproduced independently */
  const rawAt = (px, pz, yaw) => {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const hf0 = H(px + fx * zf, pz + fz * zf), hr0 = H(px + fx * zr, pz + fz * zr);
    if (hf0 == null || hr0 == null) return null;
    let raw = Math.atan2(hr0 - hf0, base);
    let pitch = clamp(raw, -CLAMP, CLAMP);
    const cf = Math.cos(pitch);
    const hf = H(px + fx * zf * cf, pz + fz * zf * cf), hr = H(px + fx * zr * cf, pz + fz * zr * cf);
    if (hf == null || hr == null) return { raw, pass: 1 };
    raw = Math.asin(clamp((hr - hf) / base, -1, 1));
    return { raw, pass: 2 };
  };

  const sites = [];
  const R = 900;
  for (let x = -R; x <= R; x += 6) {
    for (let z = -R; z <= R; z += 6) {
      const h = H(x, z);
      if (h == null || h < 0.4) continue;      // skip sea
      for (let a = 0; a < 8; a++) {
        const yaw = (a / 8) * Math.PI * 2;
        const ox = -0.62;
        const px = x + Math.cos(yaw) * ox, pz = z - Math.sin(yaw) * ox;
        const q = rawAt(px, pz, yaw);
        if (!q || q.pass !== 2) continue;
        sites.push({ x, z, yaw: +yaw.toFixed(4), deg: +(q.raw * 180 / Math.PI).toFixed(3) });
      }
    }
  }
  /* pick the closest site to each target gradient */
  const targets = [0, 2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41, 43, 44, 45, 46, 47, 47.8,
    -5, -14, -23, -32, -41, -44, -45, -46, -47, -47.8, 48.4, 52, 60, 76];
  const picks = targets.map((t) => {
    let best = null, bd = 1e9;
    for (const s of sites) { const d = Math.abs(s.deg - t); if (d < bd) { bd = d; best = s; } }
    return { target: t, miss: +bd.toFixed(3), ...best };
  });
  const hist = {};
  for (const s of sites) { const k = Math.floor(Math.abs(s.deg) / 5) * 5; hist[k] = (hist[k] || 0) + 1; }
  return { zf, zr, base: +base.toFixed(4), nSites: sites.length, hist, picks };
});
P('GEOM', { zf: r.zf, zr: r.zr, base: r.base, nSites: r.nSites, hist: r.hist });
for (const q of r.picks) P('SITE', q);
P('ERRS', errs.slice(0, 6));
await close();
