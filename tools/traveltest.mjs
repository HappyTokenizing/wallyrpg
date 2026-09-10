/* traveltest.mjs — THE TRAVEL RULE, and both halves of it.

   WHAT THIS FILE USED TO PROVE, and still does. ctx.game.travel(
   'noodlecart', 'train') returned true, state.loc became 'noodlecart',
   the HUD updated and the zone music swapped — and Wally's world
   position stayed at (0, 14.5, 0), outside his apartment, on the other
   side of the island. Nothing in the build listened for 'travel' in
   order to move the character. That half is unchanged and asserted
   below for the two modes that are still fast travel.

   WHAT IS NEW, AND WHY THE BICYCLE LEG WAS REWRITTEN. The old third
   leg was { loc: 'apartment', mode: 'bike' } and it asserted that
   riding a bicycle across the island TELEPORTED him to the door. The
   player reported that as a bug and they were right:

     "I was able to fast travel somewhere via bike which should not be
      possible it only updates the arrow and equips the bike. The only
      true fast travel is metro or yoober."

   So the rule this file now locks down is a two-sided one, and the
   side a mode falls on is data.js TRAVEL[mode].fast:

     TRUE FAST TRAVEL — 'train' (Metro) and 'trunk' (Yoober).
       travel() charges the fare, jumps the clock, MOVES him, emits
       'travel', and ui.js lands him at city.doorPosition(). Every
       arrival assertion this file ever made still has to hold.

     SELF-POWERED — 'walk', and 'bike' on each of the three RIDES
       (bicycle, scooter, motorcycle). travel() must NOT move him. It
       must set a route, aim the yellow HUD arrow, put the ride under
       him, charge no money and no minutes, and return moved:false.
       The energy is then taken BY THE METRE as he actually rides, at
       data.js strideCost(mode, ride), and it is charged ROUTE OR NO
       ROUTE. The board's figure is a FORECAST OF THE DIRECT LINE AND
       NOT A CEILING — walk past the door and you keep paying, which
       is asserted in section 4 ("THE QUOTE IS NOT A CAP: the road
       past the door is charged too"). The journey ends at
       game.enter() when he reaches the door.

   The scooter and the motorcycle are in the self-powered list by
   INFERENCE — the player named the metro and the Yoober as the only
   true fast travel, and a scooter is a personal ride exactly as the
   bicycle is. If that is ever overruled, flip `fast` on those rows in
   data.js and this file's SELF/FAST split follows it automatically:
   nothing below hardcodes which mode is which.

   ALSO ASSERTED, on every leg: his position is FINITE (the failure
   mode is specific and not hypothetical — moving the character behind
   the controller's back leaves simPosition and _prevPosition at the
   old place, the render lerp runs across the island, the sweep's
   substep guard gives out, the position goes NaN, and Web Audio then
   throws "setTargetAtTime: The provided float value is non-finite"
   once a frame for the rest of the session); that the camera came
   with him; that he is on the ground; and that no page error fired.

   Usage:  node tools/traveltest.mjs [--keep]      (--keep leaves a PNG)
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

/* THE SIX WAYS OF GETTING ABOUT. `ride` is the RIDES row to put under
   him first; the mode id stays 'bike' for all three because that is
   the fare row they share. Destinations span the island so a fix that
   only works for short hops cannot pass. */
const MODES = [
  { mode: 'walk',  ride: null,         label: 'on foot',       loc: 'noodlecart' },
  { mode: 'bike',  ride: 'bike',       label: 'bicycle',       loc: 'stadium' },
  { mode: 'bike',  ride: 'scooter',    label: 'scooter',       loc: 'bank' },
  { mode: 'bike',  ride: 'motorcycle', label: 'motorcycle',    loc: 'markethall' },
  { mode: 'train', ride: null,         label: 'Metro',         loc: 'noodlecart' },
  { mode: 'trunk', ride: null,         label: 'Yoober',        loc: 'stadium' },
];

/* How close to doorPosition counts as arrived. The arrival deliberately
   stands him ~0.9 m back from the threshold so he is not clipped into
   his own porch, and the controller then snaps him onto whatever is
   really under his feet, so exact equality is the wrong test. 5 m is
   "at that building" and nothing else in the city is that close. */
const NEAR_M = 5;
/* And how still "he did not move" has to be. A routed journey leaves
   him exactly where he stood; the controller's own settle is well
   under a metre. */
const STILL_M = 1.5;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const errors = [];
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.split('\n')[0]));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  /* The exact Web Audio symptom of a non-finite character position. */
  if (/non-finite|NaN|setTargetAtTime/i.test(t)) errors.push('console: ' + t.slice(0, 180));
});

let fails = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log(`  PASS  ${msg}`); return true; }
  fails++;
  console.log(`  FAIL  ${msg}${detail ? '\n          ' + detail : ''}`);
  return false;
};

await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 120000 });
await page.waitForTimeout(3000);

/* Clear the things that would make travel() legitimately refuse — the
   place has to be KNOWN, the fare affordable, the legs full, every
   RIDE owned, and the Metro does not run before 05:00. None of that is
   what this test is about; the rule is.

   IN A FUNCTION BECAUSE SECTION 10 RELOADS THE PAGE. A reload throws
   away every `window.` helper along with the rest of the JS context,
   and the whole point of that section is that the game's own state
   comes back without them. */
