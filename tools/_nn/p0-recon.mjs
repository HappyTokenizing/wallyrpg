/* what is actually on the runtime surface, and the prop geometry I need */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ wait: 4000 });
const r = await page.evaluate(async () => {
  const W = window.WALLY, c = W.ctx, dbg = W.debug;
  const out = { hooks: Object.keys(dbg).sort(), dpr: c.render?.renderer?.getPixelRatio?.() ?? null };
  out.world = { heightAt: typeof c.world?.heightAt, hasCity: !!(c.world?.city || c.city) };
  // build all three props by mounting each
  const props = {};
  for (const id of ['bike', 'scooter', 'motorcycle']) {
    W.ctx.wally.setBike(true, { ride: id, instant: true });
    const p = W.ctx.wally.rideProps[id];
    if (!p) { props[id] = null; continue; }
    const g = p.group;
    const walk = (w) => { let z = 0, x = 0; for (let n = w; n && n !== g; n = n.parent) { z += n.position.z; x += n.position.x; } return [x, z]; };
    props[id] = {
      wheels: (p.wheels || []).map((w, i) => ({ i, name: w.name || null, contact: walk(w).map((v) => +v.toFixed(4)), axleY: +w.position.y.toFixed(4) })),
      keys: Object.keys(p).sort(),
      hasCrank: !!p.crank, wheelbase: p.wheelbase ?? null,
      parkLean: p.parkLean ?? null,
      parkArity: p.park ? p.park.length : null,
      groupParent: g.parent ? (g.parent === c.scene ? 'scene' : (g.parent.name || 'root')) : null,
    };
  }
  W.ctx.wally.setBike(false, { instant: true });
  out.props = props;
  out.pos = c.wally.root.position.toArray().map((v) => +v.toFixed(2));
  out.renderStats = c.render?.stats ? c.render.stats() : null;
  return out;
});
P('RECON', r);
P('ERRS', errs.slice(0, 6));
await close();
