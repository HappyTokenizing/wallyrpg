import { boot, reporter } from './lib.mjs';
const R = reporter();
const B = await boot();
const { page } = B;

const info = await page.evaluate(() => {
  const c = WALLY.ctx, st = c.game.state;
  return { loc: st.loc, pos: [c.wally.position.x, c.wally.position.y, c.wally.position.z],
    apt: V.locPos('apartment'), pawn: V.locPos('pawnshop'),
    locs: c.game.data.locations.map(l => ({ id: l.id, n: l.n, x: l.world.x, z: l.world.z, r: l.radius })) };
});
console.log('boot loc', info.loc, 'pos', info.pos.map(n=>+n.toFixed(1)));
console.log('locations:'); for (const l of info.locs) console.log('  ', l.id.padEnd(16), l.n.padEnd(26), l.x.toFixed(1).padStart(8), l.z.toFixed(1).padStart(8), 'r=' + l.r);

/* stand still for 4 s: does anything drain? */
await page.evaluate(() => V.setup({ time: 10*60 }));
const still = await page.evaluate(async () => {
  const b = V.snap(); await new Promise(r => setTimeout(r, 4000)); const a = V.snap();
  return { de: +(b.energy - a.energy).toFixed(4), dm: +(a.metres - b.metres).toFixed(3), dt: a.time - b.time };
});
console.log('STANDING 4s ->', JSON.stringify(still));
R.ok(still.de === 0, 'standing still costs no energy', JSON.stringify(still));

/* now really walk with NO route */
const w = await page.evaluate(async () => {
  V.setup({ time: 10*60 });
  const apt = V.locPos('apartment');
  V.place(apt[0], apt[1] + 6);
  await new Promise(r => setTimeout(r, 900));
  const t = V.locPos('pawnshop');
  return await V.walk(t[0], t[1], { stop: 40, budget: 25000 });
});
console.log('WALK no route ->', JSON.stringify({ path: w.path, straight: w.straight, odo: w.odo, energy: w.energy, mins: w.mins, stopped: w.stopped }));
R.ok(w.odo > 30, 'the driver really moves him', `odo ${w.odo} m`);
R.ok(w.energy > 0, 'unrouted road is charged', `${w.energy} e`);
console.log('rate e/m =', (w.energy / w.odo).toFixed(5));
await B.close();
console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0,5).join(' | '));