const installHelpers = () => page.evaluate(() => {
  /* ready(ctx, destination, ride) — put the world in the one state
     where nothing but the RULE can make travel() refuse.

     `ride` is the vehicle this leg is about, and it goes in the SHED,
     not under him: choosing a ride row is supposed to fetch it, and a
     test that equips it in advance would never see that happen. Only
     that one ride is owned, because game.travel() mounts the BEST
     thing he owns and a shed with a motorcycle in it would answer
     every leg with the motorcycle. */
  window.ready = (c, id, ride, from) => {
    const st = c.game.state;
    st.known[id] = true;
    st.money = Math.max(st.money, 5000);
    st.energy = 100;
    st.hunger = 10;
    st.rides = { owned: { bike: false, scooter: false, motorcycle: false }, equipped: null };
    if (ride) st.rides.owned[ride] = true;
    st.bike = { owned: !!st.rides.owned.bike, equipped: false };
    c.game.clearRoute('test setup');
    /* Park the clock at mid-morning so the Metro is running and no
       journey rolls the day over mid-test. */
    st.time = 10 * 60;
    /* …and start every leg from the same doorstep, so "he did not
       move" is measured against somewhere he definitely was. */
    if (from !== false && st.loc !== 'apartment') c.game.enter('apartment');
    return st.loc;
  };
  /* The one place the yellow pointer's target is legible from outside
     hud.js: the objective strip's headline becomes the PLACE NAME
     whenever the arrow has been aimed by hand. */
  window.arrowText = () => (document.querySelector('.w-obj .t') || {}).textContent || '';
});
await installHelpers();

/* A snapshot of everything an arrival is supposed to have moved. */
const probe = (locId) => page.evaluate((id) => {
  const c = window.WALLY.ctx;
  const w = c.wally, ct = w.controller;
  const f = (v) => (v ? [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)] : null);
  const fin = (v) => !!v && Number.isFinite(v.x + v.y + v.z);
  const d = id ? c.city?.doorPosition?.(id) : null;
  const cam = c.camera.position;
  return {
    loc: c.game?.state?.loc,
    route: c.game?.route || null,
    equipped: c.game?.state?.rides?.equipped || null,
    money: +(c.game?.state?.money ?? 0).toFixed(2),
    energy: +(c.game?.state?.energy ?? 0).toFixed(2),
    minutes: c.game?.state?.time,
    arrow: window.arrowText(),
    pos: f(w.root.position),
    door: f(d),
    cam: f(cam),
    camDist: +Math.hypot(cam.x - w.root.position.x, cam.z - w.root.position.z).toFixed(2),
    /* Every position the controller keeps, plus the velocity — the
       whole set has to be finite, not just the one the renderer uses. */
    finite: fin(w.root.position) && (!ct || (fin(ct.simPosition) && fin(ct.position)
      && fin(ct._prevPosition) && fin(ct.velocity))),
    grounded: ct ? !!ct.grounded : true,
    /* How far his feet are above the terrain under him. */
    aboveGround: c.world?.heightAt
      ? +(w.root.position.y - c.world.heightAt(w.root.position.x, w.root.position.z)).toFixed(2)
      : 0,
  };
}, locId || null);

const moved = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]);

const start = await probe(null);
console.log(`\nboot: loc=${start.loc} pos=[${start.pos}] finite=${start.finite}`);
ok(start.finite, 'boot position is finite');

/* ============================================================
   1. THE SPLIT ITSELF — what does data.js say each mode is?
   ============================================================ */
console.log('\n--- the rule, straight off the table ---');
const table = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const D = c.game.data;
  return {
    fast: D.fastModes, self: D.selfModes, hopMetres: D.hopMetres,
    rows: Object.keys(D.travel).map((m) => ({ m, n: D.travel[m].n, fast: !!D.travel[m].fast })),
    walker: c.game.hasWalker,
  };
});
console.log('  ' + table.rows.map((r) => `${r.m}(${r.n})=${r.fast ? 'FAST' : 'self'}`).join('  '));
ok(table.walker, 'the build has a walker, so a route is a route and not a lump sum');
ok(JSON.stringify(table.fast) === JSON.stringify(['train', 'trunk']),
  'exactly two modes are true fast travel: Metro and Yoober', JSON.stringify(table.fast));
ok(JSON.stringify(table.self) === JSON.stringify(['walk', 'bike']),
  'and the self-powered rows are on foot and whatever is under him', JSON.stringify(table.self));
ok(table.hopMetres > 60 && table.hopMetres < 200,
  `a hop is ${table.hopMetres} m of real island`, String(table.hopMetres));

/* ============================================================
   2. SIX MODES, ONE ASSERTION EACH WAY.
   ============================================================ */
