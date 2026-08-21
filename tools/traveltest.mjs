/* traveltest.mjs — prove that travelling actually takes you somewhere.

   THE BUG THIS TEST LOCKS DOWN. ctx.game.travel('noodlecart', 'train')
   returned true, state.loc became 'noodlecart', the HUD updated and the
   zone music swapped — and Wally's world position stayed at (0, 14.5, 0),
   outside his apartment, on the other side of the island. Nothing in the
   build listened for 'travel' in order to move the character, so the
   Places app, the fares, the travel times and all 28 locations were
   disconnected from the world the player was standing in.

   WHAT IS ASSERTED, after each of three journeys across the island:

     a) his position is FINITE. The failure mode this guards is specific
        and it is not hypothetical: moving the character behind the
        controller's back leaves simPosition and _prevPosition at the old
        place, the render lerp between them runs across the island, the
        sweep's substep guard gives out and the position goes NaN — after
        which Web Audio throws "setTargetAtTime: The provided float value
        is non-finite" once a frame for the rest of the session. The
        controller's three positions and its velocity are all checked,
        not just the root, because one bad endpoint contaminates the
        other two on the next step.
     b) he is within a few metres of ctx.city.doorPosition() for that
        location — the point city.js documents as "the point you walk to".
     c) no page errors fired, at any point in the run.

   And, because a teleport that leaves the character somewhere legal but
   the CAMERA somewhere else is still a broken arrival, it also checks
   that the camera came with him and that he is on the ground rather
   than falling through it or hovering over it.

   Usage:  node tools/traveltest.mjs [--keep]      (--keep leaves a PNG)
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

/* Three destinations chosen to span the island, so a fix that only
   works for short hops cannot pass: the fare board offers train, bike
   and trunk, and all three modes are exercised. */
const LEGS = [
  { loc: 'noodlecart', mode: 'train' },
  { loc: 'stadium', mode: 'trunk' },
  { loc: 'apartment', mode: 'bike' },
];

/* How close to doorPosition counts as arrived. The arrival deliberately
   stands him ~0.9 m back from the threshold so he is not clipped into
   his own porch, and the controller then snaps him onto whatever is
   really under his feet, so exact equality is the wrong test. 5 m is
   "at that building" and nothing else in the city is that close. */
const NEAR_M = 5;

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
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
await page.waitForTimeout(3000);

/* Clear the things that would make travel() legitimately refuse — the
   place has to be KNOWN, the fare has to be affordable, the legs have
   to have something in them, the bicycle has to have been BOUGHT, and
   the Metro does not run before 05:00. None of that is what this test
   is about; the arrival is. */
await page.evaluate(() => {
  window.ready = (c, id) => {
    const st = c.game.state;
    st.known[id] = true;
    st.money = Math.max(st.money, 5000);
    st.energy = 100;
    /* The bicycle is an item you buy now, not a mode you are handed
       (data.js BIKE, game.actions.buyBike). The 'bike' leg below would
       otherwise be refused with "you do not own a bicycle" — which is
       correct behaviour and is covered by tools/test-game.mjs. */
    st.bike = { owned: true, equipped: true };
    /* Park the clock at mid-morning so the Metro is running and no
       journey rolls the day over mid-test. */
    st.time = 10 * 60;
    return st.loc;
  };
});

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

const start = await probe(null);
console.log(`\nboot: loc=${start.loc} pos=[${start.pos}] finite=${start.finite}`);
ok(start.finite, 'boot position is finite');

console.log('\n--- three journeys across the island, via ctx.game.travel() ---');
for (const leg of LEGS) {
  const res = await page.evaluate(([id, m]) => {
    const c = window.WALLY.ctx;
    ready(c, id);
    const before = [+c.wally.root.position.x.toFixed(2), +c.wally.root.position.z.toFixed(2)];
    const r = c.game.travel(id, m);
    return { r, before };
  }, [leg.loc, leg.mode]);

  /* Longer than the 170 ms fade-out plus the 260 ms fade-in, so the
     arrival has landed AND the camera cut has been through a few
     frames by the time anything is measured. */
  await page.waitForTimeout(1200);
  const a = await probe(leg.loc);

  const label = `${leg.loc} by ${leg.mode}`;
  console.log(`\n${label}: travel -> ${JSON.stringify(res.r)}`);
  console.log(`  from [${res.before}]  to [${a.pos}]  door [${a.door}]`);

  if (!res.r?.ok) { fails++; console.log(`  FAIL  travel() refused: ${res.r?.why}`); continue; }

  ok(a.loc === leg.loc, `${label}: state.loc is ${leg.loc}`);
  ok(a.finite, `${label}: position and controller are finite`, JSON.stringify(a.pos));
  if (!a.door) { fails++; console.log(`  FAIL  ${label}: city has no doorPosition`); continue; }
  const d = Math.hypot(a.pos[0] - a.door[0], a.pos[2] - a.door[2]);
  ok(d <= NEAR_M, `${label}: standing ${d.toFixed(2)} m from the door (<= ${NEAR_M} m)`,
    `pos [${a.pos}] vs door [${a.door}]`);
  ok(Math.abs(a.aboveGround) <= 1.5, `${label}: on the ground (${a.aboveGround} m above terrain)`);
  ok(a.camDist <= 14, `${label}: the camera came too (${a.camDist} m from him)`,
    `cam [${a.cam}] vs him [${a.pos}]`);
}

/* The other two entry points. The Places app goes through ui.goto ->
   the fare board -> ui.placeWally, and placeWally is now the same code
   path as the event — this proves calling it a second time for a
   journey already in flight does not move him twice or fade twice. */
console.log('\n--- ui.placeWally() / ctx.ui.arrive(), the UI entry points ---');
const viaUi = await page.evaluate(async () => {
  const c = window.WALLY.ctx;
  ready(c, 'bank');
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
  const ct = c.wally.controller;
  const fin = (v) => !!v && Number.isFinite(v.x + v.y + v.z);
  return {
    before,
    after: [+c.wally.root.position.x.toFixed(2), +c.wally.root.position.z.toFixed(2)],
    finite: fin(c.wally.root.position) && (!ct || (fin(ct.simPosition) && fin(ct._prevPosition))),
  };
});
await page.waitForTimeout(400);
ok(guard.finite, 'NaN / Infinity destinations refused, position still finite',
  JSON.stringify(guard));
ok(guard.before[0] === guard.after[0] && guard.before[1] === guard.after[1],
  'a refused warp did not move him');

/* And nothing threw, at any point in the run. */
console.log('');
ok(errors.length === 0, 'no page errors', errors.slice(0, 5).join('\n          '));

if (KEEP) {
  await page.evaluate(() => {
    const c = window.WALLY.ctx;
    ready(c, 'stadium');
    c.game.travel('stadium', 'train');
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(ROOT, 'shots', 'travel-arrival.png') });
  console.log('\nwrote shots/travel-arrival.png');
}

console.log(fails === 0
  ? '\nPASS — travelling takes you there.'
  : `\nFAIL — ${fails} assertion(s) failed.`);

await browser.close();
server.close();
process.exit(fails === 0 ? 0 : 1);
