/* _jj/opener.mjs — PLAY THE OPENER and look at what is standing there.
   No skipIntro, no seek: the real sequence, start to finish. */
import { boot, P } from './lib.mjs';
const { page, errs, close } = await boot({ query: '', wait: 2500 });

await page.evaluate(() => window.WALLY.debug.begin());
await page.waitForTimeout(400);
P('intro-marks', await page.evaluate(() => window.WALLY.debug.introMarks?.() || null));

const snap = async (tag, shot) => {
  const s = await page.evaluate(() => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE;
    const st = c.intro?.state?.() || null;
    const b = c.intro?.bicycle || c.intro?.bike || null;
    const g = b && (b.group || b);
    let info = null;
    if (g) {
      g.updateMatrixWorld(true);
      const ctr = new T.Box3().setFromObject(g, true).getCenter(new T.Vector3());
      const n = ctr.clone().project(c.camera);
      info = { at: g.position.toArray().map((v) => +v.toFixed(2)), visible: g.visible,
        parent: g.parent === c.scene ? 'scene' : (g.parent ? g.parent.name || g.parent.type : null),
        distFromWally: +ctr.distanceTo(c.wally.root.position).toFixed(2),
        onScreen: n.z < 1 && Math.abs(n.x) < 1 && Math.abs(n.y) < 1 };
    }
    return { t: +(c.elapsed).toFixed(1), intro: st, bicycle: info,
      owns: c.game?.actions?.bike?.() || null,
      wallyAt: c.wally.root.position.toArray().map((v) => +v.toFixed(2)),
      ridesOwned: c.game?.state?.rides?.owned || null };
  });
  P(tag, s);
  if (shot) await page.screenshot({ path: shot });
  return s;
};

/* let it run the whole opener */
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(4000);
  const s = await snap('t+' + ((i + 1) * 4) + 's');
  if (s.intro && s.intro.running === false) break;
}
await page.waitForTimeout(1200);
await snap('handover', '/tmp/jj-opener-handover.png');
await page.waitForTimeout(2600);
await snap('handover+2.6s (RETIRE_HOLD)', '/tmp/jj-opener-hold.png');
await page.waitForTimeout(3000);
await snap('staring-at-it', '/tmp/jj-opener-stare.png');

/* now look away — the frustum test is the only thing keeping it */
async function drag(px, n = 1) {
  for (let i = 0; i < n; i++) {
    await page.mouse.move(640, 380); await page.mouse.down();
    for (let k = 1; k <= 6; k++) { await page.mouse.move(640 + (px * k) / 6, 380); await page.waitForTimeout(30); }
    await page.mouse.up(); await page.waitForTimeout(420);
  }
}
await page.mouse.click(640, 400);
await drag(240, 8);
await page.waitForTimeout(1200);
await snap('turned-away', '/tmp/jj-opener-away.png');
await drag(240, 8);
await page.waitForTimeout(1600);
await snap('turned-back', '/tmp/jj-opener-back.png');

/* and the economy: what does the shop want for one? */
P('economy', await page.evaluate(() => {
  const c = window.WALLY.ctx, g = c.game;
  const D = g.data || null;
  return { money: g.state.money, rides: g.actions.rides ? g.actions.rides() : null,
    bikeAction: g.actions.bike(), owned: g.state.rides.owned };
}));
P('ERRS', errs.slice(0, 6));
await close();