console.log('\n--- all six ways of getting about ---');
for (const leg of MODES) {
  const before = await page.evaluate(([id, ride]) => {
    const c = window.WALLY.ctx;
    ready(c, id, ride);
    return { loc: c.game.state.loc, money: c.game.state.money, time: c.game.state.time };
  }, [leg.loc, leg.ride]);
  const b4 = await probe(leg.loc);

  /* The clock is LIVE — half an in-game minute a second — so the
     minutes are measured either side of the call itself, not either
     side of the settle wait below. Ambient time passing is the
     feature; a lump charged by travel() is the thing under test. */
  const res = await page.evaluate(([id, m]) => {
    const g = window.WALLY.ctx.game;
    const t0 = g.state.time;
    const r = g.travel(id, m);
    return { ...r, t0, t1: g.state.time };
  }, [leg.loc, leg.mode]);
  await page.waitForTimeout(1200);
  const a = await probe(leg.loc);

  const label = `${leg.label} → ${leg.loc}`;
  const isFast = table.fast.includes(leg.mode);
  console.log(`\n${label} (${isFast ? 'FAST' : 'self-powered'}): ${JSON.stringify(res)}`);
  console.log(`  from [${b4.pos}] to [${a.pos}]  loc ${b4.loc} -> ${a.loc}  arrow "${a.arrow}"`);

  if (!res?.ok) { fails++; console.log(`  FAIL  travel() refused: ${res?.why}`); continue; }
  ok(a.finite, `${label}: position and controller are finite`, JSON.stringify(a.pos));

  if (isFast) {
    /* ---- TRUE FAST TRAVEL: everything the old test asserted ---- */
    ok(res.moved === true && res.fast === true, `${label}: reports itself as fast travel`, JSON.stringify(res));
    ok(a.loc === leg.loc, `${label}: state.loc is ${leg.loc}`, a.loc);
    if (!a.door) { fails++; console.log(`  FAIL  ${label}: city has no doorPosition`); continue; }
    const d = Math.hypot(a.pos[0] - a.door[0], a.pos[2] - a.door[2]);
    ok(d <= NEAR_M, `${label}: standing ${d.toFixed(2)} m from the door (<= ${NEAR_M} m)`,
      `pos [${a.pos}] vs door [${a.door}]`);
    ok(Math.abs(a.aboveGround) <= 1.5, `${label}: on the ground (${a.aboveGround} m above terrain)`);
    ok(a.camDist <= 14, `${label}: the camera came too (${a.camDist} m from him)`,
      `cam [${a.cam}] vs him [${a.pos}]`);
    ok(a.route === null, `${label}: leaves no route behind — the journey is over`);
    ok(res.t1 - res.t0 >= res.mins - 0.01,
      `${label}: the clock jumped by the fare (${res.mins} min)`, `${res.t0} -> ${res.t1}`);
    continue;
  }

  /* ---- SELF-POWERED: it points, it does not carry ---- */
  ok(res.moved === false && res.routed === true,
    `${label}: reports moved:false, routed:true`, JSON.stringify(res));
  ok(a.loc === before.loc, `${label}: DID NOT fast travel — state.loc is still ${before.loc}`, a.loc);
  ok(moved(b4, a) <= STILL_M,
    `${label}: DID NOT teleport — he moved ${moved(b4, a).toFixed(2)} m`, `[${b4.pos}] -> [${a.pos}]`);
  ok(a.route && a.route.to === leg.loc, `${label}: a route to ${leg.loc} is live`, JSON.stringify(a.route));
  ok(a.money === before.money, `${label}: cost nothing — $${before.money} still in hand`, String(a.money));
  ok(res.t1 === res.t0,
    `${label}: no lump of minutes charged — the live clock will bill the ride`,
    `${res.t0} -> ${res.t1}`);
  if (leg.ride) {
    ok(a.equipped === leg.ride, `${label}: and it put the ${leg.label} under him`, String(a.equipped));
  } else {
    ok(a.equipped === null, `${label}: nothing mounted — he is walking`, String(a.equipped));
  }
}

/* ============================================================
   3. THE ARROW. Choosing a self-powered mode is choosing a
      DIRECTION, so the yellow pointer has to end up on it.
   ============================================================ */
console.log('\n--- the arrow, through the real fare board ---');
const arrow = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  ready(c, 'stadium', null);          // …and puts him back at the flat
  c.ui.setDestination(null);
  /* Render the board the player actually taps, into a real element,
     and click the "On foot" row. This is the whole UI path: menus.js
     travelModes() -> game.travel() -> ui.setDestination(). */
  const host = document.createElement('div');
  document.body.appendChild(host);
  c.ui.renderTravelModes(host, 'stadium', () => {});
  const labels = [...host.querySelectorAll('.w-label')].map((e) => e.textContent.trim());
  const cards = [...host.querySelectorAll('.w-card')].map((e) => ({
    t: (e.querySelector('.t') || {}).textContent || '',
    d: (e.querySelector('.d') || {}).textContent || '',
    m: (e.querySelector('.m') || {}).textContent || '',
    dis: !!e.disabled,
  }));
  const foot = [...host.querySelectorAll('.w-card')]
    .find((e) => ((e.querySelector('.t') || {}).textContent || '') === 'On foot');
  if (foot) foot.click();
  const out = {
    labels, cards,
    loc: c.game.state.loc,
    route: c.game.route,
    arrow: window.arrowText(),
    want: c.game.data.locationById.stadium.n,
  };
  host.remove();
  return out;
});
console.log('  headings: ' + JSON.stringify(arrow.labels));
for (const c of arrow.cards) console.log(`   [${c.dis ? ' ' : 'x'}] ${c.t.padEnd(12)} ${c.m.padEnd(8)} ${c.d}`);
ok(arrow.labels.some((l) => /point me there/i.test(l)),
  'the board has a "Point me there" heading over the self-powered rows', JSON.stringify(arrow.labels));
ok(arrow.labels.some((l) => /take me there/i.test(l)),
  'and a "Take me there" heading over the Metro and the Yoober', JSON.stringify(arrow.labels));
ok(arrow.cards.some((c) => c.t === 'On foot') && arrow.cards.some((c) => /Metro/.test(c.t)),
  'both halves rendered rows');
ok(arrow.loc !== 'stadium', 'tapping "On foot" did NOT put him in the stadium', arrow.loc);
ok(arrow.route && arrow.route.to === 'stadium', 'it set a route there instead', JSON.stringify(arrow.route));
ok(arrow.arrow === arrow.want, `and aimed the HUD arrow at "${arrow.want}"`, `arrow reads "${arrow.arrow}"`);

/* ============================================================
   4. THE JOURNEY. The minutes come off the live clock and the
      energy comes off BY THE METRE.

      EVERY ASSERTION FROM HERE DOWN IS THE WALKER/ROUTED BRANCH —
      table.walker was asserted at the top of section 1, so a build
      that lost its elephant fails there and not mysteriously here.
      travel()'s other branch (no walker, a self-powered leg resolved
      as a lump) is only reachable with no character in the scene, so
      it lives in tools/test-game.mjs, which now names it.

      THE QUOTE IS NOT A CAP ANY MORE. It was for exactly one round,
      and the promise ("the journey never costs more energy than the
      board said") could not survive a wanderer: it made the cheapest
      row on the board a season ticket, and once the road is charged
      route or no route (section 7) it would make routing CHEAPER than
      not routing. What is asserted instead is the thing that is
      actually true: he pays strideCost per metre, and the board's
      quote is an honest forecast of the direct line.
   ============================================================ */
