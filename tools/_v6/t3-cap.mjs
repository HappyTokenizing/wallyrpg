/* 3. THE CAP — cheapest quote on the board, then a long walk. */
import { boot, reporter } from './lib.mjs';
const R = reporter();
const B = await boot(); const { page } = B;
const RATE = await page.evaluate(() => WALLY.ctx.game.data.strideCost('walk', null));
const ROAD = { ax: -273.6, az: -19.8, bx: -225.0, bz: 75.6 };

const out = await page.evaluate(async ([road, RATE]) => {
  const c = WALLY.ctx;
  V.setup({ time: 8 * 60, energy: 100 });
  if (c.game.state.loc !== 'library') c.game.enter('library');
  V.place(road.ax, road.az);
  await new Promise(r => setTimeout(r, 1000));
  /* the nearest place on the board */
  const board = c.game.fares('school');
  const host = document.createElement('div'); host.style.cssText='position:fixed;left:-9999px';
  document.body.appendChild(host);
  c.ui.renderTravelModes(host, 'school', () => {});
  const rows = [...host.querySelectorAll('.w-card')].map(e => ({ t:(e.querySelector('.t')||{}).textContent, d:(e.querySelector('.d')||{}).textContent, m:(e.querySelector('.m')||{}).textContent }));
  [...host.querySelectorAll('.w-card')].find(e => ((e.querySelector('.t')||{}).textContent||'').trim()==='On foot').click();
  await new Promise(r=>setTimeout(r,250)); host.remove();
  const quote = JSON.parse(JSON.stringify(c.game.route));
  const view0 = c.game.routeView ? c.game.routeView() : null;
  const w = await V.walkRoad(road.ax, road.az, road.bx, road.bz, 900, { budget: 420000, legBudget: 45000, stop: 6, run: true });
  return { rows, quote, w, viewAfter: c.game.routeView ? c.game.routeView() : null, routeAfter: c.game.route };
}, [ROAD, RATE]);

console.log('board to the nearest place (school):');
for (const r of out.rows) console.log('   ', String(r.t).padEnd(20), String(r.m).padEnd(10), r.d);
console.log('\nquote taken:', JSON.stringify(out.quote));
console.log(`walked ${out.w.odo} m  ->  ${out.w.energy} energy   e/m ${(out.w.energy/out.w.odo).toFixed(5)}   (table rate ${RATE})`);
console.log('route view after:', JSON.stringify(out.viewAfter));
console.log('detour sidesteps:', JSON.stringify(out.w.stops));
const exp = out.w.odo * RATE;
R.ok(out.w.odo > 850, 'he really covered ~900 m', String(out.w.odo));
R.ok(Math.abs(out.w.energy - exp)/exp < 0.03, `the long walk cost the ROAD, not the quote (${out.w.energy} vs ${exp.toFixed(2)})`);
R.ok(out.w.energy > out.quote.energy * 5, `the discount is gone: ${(out.w.energy/out.quote.energy).toFixed(1)}x the quote paid (was capped at 1.0x = an 11.8x discount)`);
R.ok(out.viewAfter && out.viewAfter.left === 0, '`left` floors at 0 rather than going negative', JSON.stringify(out.viewAfter && out.viewAfter.left));
console.log(`\nCONTRACT: quote ${out.quote.energy} e for ${out.quote.metres} m; walked ${out.w.odo} m and paid ${out.w.energy} e.`);
console.log(`Wandering ratio: paid / quoted = ${(out.w.energy/out.quote.energy).toFixed(2)}x  |  paid / (metres x rate) = ${(out.w.energy/exp).toFixed(3)}x`);
await B.close();
console.log(`\n${R.fails} failure(s). page errors: ${B.errs.length}`, B.errs.slice(0,6).join(' | '));
