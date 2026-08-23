/* _jj/opener2.mjs — the arrival bicycle, tracked by NAME in the scene
   ('intro.bicycle', set in shots.js createBicycle) rather than through
   an api accessor the module does not publish, plus the collect event. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ query: '', wait: 2500 });

await page.evaluate(() => {
  const c = window.WALLY.ctx;
  window.__O = { events: [] };
  c.bus.on('intro:bikeCollected', () => window.__O.events.push({ t: +c.elapsed.toFixed(2), e: 'collected' }));
  window.__O.find = () => {
    let g = null;
    c.scene.traverse((o) => { if (o.name === 'intro.bicycle') g = o; });
    if (!g) return null;
    const T = window.WALLY.THREE;
    g.updateMatrixWorld(true);
    const ctr = new T.Box3().setFromObject(g, true).getCenter(new T.Vector3());
    const n = ctr.clone().project(c.camera);
    /* is it drawn? walk the parent chain — three's raycaster does not */
    let drawn = true; for (let p = g; p; p = p.parent) if (!p.visible) drawn = false;
    return { at: g.position.toArray().map((v) => +v.toFixed(2)), drawn,
      distFromWally: +ctr.distanceTo(c.wally.root.position).toFixed(2),
      inFrame: n.z < 1 && Math.abs(n.x) < 1 && Math.abs(n.y) < 1,
      ndc: [+n.x.toFixed(2), +n.y.toFixed(2)] };
  };
});
await page.evaluate(() => window.WALLY.debug.begin());

const snap = async (tag, shot) => {
  const s = await page.evaluate(() => ({
    t: +window.WALLY.ctx.elapsed.toFixed(1),
    running: window.WALLY.ctx.intro.state().running,
    bicycle: window.__O.find(),
    events: window.__O.events,
    owns: window.WALLY.ctx.game.state.rides.owned,
  }));
  P(tag, s);
  if (shot) await page.screenshot({ path: shot });
  return s;
};
await page.waitForTimeout(24000);
await snap('mid-ride (SEQ C)');
await page.waitForTimeout(13000);
await snap('handover', '/tmp/jj-op2-handover.png');
await page.waitForTimeout(3000);
await snap('+3s, still looking');
await page.waitForTimeout(6000);
await snap('+9s, still looking', '/tmp/jj-op2-stare.png');

/* turn away exactly once, then straight back */
async function drag(px, n) {
  for (let i = 0; i < n; i++) {
    await page.mouse.move(640, 380); await page.mouse.down();
    for (let k = 1; k <= 6; k++) { await page.mouse.move(640 + (px * k) / 6, 380); await page.waitForTimeout(30); }
    await page.mouse.up(); await page.waitForTimeout(400);
  }
}
await page.mouse.click(640, 400);
await drag(300, 7);
await page.waitForTimeout(1000);
await snap('orbited-away', '/tmp/jj-op2-away.png');
/* the orbit alone never takes it out of frame — the follow rig
   re-centres. WALK away instead, which is what a player does. */
await page.keyboard.down('KeyW');
for (let i = 0; i < 8; i++) { await page.waitForTimeout(1000); const s = await snap('walking t+' + (i + 1) + 's'); if (!s.bicycle) break; }
await page.keyboard.up('KeyW');
await page.waitForTimeout(800);
await snap('after-walk', '/tmp/jj-op2-walk.png');
/* turn round and walk back to where it was */
await drag(300, 13);
await page.keyboard.down('KeyW');
await page.waitForTimeout(6000);
await page.keyboard.up('KeyW');
await page.waitForTimeout(1200);
await snap('walked-back', '/tmp/jj-op2-back.png');
P('ERRS', errs.slice(0, 6));
await close();