console.log('\n--- the ride itself: energy by the metre [walker/routed] ---');
const ride = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const g = c.game;
  ready(c, 'stadium', null);
  g.actions.equipRide(null);
  const quoted = g.fares('stadium').find((f) => f.mode === 'walk');
  const rate = g.data.strideCost('walk');
  const r = g.travel('stadium', 'walk');
  const e0 = g.state.energy;
  /* Walk the quoted distance in one-metre steps, straight down +x.
     stride() is the public feed init(ctx) drives at 8 Hz. */
  g.resetStride();
  g.stride(0, 0);
  const half = Math.round(quoted.metres / 2);
  for (let i = 1; i <= half; i++) g.stride(i, 0);
  const mid = { energy: g.state.energy, spent: g.route.spent, walked: g.route.walked };
  for (let i = half + 1; i <= quoted.metres; i++) g.stride(i, 0);
  const end = { energy: g.state.energy, spent: g.route.spent, walked: g.route.walked };
  /* …and then keep going, well past the door, without arriving. */
  g.state.energy = 100;
  const e1 = g.state.energy;
  for (let i = quoted.metres + 1; i <= quoted.metres * 2; i++) g.stride(i, 0);
  const over = { energy: g.state.energy, spent: g.route.spent, walked: g.route.walked };
  return { quoted: { mins: quoted.mins, energy: quoted.energy, metres: quoted.metres },
    rate, r, e0, e1, mid, end, over };
});
console.log(`  quote: ${JSON.stringify(ride.quoted)}  rate ${ride.rate} e/m`);
console.log(`  half way: ${JSON.stringify(ride.mid)}\n  at the door: ${JSON.stringify(ride.end)}\n  past it: ${JSON.stringify(ride.over)}`);
ok(ride.mid.spent > 0, '[walker/routed] energy is spent while he is moving, not on arrival', String(ride.mid.spent));
ok(Math.abs(ride.mid.spent - ride.rate * ride.mid.walked) < 0.02,
  '[walker/routed] half the road is half the energy, at strideCost per metre',
  `${ride.mid.spent} vs ${(ride.rate * ride.mid.walked).toFixed(2)}`);
ok(Math.abs(ride.end.spent - ride.rate * ride.quoted.metres) < 0.05,
  '[walker/routed] the whole road is metres x strideCost',
  `${ride.end.spent} vs ${(ride.rate * ride.quoted.metres).toFixed(2)}`);
/* THE FORECAST IS HONEST, which is what lets the cap go. fare() prices
   in whole HOPS and stride() charges in metres, so the two agree only
   to the hop-to-metre rounding — worst at one hop, where a 76 m leg is
   quoted as a whole 104 m one. 15% is that rounding and nothing else. */
ok(Math.abs(ride.end.spent - ride.quoted.energy) < ride.quoted.energy * 0.15,
  '[walker/routed] and that lands within the rounding of the board\'s quote',
  `walked the quoted ${ride.quoted.metres} m for ${ride.end.spent.toFixed(2)} e, board said ${ride.quoted.energy}`);
ok(Math.abs((ride.e0 - ride.end.energy) - ride.end.spent) < 0.05,
  '[walker/routed] and the state agrees with the route ledger',
  `${(ride.e0 - ride.end.energy).toFixed(2)} spent vs ledger ${ride.end.spent.toFixed(2)}`);
ok(ride.over.spent > ride.end.spent + 0.5 && Math.abs(ride.over.spent - ride.rate * ride.over.walked) < 0.05,
  '[walker/routed] THE QUOTE IS NOT A CAP: the road past the door is charged too',
  `walked ${ride.over.walked} m for ${ride.over.spent.toFixed(2)} e (rate x metres = ${(ride.rate * ride.over.walked).toFixed(2)})`);
ok(Math.abs((ride.e1 - ride.over.energy) - (ride.over.spent - ride.end.spent)) < 0.05,
  '[walker/routed] …and the wallet paid for that overrun too, not just the ledger',
  `${(ride.e1 - ride.over.energy).toFixed(2)} off the bar`);

/* THE FASTER THE RIDE, THE CHEAPER THE ROAD — the whole economy the
   fare table lays out, measured per metre rather than per journey. */
const rates = await page.evaluate(() => {
  const D = window.WALLY.ctx.game.data;
  return { walk: D.strideCost('walk'), bike: D.strideCost('bike', 'bike'),
    scooter: D.strideCost('bike', 'scooter'), moto: D.strideCost('bike', 'motorcycle'),
    train: D.strideCost('train'), trunk: D.strideCost('trunk') };
});
console.log('  energy per metre: ' + JSON.stringify(rates));
ok(rates.walk > rates.bike && rates.bike > rates.scooter && rates.scooter > rates.moto,
  'a metre costs less the better the thing under him', JSON.stringify(rates));
ok(rates.train === 0 && rates.trunk === 0,
  'and nothing at all on the Metro or in a Yoober — they are not measured in metres');

/* ============================================================
   4b. THE TWO HOLES IN THE ROAD TAX, both of them on purpose and
       both of them now written down where the code is.

       THE WARP GUARD is stride()'s `step > warpLimit(dt)` branch. It
       used to be a flat 40 m, which is only impossible if the sample
       was the nominal 125 ms — at the motorcycle's flat-out 26.4 m/s
       a 1.52 s frame stall covers 41 m and rode free. It is a SPEED
       now (WARP_MPS · dt), so the same jump is priced when the clock
       says the sample was long enough for it and refused when it was
       not.

       THE ENERGY FLOOR is state.js addEnergy()'s clamp to [0,100]:
       at 0 the marginal metre is free and walking is never refused,
       so a broke, exhausted player can always get home. That is the
       mercy rule, argued at the clamp, and it is asserted here so
       that "fixing" it into an energy debt breaks a test.
   ============================================================ */
