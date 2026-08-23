/* p3b — the same test twice, with only the ORDER of ownership changed,
   plus a trace of wally's own rideId through the dismount so the failure
   can be attributed to a line rather than guessed at. */
import { boot } from './lib.mjs';
const OWN_FIRST = process.argv[2] === 'both';   // does he already own the scooter when he parks?
const { page, browser, server, errs } = await boot({ w: 900, h: 560 });

await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const tr = [];
  window.__T = { tr, on: false, start() { tr.length = 0; this.on = true; }, stop() { this.on = false; return tr; } };
  c._handles.push({ lateUpdate() {
    if (!window.__T.on) return;
    const w = c.wally, s = w.bikeState;
    const last = tr[tr.length - 1];
    const row = { t: +c.elapsed.toFixed(2), id: s.id, phase: s.phase, ride: +s.ride.toFixed(2),
      parked: s.parked.map((p) => p.id).join(','), gameId: (() => { try { return c.game.actions.bike().id; } catch (e) { return '?'; } })() };
    if (!last || last.id !== row.id || last.phase !== row.phase || last.parked !== row.parked) tr.push(row);
  } });
});

const door = await page.evaluate((both) => {
  const c = window.WALLY.ctx;
  const v = (c.world.city || c.city).doorPosition('apartment');
  c.game.actions.grantRide('bike');
  if (both) c.game.actions.grantRide('scooter');
  c.game.actions.equipRide('bike');
  c.wally.setPosition(v.x + 2, c.world.heightAt(v.x + 2, v.z + 2), v.z + 2);
  return [v.x, v.y, v.z];
}, OWN_FIRST);
await page.waitForTimeout(2600);
await page.evaluate(() => window.__T.start());
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
await page.waitForTimeout(2600);
const afterPark = await page.evaluate(() => {
  const c = window.WALLY.ctx, w = c.wally;
  const b = c.scene.getObjectByName('wally.bike');
  return { state: JSON.parse(JSON.stringify(w.bikeState)),
    bikeGroup: b ? { parent: b.parent === c.scene ? 'scene' : 'other', visible: b.visible, pos: [+b.position.x.toFixed(2), +b.position.y.toFixed(2), +b.position.z.toFixed(2)], rotZ: +b.rotation.z.toFixed(3) } : null };
});
if (!OWN_FIRST) { await page.evaluate(() => window.WALLY.ctx.game.actions.grantRide('scooter')); await page.waitForTimeout(1200); }
await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide('scooter'));
await page.waitForTimeout(2600);
const afterMount = await page.evaluate(() => {
  const c = window.WALLY.ctx, w = c.wally;
  const b = c.scene.getObjectByName('wally.bike');
  let eff = b ? b.visible : null, n = b;
  while (n) { if (!n.visible) eff = false; n = n.parent; }
  return { state: JSON.parse(JSON.stringify(w.bikeState)),
    bikeGroup: b ? { parent: b.parent === c.scene ? 'scene' : (b.parent === w.root ? 'wallyRoot' : 'other'), visible: b.visible, effective: eff,
      pos: [+b.position.x.toFixed(2), +b.position.y.toFixed(2), +b.position.z.toFixed(2)], rotZ: +b.rotation.z.toFixed(3) } : null };
});
await page.screenshot({ path: `/tmp/vjJ-p3b-${OWN_FIRST ? 'both' : 'bikefirst'}.png` });
const tr = await page.evaluate(() => window.__T.stop());
console.log(JSON.stringify({ ownedScooterBeforeParking: OWN_FIRST, afterPark, afterMount, trace: tr, errs: errs.slice(0, 5) }, null, 1));
await browser.close(); server.close();
