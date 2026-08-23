/* 1. THE ARROW ACROSS A RELOAD, driven through the real fare board. */
import { boot, reporter, installDriver } from './lib.mjs';
const R = reporter();
const B = await boot();
let { page } = B;

const DEST = 'cafe';

const set = await page.evaluate(async (dest) => {
  V.setup({ time: 10 * 60 });
  const apt = V.locPos('apartment');
  V.place(apt[0], apt[1] + 4);
  await new Promise(r => setTimeout(r, 800));
  WALLY.ctx.ui.setDestination(null);          // start with NO arrow of our own
  const pre = { arrow: V.arrow(), snap: V.snap() };
  /* the real board */
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(host);
  WALLY.ctx.ui.renderTravelModes(host, dest, () => {});
  const cards = [...host.querySelectorAll('.w-card')].map(e => ({
    t: (e.querySelector('.t')||{}).textContent, d: (e.querySelector('.d')||{}).textContent,
    m: (e.querySelector('.m')||{}).textContent, dis: !!e.disabled,
  }));
  const foot = [...host.querySelectorAll('.w-card')].find(e => ((e.querySelector('.t')||{}).textContent||'').trim() === 'On foot');
  foot.click();
  await new Promise(r => setTimeout(r, 300));
  host.remove();
  const post = { arrow: V.arrow(), snap: V.snap() };
  WALLY.ctx.game.save(true);
  return { pre, post, cards, name: V.locName(dest) };
}, DEST);

console.log('board:'); for (const c of set.cards) console.log('   ', String(c.t).padEnd(12), String(c.m).padEnd(8), c.d, c.dis ? '[disabled]' : '');
console.log('arrow BEFORE:', JSON.stringify(set.pre.arrow.all));
console.log('arrow AFTER :', JSON.stringify(set.post.arrow.all));
console.log('route AFTER :', JSON.stringify(set.post.snap.route));
R.ok(!!set.post.snap.route && set.post.snap.route.to === DEST, 'route is live after tapping On foot', JSON.stringify(set.post.snap.route));
R.ok(String(set.post.arrow.all).includes(set.name), `arrow NAMES "${set.name}" before the reload`, set.post.arrow.all);

/* ---- RELOAD ---- */
await page.reload({ waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);
await installDriver(page);

const after = await page.evaluate(() => ({ arrow: V.arrow(), snap: V.snap() }));
console.log('\nAFTER RELOAD arrow:', JSON.stringify(after.arrow.all));
console.log('AFTER RELOAD route:', JSON.stringify(after.snap.route), 'routeTo', after.snap.routeTo);
R.ok(!!after.snap.route && after.snap.route.to === DEST, 'route SURVIVED the reload', JSON.stringify(after.snap.route));
R.ok(String(after.arrow.all).includes(set.name), `arrow STILL names "${set.name}" after the reload`, after.arrow.all);

/* ---- walk 200 m and check the charge against what the HUD names ---- */
const walk = await page.evaluate(async () => {
  const apt = V.locPos('apartment'), caf = V.locPos('cafe');
  V.place(apt[0], apt[1]);
  await new Promise(r => setTimeout(r, 900));
  const arrowAt = V.arrow();
  const out = await V.walkRoad(apt[0], apt[1], caf[0], caf[1], 200, { budget: 120000, stop: 6 });
  return { ...out, arrowAt, arrowAfter: V.arrow(), rate: WALLY.ctx.game.data.strideCost('walk', null) };
});
console.log('\n200 m walk with the reloaded route:');
console.log('   odo', walk.odo, 'm   energy', walk.energy, '   e/m', (walk.energy / walk.odo).toFixed(5), '   expected e/m', walk.rate);
console.log('   route ledger after:', JSON.stringify(walk.after.route));
console.log('   arrow during:', JSON.stringify(walk.arrowAt.all));
const exp = walk.odo * walk.rate;
R.ok(Math.abs(walk.energy - exp) / exp < 0.03, `200 m charged at foot rate (${walk.energy} vs ${exp.toFixed(3)} expected)`);
R.ok(String(walk.arrowAt.all).includes('Bent Spoon'), 'the HUD was naming the cafe while it charged him', walk.arrowAt.all);
R.ok(!!walk.after.route && Math.abs(walk.after.route.walked - walk.odo) < 3,
  'the route ledger recorded the same metres the odometer did', `${walk.after.route && walk.after.route.walked} vs ${walk.odo}`);

await B.close();
console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0,6).join(' | '));