console.log('\n--- the warp guard, and the floor at zero ---');
const holes = await page.evaluate(() => {
  const c = window.WALLY.ctx, g = c.game, st = g.state;
  const feet = () => {
    st.rides = { owned: { bike: false, scooter: false, motorcycle: false }, equipped: null };
    st.bike = { owned: false, equipped: false };
    g.clearRoute('guard test'); g.resetStride();
  };
  /* One sample, one jump, measured off the bar. dt is the sample's
     own timestep, exactly as init(ctx)'s feed passes it. */
  const jump = (m, dt) => {
    feet(); st.energy = 100;
    g.stride(0, 0, dt); g.stride(m, 0, dt);
    return +(100 - st.energy).toFixed(4);
  };
  const NOM = 1 / 8, STALL = 1.6;
  const r = { rate: c.game.data.strideCost('walk') };
  r.nominal39 = jump(39, NOM);     // warpLimit 7.5 m — impossible, refuse
  r.nominal4  = jump(4, NOM);      // 32 m/s: hard, not impossible — charge
  r.stall41   = jump(41, STALL);   // warpLimit 96 m — a stalled frame, charge
  r.stall400  = jump(400, STALL);  // 250 m/s — still a teleport, refuse
  r.noDt39    = jump(39, undefined); // no clock: the flat 40 m fallback
  r.noDt41    = jump(41, undefined);
  /* THE FLOOR. Empty him, then walk him 500 m of island. */
  feet(); st.energy = 0; g.stride(0, 0, NOM);
  for (let i = 1; i <= 500; i++) g.stride(i, 0, NOM);
  r.floorEnergy = +st.energy.toFixed(4);
  /* …and from a bar that cannot cover the road, he still finishes it. */
  feet(); st.energy = 3; g.stride(0, 0, NOM);
  for (let i = 1; i <= 500; i++) g.stride(i, 0, NOM);
  r.overdraft = +st.energy.toFixed(4);
  st.energy = 100;
  return r;
});
console.log('  ' + JSON.stringify(holes));
ok(holes.nominal39 === 0,
  '[stride/warp] 39 m in a 125 ms sample is a teleport and is charged nothing',
  `charged ${holes.nominal39} e (the old flat 40 m guard billed 1.5764)`);
ok(Math.abs(holes.nominal4 - 4 * holes.rate) < 0.01,
  '[stride/warp] …but 4 m in that sample is a fast motorcycle and IS charged',
  `${holes.nominal4} e vs ${(4 * holes.rate).toFixed(4)}`);
ok(Math.abs(holes.stall41 - 41 * holes.rate) < 0.01,
  '[stride/warp] 41 m across a 1.6 s stall is a bad frame, not a warp — charged in full',
  `${holes.stall41} e vs ${(41 * holes.rate).toFixed(4)}`);
ok(holes.stall400 === 0,
  '[stride/warp] and 400 m in that same stall is still a teleport', String(holes.stall400));
ok(holes.noDt39 > 0 && holes.noDt41 === 0,
  '[stride/warp] a caller with no dt gets the old flat 40 m guard, unchanged',
  `39 m -> ${holes.noDt39} e, 41 m -> ${holes.noDt41} e`);
ok(holes.floorEnergy === 0,
  '[state/addEnergy floor] MERCY RULE: at 0 energy he still walks 500 m, for nothing',
  `ended at ${holes.floorEnergy}`);
ok(holes.overdraft === 0,
  '[state/addEnergy floor] …and 3 energy buys the whole 500 m rather than 74 m of it',
  `ended at ${holes.overdraft}, not in debt`);

/* AND THE TELEPORT WE DO KNOW ABOUT DECLARES ITSELF. jump() calls
   resetStride() after it emits 'travel', so the sample that lands him
   at the far door starts a new baseline instead of billing the gap.
   The 5 m step below is the discriminating one: it is INSIDE the warp
   guard, so only the reset can make it free. */
const declared = await page.evaluate(() => {
  const c = window.WALLY.ctx, g = c.game;
  ready(c, 'stadium', null);
  g.resetStride();
  g.stride(0, 0, 1 / 8);                 // baseline: he is standing here
  const before = g.stride(3, 0, 1 / 8);  // 3 m of walking, billed as usual
  const r = g.travel('stadium', 'train');
  const after = g.stride(8, 0, 1 / 8);   // first sample after the jump
  return { fast: !!(r && r.fast), before: +before.toFixed(4), after: +after.toFixed(4) };
});
console.log('  ' + JSON.stringify(declared));
ok(declared.fast && declared.before > 0 && declared.after === 0,
  '[travel/fast jump] a fast-travel jump drops the stride baseline — no metres billed for the teleport',
  `walking charged ${declared.before} e, the sample after the Metro charged ${declared.after} e`);

/* ============================================================
   5. ARRIVAL ON FOOT. enter() is how a routed journey ends: no
      second fare, no clock jump, the route closed, the trip counted.
   ============================================================ */
console.log('\n--- arriving under his own power ---');
const arrive = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const g = c.game;
  ready(c, 'bank', 'bike');
  const before = { money: g.state.money, time: g.state.time, trips: g.state.stats.trips };
  g.travel('bank', 'bike');                       // routed, mounts the bicycle
  const routed = { route: g.route, loc: g.state.loc, equipped: g.state.rides.equipped };
  g.resetStride(); g.stride(0, 0);
  for (let i = 1; i <= 60; i++) g.stride(i, 0);   // 60 m of pedalling
  const r = g.enter('bank');                      // the door
  return {
    before, routed, r,
    after: { loc: g.state.loc, money: g.state.money, time: g.state.time,
      trips: g.state.stats.trips, route: g.route, travel: g.state.travel },
  };
});
await page.waitForTimeout(1200);
const at = await probe('bank');
console.log(`  ${JSON.stringify(arrive.routed)}\n  enter -> ${JSON.stringify(arrive.r)}\n  ${JSON.stringify(arrive.after)}`);
ok(arrive.routed.loc !== 'bank', 'the bicycle did not take him to the bank');
ok(arrive.routed.equipped === 'bike', 'but it did put the bicycle under him');
ok(arrive.r && arrive.r.ok && arrive.r.routed, 'enter() at the door closes the routed journey', JSON.stringify(arrive.r));
ok(arrive.after.loc === 'bank', 'and NOW he is at the bank');
ok(arrive.after.money === arrive.before.money, 'the whole journey cost no money', String(arrive.after.money));
ok(arrive.after.time === arrive.before.time,
  'and no lump of minutes — the live clock charges those', `${arrive.before.time} -> ${arrive.after.time}`);
ok(arrive.after.trips === arrive.before.trips + 1, 'the trip is counted once, on arrival', String(arrive.after.trips));
ok(arrive.after.route === null, 'and the route is closed');
ok(arrive.after.travel === 'bike', 'state.travel remembers what he came on', arrive.after.travel);
ok(at.finite, 'position and controller are finite after an on-foot arrival', JSON.stringify(at.pos));

/* ============================================================
   6. THE UI ENTRY POINTS, for the two modes that still teleport.
      ui.placeWally() is the same code path as the 'travel' event, so
      calling it a second time for a journey already in flight must
      not move him twice or fade twice.
   ============================================================ */
console.log('\n--- ui.placeWally() / ctx.ui.arrive() ---');
/* Put him home and LET THAT ARRIVAL LAND before starting the one under
   test. ui.arrive() short-circuits when he is already standing where
   it was asked to put him ("he walked here"), so a second arrival
   fired on top of an unresolved first one is a test artefact, not a
   bug in the thing being tested. */
await page.evaluate(() => ready(window.WALLY.ctx, 'bank', null));
await page.waitForTimeout(900);
const viaUi = await page.evaluate(async () => {
  const c = window.WALLY.ctx;
  const r = c.game.travel('bank', 'train');       // emits 'travel' -> arms the arrival
  c.ui.placeWally('bank');                        // what menus.js does immediately after
  c.ui.placeWally('bank');                        // and again, for good measure
  return { r, loc: c.game.state.loc };
});
await page.waitForTimeout(1200);
const b = await probe('bank');
console.log(`  travel+placeWally -> ${JSON.stringify(viaUi.r)}  pos [${b.pos}]  door [${b.door}]`);
if (viaUi.r?.ok && b.door) {
  ok(b.finite, 'placeWally: position and controller are finite');
  const d = Math.hypot(b.pos[0] - b.door[0], b.pos[2] - b.door[2]);
  ok(d <= NEAR_M, `placeWally: standing ${d.toFixed(2)} m from the door`);
}

/* A destination that cannot be resolved must be refused, not turned
   into a NaN. This is the guard, tested directly. */
console.log('\n--- the non-finite guard ---');
const guard = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const before = [+c.wally.root.position.x.toFixed(2), +c.wally.root.position.z.toFixed(2)];
  c.wally.warpTo(NaN, 0, NaN);
  c.wally.warpTo(0, Infinity, 0);
  c.wally.setPosition(NaN, NaN, NaN);
  c.game.stride(NaN, NaN);
  c.game.stride(Infinity, 0);
  const ct = c.wally.controller;
  const fin = (v) => !!v && Number.isFinite(v.x + v.y + v.z);
  return {
    before,
    after: [+c.wally.root.position.x.toFixed(2), +c.wally.root.position.z.toFixed(2)],
    energy: c.game.state.energy,
    finite: fin(c.wally.root.position) && (!ct || (fin(ct.simPosition) && fin(ct._prevPosition))),
  };
});
await page.waitForTimeout(400);
ok(guard.finite, 'NaN / Infinity destinations refused, position still finite', JSON.stringify(guard));
ok(guard.before[0] === guard.after[0] && guard.before[1] === guard.after[1],
  'a refused warp did not move him');

/* ============================================================
   7. THE ROAD IS CHARGED WITH NO ROUTE AT ALL.

      Until this round stride() returned 0 the moment there was no
      live route, so the entire cost of moving was OPT-IN. Measured:
      the identical 535 m apartment-to-mine road charged 0.00 energy
      with no route and enter() still arrived. The fare board's rows
      billed him and the phone's free "Point me" button produced the
      same yellow arrow for nothing — two controls, one outcome, one
      of them taxed. And the cap being per-journey meant the cheapest
      quote on the board bought unlimited road.

      Every assertion here is [walker/no-route] except where marked.
   ============================================================ */
console.log('\n--- the road, with nobody having asked for directions ---');
const loose = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const g = c.game;
  const walk = (n) => { g.resetStride(); g.stride(0, 0); for (let i = 1; i <= n; i++) g.stride(i, 0); };

  /* (a) 535 m on foot with NO route — the control measurement. */
  ready(c, 'mine', null);
  g.actions.equipRide(null);
  g.clearRoute('test');
  const e0 = g.state.energy;
  walk(535);
  const free = { spent: +(e0 - g.state.energy).toFixed(2), route: g.route };

  /* (b) the SAME 535 m with a route live, for the price comparison. */
  ready(c, 'mine', null);
  g.actions.equipRide(null);
  g.travel('mine', 'walk');
  const e1 = g.state.energy;
  walk(535);
  const routed = { spent: +(e1 - g.state.energy).toFixed(2), ledger: +g.route.spent.toFixed(2) };

  /* (c) the season ticket: quote the cheapest hop on the board, then
     walk somewhere else entirely. 76 m to the pawnshop for 4.2 e used
     to buy 900 m of road. */
  ready(c, 'pawnshop', null);
  g.actions.equipRide(null);
  const cheap = g.fares('pawnshop').find((f) => f.mode === 'walk');
  g.travel('pawnshop', 'walk');
  const e2 = g.state.energy = 100;
  walk(900);
  const wander = { quote: cheap.energy, metres: cheap.metres, spent: +(e2 - g.state.energy).toFixed(2) };

  /* (d) what is under him sets the rate, with no route to name it. */
  ready(c, 'mine', 'motorcycle');
  g.actions.equipRide('motorcycle');
  g.clearRoute('test');
  const e3 = g.state.energy = 100;
  walk(300);
  const moto = { spent: +(e3 - g.state.energy).toFixed(2), equipped: g.state.rides.equipped };

  return { free, routed, wander, moto,
    rate: g.data.strideCost('walk'), motoRate: g.data.strideCost('bike', 'motorcycle') };
});
console.log(`  no route: ${JSON.stringify(loose.free)}\n  routed:   ${JSON.stringify(loose.routed)}`);
console.log(`  cheap quote then a long walk: ${JSON.stringify(loose.wander)}`);
console.log(`  motorcycle, no route: ${JSON.stringify(loose.moto)}`);
ok(loose.free.route === null, '[walker/no-route] there really was no route live', JSON.stringify(loose.free.route));
ok(Math.abs(loose.free.spent - loose.rate * 535) < 0.05,
  '[walker/no-route] 535 m of walking costs 535 x strideCost, with nothing routed',
  `${loose.free.spent} vs ${(loose.rate * 535).toFixed(2)}`);
ok(Math.abs(loose.free.spent - loose.routed.spent) < 0.05,
  '[walker/no-route vs walker/routed] THE SAME ROAD COSTS THE SAME EITHER WAY — the fare board is a quote, not a toll gate',
  `${loose.free.spent} loose vs ${loose.routed.spent} routed`);
ok(Math.abs(loose.routed.ledger - loose.routed.spent) < 0.05,
  '[walker/routed] and the route ledger recorded what the bar paid',
  `${loose.routed.ledger} vs ${loose.routed.spent}`);
ok(loose.wander.spent > loose.wander.quote * 3,
  '[walker/routed] a cheap quote is NOT a season ticket: 900 m costs 900 m',
  `${loose.wander.metres} m quoted at ${loose.wander.quote} e, then ${loose.wander.spent} e for 900 m`);
ok(Math.abs(loose.wander.spent - loose.rate * 900) < 0.05,
  '[walker/routed] …and it costs exactly 900 x strideCost',
  `${loose.wander.spent} vs ${(loose.rate * 900).toFixed(2)}`);
ok(loose.moto.equipped === 'motorcycle' && Math.abs(loose.moto.spent - loose.motoRate * 300) < 0.05,
  '[walker/no-route] the ride under him sets the rate even with nothing routed',
  `${loose.moto.spent} vs ${(loose.motoRate * 300).toFixed(2)}`);
ok(loose.moto.spent < loose.rate * 300,
  '[walker/no-route] …so the motorcycle is still cheaper per metre than his feet',
  `${loose.moto.spent} vs ${(loose.rate * 300).toFixed(2)} on foot`);

/* ============================================================
   8. RE-TAPPING THE SAME ROW IS NOT A SECOND JOURNEY.

      setRoute() used to overwrite st.route wholesale, so `spent` went
      back to 0 with no refund and no clear event. Measured:
      apartment-to-treasury on foot, quoted 33.6 e, walked for 31.53;
      the SAME row again, another 31.53; a third time, another. 94.58
      energy for one journey quoted at 33.6, and he never arrived.
   ============================================================ */
console.log('\n--- the fare board, tapped twice ---');
const retap = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const g = c.game;
  const walk = (n) => { g.resetStride(); g.stride(0, 0); for (let i = 1; i <= n; i++) g.stride(i, 0); };
  ready(c, 'treasury', null);
  ready(c, 'bank', null);
  g.actions.equipRide(null);
  const events = [];
  const off = c.bus.on('route', (r) => events.push({ kind: r.kind, to: r.to, why: r.why || null, spent: r.spent }));

  g.travel('treasury', 'walk');
  walk(200);
  const first = { spent: +g.route.spent.toFixed(2), walked: g.route.walked };
  const again = g.travel('treasury', 'walk');          // the same row, again
  const kept = { spent: +g.route.spent.toFixed(2), walked: g.route.walked, resumed: !!again.resumed };
  walk(200);
  const total = { spent: +g.route.spent.toFixed(2), walked: g.route.walked };

  /* A DIFFERENT row is a change of mind, and that has to clear the old
     route properly rather than dropping it on the floor. */
  const changed = g.travel('bank', 'walk');
  const after = { to: g.route.to, spent: +g.route.spent.toFixed(2), walked: g.route.walked,
    resumed: !!changed.resumed };
  off?.();
  return { first, kept, total, after, events };
});
console.log(`  first 200 m: ${JSON.stringify(retap.first)}\n  re-tapped:   ${JSON.stringify(retap.kept)}`);
console.log(`  another 200 m: ${JSON.stringify(retap.total)}\n  changed his mind: ${JSON.stringify(retap.after)}`);
console.log('  route events: ' + JSON.stringify(retap.events));
ok(retap.kept.resumed === true && Math.abs(retap.kept.spent - retap.first.spent) < 0.01,
  '[walker/routed] re-tapping the same row KEEPS the ledger — no reset, no second charge',
  `${retap.first.spent} -> ${retap.kept.spent}`);
ok(retap.kept.walked === retap.first.walked,
  '[walker/routed] …and the road already covered stays covered', `${retap.first.walked} m`);
ok(Math.abs(retap.total.spent - retap.first.spent * 2) < 0.02,
  '[walker/routed] 400 m of walking costs 400 m, not two full quotes',
  `${retap.total.spent} for ${retap.total.walked} m`);
ok(retap.after.to === 'bank' && retap.after.spent === 0 && retap.after.walked === 0,
  '[walker/routed] a DIFFERENT row starts a fresh ledger', JSON.stringify(retap.after));
ok(retap.events.some((e) => e.kind === 'clear' && e.to === 'treasury' && e.spent > 0),
  '[walker/routed] …and the abandoned route fired its clear event with what it had spent',
  JSON.stringify(retap.events.filter((e) => e.kind === 'clear')));
ok(retap.events.filter((e) => e.kind === 'set' && e.to === 'treasury').length === 2,
  '[walker/routed] the re-tap still emits a set, so the UI can re-aim the arrow it dropped',
  JSON.stringify(retap.events.map((e) => e.kind + ':' + e.to)));

/* ============================================================
   9. A ROUTE DOES NOT SURVIVE THE NIGHT.

      Sleeping rolled the day forward and left st.route holding
      yesterday's quote and its unspent cap. Combined with an arrow
      that did not survive a reload, a player could wake on day 2
      pointed at nothing and still be metered against a fare board he
      read yesterday.
   ============================================================ */
console.log('\n--- sleeping on a live route ---');
const night = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const g = c.game;
  ready(c, 'stadium', null);            // …which leaves him at the flat
  g.actions.equipRide(null);
  const events = [];
  const off = c.bus.on('route', (r) => events.push({ kind: r.kind, to: r.to, why: r.why || null }));
  g.travel('stadium', 'walk');
  const before = { day: g.state.day, route: g.route ? g.route.to : null, loc: g.state.loc };
  const slept = g.actions.sleep();
  const after = { day: g.state.day, route: g.route, arrow: window.arrowText() };
  off?.();
  return { before, slept, after, events, want: g.data.locationById.stadium.n };
});
await page.waitForTimeout(600);
const arrowAfterNight = await page.evaluate(() => window.arrowText());
console.log(`  ${JSON.stringify(night.before)} -> ${JSON.stringify(night.after)}  events ${JSON.stringify(night.events)}`);
ok(night.slept && night.slept.ok, '[walker/routed] he went to bed', JSON.stringify(night.slept));
ok(night.before.route === 'stadium', '[walker/routed] there was a live route when he did');
ok(night.after.day === night.before.day + 1, '[walker/routed] the day rolled', String(night.after.day));
ok(night.after.route === null, '[walker/routed] and the route did NOT survive the night', JSON.stringify(night.after.route));
ok(night.events.some((e) => e.kind === 'clear' && e.to === 'stadium'),
  '[walker/routed] it was dropped with a proper clear event, not silently',
  JSON.stringify(night.events));
ok(arrowAfterNight !== night.want,
  '[walker/routed] and the yellow arrow went down with it', `arrow reads "${arrowAfterNight}", was "${night.want}"`);

/* ============================================================
   10. THE ROUTE AND THE ARROW SURVIVE A RELOAD TOGETHER.

       Measured before this round: route on foot to the cafe (41 min,
       12.6 e, 302 m), the arrow reads "The Bent Spoon", save, reload —
       game.route comes back intact and the arrow has reverted to the
       quest. 200 m of walking then charged 8.08 energy toward a
       destination the HUD no longer named. hud.js's destOverride was a
       module-local `let` that nothing ever seeded from game.route.

       THE PAGE IS RELOADED FOR REAL. Nothing below may lean on a
       window.* helper installed before it; that is the whole point.
   ============================================================ */
console.log('\n--- save, reload, and see whether the arrow came back ---');
const saved = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const g = c.game;
  ready(c, 'cafe', null);
  g.actions.equipRide(null);
  const q = g.fares('cafe').find((f) => f.mode === 'walk');
  g.travel('cafe', 'walk');
  g.save(true);
  return { quote: { mins: q.mins, energy: q.energy, metres: q.metres },
    route: g.route.to, arrow: window.arrowText(), want: g.data.locationById.cafe.n };
});
console.log(`  before: route=${saved.route} arrow="${saved.arrow}" quote=${JSON.stringify(saved.quote)}`);
ok(saved.arrow === saved.want, `[walker/routed] the arrow named "${saved.want}" before the reload`, saved.arrow);

await page.reload({ waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 120000 });
await page.waitForTimeout(2500);
await installHelpers();
const reloaded = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const g = c.game;
  return { route: g.route ? g.route.to : null, routeTo: g.routeTo ?? null,
    arrow: window.arrowText(), want: g.data.locationById.cafe.n, loc: g.state.loc };
});
console.log(`  after:  route=${reloaded.route} routeTo=${reloaded.routeTo} arrow="${reloaded.arrow}"`);
ok(reloaded.route === 'cafe', '[walker/routed] the route survived the reload, as it always did', String(reloaded.route));
ok(reloaded.arrow === reloaded.want,
  `[walker/routed] AND SO DID THE ARROW — it still names "${reloaded.want}"`, `arrow reads "${reloaded.arrow}"`);
ok(reloaded.routeTo === 'cafe', '[walker/routed] game.routeTo is the cheap per-frame read hud.js uses', String(reloaded.routeTo));

/* The other half of one decision: dropping the arrow drops the route. */
const dropped = await page.evaluate(() => {
  const c = window.WALLY.ctx;
  const g = c.game;
  const events = [];
  const off = c.bus.on('route', (r) => events.push(r.kind + ':' + (r.why || '')));
  c.ui.setDestination(null);                     // exactly what the ✕ does
  const after = { route: g.route, arrow: window.arrowText() };
  off?.();
  return { after, events };
});
console.log(`  after the ✕: ${JSON.stringify(dropped.after)}  events ${JSON.stringify(dropped.events)}`);
ok(dropped.after.route === null,
  '[walker/routed] clearing the arrow with the ✕ clears the ROUTE too — one decision, both halves',
  JSON.stringify(dropped.after.route));
ok(dropped.after.arrow !== reloaded.want,
  '[walker/routed] …and the strip stopped naming the place', `arrow reads "${dropped.after.arrow}"`);
ok(Number.isFinite(guard.energy), 'and a non-finite stride() charged no energy', String(guard.energy));

/* And nothing threw, at any point in the run. */
console.log('');
ok(errors.length === 0, 'no page errors', errors.slice(0, 5).join('\n          '));

if (KEEP) {
  await page.evaluate(() => {
    const c = window.WALLY.ctx;
    ready(c, 'stadium', null);
    c.game.travel('stadium', 'train');
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(ROOT, 'shots', 'travel-arrival.png') });
  console.log('\nwrote shots/travel-arrival.png');
}

console.log(fails === 0
  ? '\nPASS — the Metro and the Yoober carry you; on foot and on wheels you go yourself.'
  : `\nFAIL — ${fails} assertion(s) failed.`);

await browser.close();
server.close();
process.exit(fails === 0 ? 0 : 1);
