#!/usr/bin/env node
/* ============================================================
   tools/test-balloon.mjs — THE ASSESSOR, asserted.

       node tools/test-balloon.mjs            everything
       node tools/test-balloon.mjs --data     the node half only (fast)
       node tools/test-balloon.mjs --verbose  print every green line

   TWO HALVES, AND THEY TEST DIFFERENT KINDS OF THING.

   PART A is plain node. It imports src/game/data.js, src/game/game.js
   and src/character/balloon.js directly — balloon.js is importable
   outside a browser because vendor/three.module.js touches no DOM at
   module scope, and because the flight integrator was deliberately
   written as a pure function of numbers. So the flight model, the
   price, the unlock gates, the parked-spot record and the save round
   trip are all asserted with no renderer at all, in under a second.

   PART B boots the real game in headless Chrome, exactly the way
   tools/shot.mjs does, and drives WALLY.debug. It is the only half
   that can answer the questions that matter most — does it leave the
   ground, does the haze open at altitude, does it go through a wall,
   does the machine end up standing where he left it — because every
   one of those is a fact about geometry that does not exist in node.

   WHAT EACH ASSERTION EXERCISES IS NAMED IN ITS MESSAGE, because a
   green assertion that could not have failed is worse than no
   assertion: this project has shipped nine of those. Where a test
   could pass for the wrong reason the counter-case is asserted beside
   it — every gate is checked BOTH ways, the flight model is checked
   against a stationary control, and the collision test is checked
   against the same run with the wall taken away.

   AND IT HAS TO BE A GATE, WHICH MEANS IT HAS TO BE DETERMINISTIC.
   This suite once shipped red on eight runs in thirteen of an
   unmodified tree, and not one of those reds was a defect. Three
   assertions had been FITTED TO A NUMBER SOMEBODY SAW rather than to a
   property the machine has, and the quantity they were fitted to is
   bimodal: a hands-off descent from 6 m over the tallest building in
   the city either settles on the roof after about eight metres of
   drift — which the flight model's own constants predict, terminal
   drift 3.10 m/s and tau 4.5 s over about five seconds of fall — or
   clears the parapet and falls sixty-odd metres to the street. The
   thresholds ("> 18 m off the target", "> 14.25 m of terrain under
   his feet") only described the second outcome, so the suite passed
   when the coin landed the way its author happened to watch it land.
   The wind-vs-stick rebalance then moved the very quantity two of
   them were fitted to and they came apart at once.

   SO EVERY ASSERTION IN HERE IS ONE OF TWO THINGS, and neither is a
   remembered number:
     · PINNED. The initial condition is chosen by the test, from the
       world's own seeded geometry, so the outcome cannot vary: B6
       lands on a site it picks by search — inland, unbuilt over the
       whole neighbourhood she can drift across, gentle — and holds
       the base wind at zero while she comes down, so the mooring
       assertions are about the park solve and nothing else.
     · AN INVARIANT. Where the outcome is legitimately free, the claim
       is a property that holds however it lands: "she comes to rest on
       the highest supported surface under her footprint" is true on a
       roof AND on the street, and `phys.groundAt` is the thing that
       knows which — `world.heightAt` is the terrain and answers the
       wrong question over a building. The air's effect is asserted by
       REPLAYING the pure integrator over the wind the live machine was
       actually flying in, frame by frame, and comparing displacements;
       that is a law, and it holds whatever the air did that run.

   THE REVERT CHECK. Back a change out and these must go red:
     · flip the envelope's index winding back to (a,d,b) in
       balloon.js and B's "the envelope's triangles face outward"
       fails on the measured face-normal dot product.
     · move flyHaze's call from wally.js lateUpdate() into
       flyUpdate() and B's "the haze opens at altitude" fails: it
       reads the ground value at 200 m (measured: 100/520).
     · drop `assets` from RIDES.balloon.unlock and A's "a rich
       reputable player who has tokenized nothing is refused" fails.
     · delete syncParked() from game.js and A's save round trip
       fails on the missing spot.
     · remove the collapse() call from balloon.js finishBalloon() and
       B's mesh-budget and draw-call assertions both fail (48 meshes,
       177 calls, measured).
     · delete restoreParked() from wally.js and B's "stood back up as
       a parked machine" fails after the reload.

   AND THE SIX FROM THE FRAME PASS, EVERY ONE OF THEM RUN:
     · put the negations back on wally.js's fly-camera seed —
       `flyCam.yaw = Math.atan2( -_fv2.x, -_fv2.z )` — and all eight
       of B9's seam assertions go red on both branches: 4071 deg/s on
       the worst becalmed frame, the aim passing 0.19 m from the lens,
       the lens 3.10 m in FRONT of the subject.
     · drop the `* hazeK` from toon.js's cullHulls and B11's "most of
       the island is inked from the air" fails at 67 of 517 hulls.
     · comment out flySea() in wally.js's lateUpdate and B11's wave
       fade at 200 m comes back as the authored 520/1400.
     · put balloon.js's envelope constant back to `glow * 0.085` and
       B10's night glow fails at 0.082, and so does the day/night
       comparison beside it (0.082 both ways).
     · take `g = foot` out of flyUpdate and B12 finds the roof over
       the parapet at 0 offsets instead of 4.
     · put FLIGHT.windGain back to 3.60 and SIX of A2's assertions go
       red, including the 2:1 ratio (1.45) and the upwind cruise.

   AND THE FOUR THE DETERMINISM PASS ADDED, which are the ones that
   prove the new assertions are assertions and not decoration:
     · take the burner out of B5's escape window — flip its
       `balloonBurn(true)` to false — and BOTH escape assertions go
       red: the lit window stops out-climbing the cold control, which
       is the control doing its job.
     · read that same climb back as `flightState.alt` at both ends and
       it stops being an assertion and goes back to being the last
       flake in this suite: green while she stays below the Market
       Hall's parapet, red the moment the burner carries her over it
       and the roof slides under the basket, because `alt` is a height
       over the highest solid beneath her and is clamped at zero. That
       is a bimodal revert rather than a deterministic one, and saying
       so is the point — it is why the measurement moved to absolute
       world height and the position stayed free.
     · edit anything under src/ and do not rebuild, and A7 goes red
       naming the size delta and the first byte that differs —
       WALLY-RPG.html is in the gate now.
     · scale wally.js's `_fenv.windX/.windZ` by anything but 1, or
       stop feeding them, and B6a's replay goes red: the live
       displacement no longer matches what stepFlight makes of the
       wind that was recorded beside it, in magnitude or in bearing.
     · point B6's landing surface back at `world.heightAt` and it goes
       red the moment the wind puts her on a roof — which was the
       original defect, and is why the site is pinned as well.
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RIDES, RIDE_LIST, RIDE_ORDER, CONFIG, ASSETS, LOC_BY_ID, RACE, OFFICE_STAGES,
  HOMES, CLIENTS, FIRST_ORDER, rideFare, LOCATIONS,
} from '../src/game/data.js';
import { createGame } from '../src/game/game.js';
import { createSave } from '../src/game/save.js';
import { newState, mulberry32 } from '../src/game/state.js';
import { FIT, FLIGHT, stepFlight, newFlight } from '../src/character/balloon.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
const DATA_ONLY = process.argv.includes('--data');

let pass = 0;
const fails = [];
let group = '';
const T = (n) => { group = n; if (VERBOSE) console.log('\n— ' + n); };
function ok(cond, msg, detail) {
  if (cond) { pass++; if (VERBOSE) console.log('  ok  ' + msg + (detail != null ? `  (${detail})` : '')); return true; }
  fails.push(`[${group}] ${msg}` + (detail != null ? `  (${detail})` : ''));
  return false;
}
const eq = (a, b, msg) => ok(a === b, msg, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
/* `detail` is optional on near(), and it is worth passing. "got 21.21,
   want 14.25" says an assertion failed; "after 34 m of drift she is on
   a ROOF" says why, and the difference between those two sentences is
   the whole of what went wrong with this suite last round. */
const near = (a, b, tol, msg, detail) => ok(Math.abs(a - b) <= tol, msg,
  (detail != null ? detail + ' · ' : '') + `got ${a}, want ${b} +/- ${tol}`);

/* ============================================================
   A CLEAR SITE, CHOSEN BY THE TEST RATHER THAN BY THE WIND.

   Three assertions in Part B used to be about where she happened to
   end up, and "happened to" is the whole problem: a landing that
   drifts over a roof, a shoreline or a hillside is a perfectly correct
   landing and a completely different measurement. So the tests that
   are about the LANDING (rather than about where you may land, which
   is B6a's subject) pin the site first.

   IT IS A NEIGHBOURHOOD, NOT A POINT, and that is deliberate. Holding
   the base wind at zero does not becalm the air — wind.js's gust
   machine runs on its own and adds up to 0.6 on top of whatever the
   base is — so she will still move some metres on the way down. A site
   that is clear only at its centre would hand back exactly the coin
   flip this is here to remove. R metres of unbuilt, unshored, gentle
   ground means every outcome inside the drift she can manage is the
   same outcome — and the tests below assert that the drift stayed
   inside R, so the pin is checked rather than assumed.

   THE RADIUS IS A LADDER AND NOT A WISH. Asking this island for a
   45 m disc with nothing collidable in it finds nothing at all — it
   is a small island with a city and a lot of trees on it — and a
   `throw` is a worse answer than a smaller clearing. So the widest
   achievable radius is taken from a ladder and reported, and the
   assertions are against the radius that was actually found.

   The scan is the world's own seeded geometry through a fixed
   Vogel spiral, so it answers with the same site on every run.
   ============================================================ */
const CLEAR_SITE = `((RADII) => {
  const world = WALLY.ctx.world, phys = WALLY.ctx.phys;
  const built = (x, z) => Math.abs(phys.groundAt(x, z).y - world.heightAt(x, z)) > 0.05;
  const deg = (x, z) => Math.acos(Math.max(-1, Math.min(1, 1 - world.slopeAt(x, z)))) * 180 / Math.PI;
  for (const RADIUS of RADII) {
  for (let i = 0; i < 9000; i++) {
    const a = i * 2.399963, r = 40 + (i % 340);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (world.isWater(x, z) || world.shoreDistAt(x, z) < RADIUS + 160) continue;
    if (built(x, z) || deg(x, z) > 6) continue;
    /* SIX RINGS OF TWELVE, not three of eight. The rings exist to
       catch things she could come down ON — a wall, a rock, a tree —
       anywhere inside the drift, and a sparse ring can miss a tree
       between its spokes as easily as a single centre ray can miss a
       roof. Seventy-two probes per surviving candidate, and only a
       candidate that already passed the centre test pays for them. */
    let clear = true;
    const STEP = RADIUS / 6;
    for (let ring = STEP; ring <= RADIUS + 0.01 && clear; ring += STEP) {
      for (let k = 0; k < 12; k++) {
        const b = (k / 12) * Math.PI * 2;
        const px = x + Math.cos(b) * ring, pz = z + Math.sin(b) * ring;
        if (world.isWater(px, pz) || built(px, pz)) { clear = false; break; }
      }
    }
    if (!clear) continue;
    return { x: +x.toFixed(2), z: +z.toFixed(2), y: +world.heightAt(x, z).toFixed(2),
      deg: +deg(x, z).toFixed(1), shore: Math.round(world.shoreDistAt(x, z)), tries: i, radius: RADIUS };
  }
  }
  return null;
})`;


/* ============================================================
   A1. THE ROW
   ============================================================ */
T('the ride table');
ok(!!RIDES.balloon, 'RIDES.balloon exists');
eq(RIDE_LIST.length, 4, 'four rides now');
eq(RIDES.balloon.unlock.kind, 'buy', 'it is bought, not granted');
eq(RIDES.balloon.price, RIDES.balloon.unlock.price, 'price mirrors unlock.price');

/* THE LADDER. The balloon must NOT be the fastest, and that is a
   mechanical requirement rather than taste: takeRide() auto-equips
   anything faster than what you own and bestRide() reads the head of
   RIDE_ORDER, so a balloon at speed > 3 would silently take the
   motorcycle out from under a player who just bought a luxury. */
eq(RIDE_ORDER[0], 'motorcycle', 'the motorcycle is still the fastest thing owned');
ok(RIDES.balloon.speed < RIDES.motorcycle.speed,
  'the balloon is SLOWER than the motorcycle, so buying it cannot auto-equip over one',
  `${RIDES.balloon.speed} < ${RIDES.motorcycle.speed}`);
ok(RIDES.balloon.speed > RIDES.bike.speed, 'and faster than the bicycle');
ok(RIDES.balloon.effort < RIDES.motorcycle.effort,
  'and cheaper in energy than anything else — you do none of the work',
  `${RIDES.balloon.effort} vs ${RIDES.motorcycle.effort}`);

/* THE PRICE, against the ladder it has to sit in. */
ok(RIDES.balloon.price > RIDES.motorcycle.price * 5,
  'it costs more than five motorcycles', `$${RIDES.balloon.price} vs $${RIDES.motorcycle.price}`);
ok(RIDES.balloon.price > OFFICE_STAGES[3].cost,
  'more than the Professional Office', `$${RIDES.balloon.price} vs $${OFFICE_STAGES[3].cost}`);
ok(RIDES.balloon.price < OFFICE_STAGES[4].cost,
  'and less than City Headquarters — it is a luxury, not the endgame',
  `$${RIDES.balloon.price} vs $${OFFICE_STAGES[4].cost}`);
ok(RIDES.balloon.price < HOMES.find((h) => h.id === 'water').cost,
  'and less than the Waterfront Apartment');

/* THE GATES. Both of them, and both are real. */
ok(RIDES.balloon.unlock.rep >= 70, 'gated on late reputation', RIDES.balloon.unlock.rep);
ok(RIDES.balloon.unlock.assets >= 35,
  'and on having actually tokenized a good half of the city', RIDES.balloon.unlock.assets);
ok(RIDES.balloon.unlock.assets < CONFIG.totalAssets,
  'but not on finishing it — the balloon is a reward, not a trophy');
eq(RIDES.balloon.unlock.locs.length, 1, 'sold in exactly one place');
eq(RIDES.balloon.unlock.locs[0], 'treasury', 'and that place is the City Treasury');
ok(LOC_BY_ID.treasury.acts.includes('bike'),
  'the Treasury runs a ride forecourt, or the counter renders nothing');
for (const id of ['bike', 'scooter', 'motorcycle']) {
  ok(!RIDES[id].unlock.assets, `the ${id}'s unlock is untouched by the new gate`);
}

/* THE RACE. A balloon cannot win a street race, and it must not be
   missing from the pace table either — game.js reads
   RACE.street[rideId] || RACE.street.foot, so an unlisted machine
   silently sets the Mayor's pace from a walking speed. */
ok(!RACE.qualifies.includes('balloon'), 'the balloon does not qualify for the Mayor\'s Dash');
ok(Number.isFinite(RACE.street.balloon), 'but it IS in the pace table', RACE.street.balloon);
/* THE PACE TABLE AGAINST THE DELIVERED CEILING, NOT AGAINST `reach`.
   This used to read `near(RACE.street.balloon, FLIGHT.reach, 0.6)`,
   which was the same claim while the stick was the whole of the
   machine's speed. It is not any more: the air was re-split against
   the stick (see FLIGHT's header — 7.5:1 down to 2.0:1) and what a
   racer in a balloon actually does over the ground is the stick PLUS
   the air it is riding. reach alone is now 6.20 and the pace table
   would be measuring the wrong half of the model.
   data.js's comment beside RACE.street now says the same thing in the
   same terms. It used to say "9.0 is the balloon's real drift ceiling
   (FLIGHT.reach)" — the same claim under the old split, and a stale
   sentence under this one, with the number still right for a reason it
   no longer gave. */
const DOWNWIND = FLIGHT.reach + FLIGHT.windNom * FLIGHT.windGain;
near(RACE.street.balloon, DOWNWIND, 0.6,
  'and the pace table agrees with the flight model\'s own DOWNWIND ceiling',
  `table ${RACE.street.balloon}, model ${DOWNWIND.toFixed(2)}`);

/* The fare board can price it, and it prices SLOWER than the motorcycle. */
{
  const a = LOCATIONS[0].id, b = LOCATIONS[LOCATIONS.length - 1].id;
  const bal = rideFare('balloon', a, b), mc = rideFare('motorcycle', a, b);
  ok(Number.isFinite(bal.mins) && bal.mins > 0, 'a balloon fare quotes real minutes', bal.mins);
  ok(bal.mins > mc.mins, 'and more of them than the motorcycle', `${bal.mins} vs ${mc.mins}`);
  ok(bal.energy < mc.energy, 'for less energy than the motorcycle', `${bal.energy} vs ${mc.energy}`);
}

/* ============================================================
   A2. THE FLIGHT MODEL — the pure integrator, no browser.

   THE BRANCH EACH ONE EXERCISES IS NAMED. A flight test that only
   ever runs the burner will agree with itself about anything, so
   every claim here has its counter-case beside it.
   ============================================================ */
T('the flight model');
const DT = 1 / 60;
const AIR = { windX: 0, windZ: 0 };
const NOIN = { x: 0, z: 0, burn: false, vent: false };
function run(S, input, secs, env = AIR) {
  const trace = [];
  for (let t = 0; t < secs; t += DT) { stepFlight(S, input, env, DT); trace.push({ t, ...S }); }
  return trace;
}

/* --- the terminals --- */
{
  const S = newFlight(0);
  run(S, { x: 0, z: 0, burn: true, vent: false }, 40);
  near(S.vy, FLIGHT.vMaxUp, 0.2, 'full burner reaches the climb ceiling', S.vy.toFixed(2));
  ok(S.vy <= FLIGHT.vMaxUp + 1e-6, 'and never exceeds it');
}
{
  const S = newFlight(0); S.heat = 1;
  run(S, { x: 0, z: 0, burn: false, vent: true }, 40);
  ok(S.vy < -2.5 && S.vy >= -FLIGHT.vMaxDown - 1e-6,
    'a full vent sinks, and slower than it climbs — venting only removes what the burner put in',
    S.vy.toFixed(2));
}
{
  const S = newFlight(0);
  run(S, { x: 0, z: 1, burn: false, vent: false }, 80);
  near(Math.hypot(S.vx, S.vz), FLIGHT.reach, 0.05, 'full stick reaches the drift ceiling');
  /* THE CONTROL: no stick, no wind, nothing moves. Without this the
     assertion above passes on any code that sets a velocity. */
  const C = newFlight(0);
  run(C, NOIN, 80);
  near(Math.hypot(C.vx, C.vz), 0, 1e-6, 'and with no stick and no wind it does not drift at all');
}

/* --- THE LAG, which is the whole character --- */
{
  const S = newFlight(0);
  S.heat = FLIGHT.trim;                       // trimmed, hands off
  /* four seconds of burner, then let go */
  const up = run(S, { x: 0, z: 0, burn: true, vent: false }, 4);
  const vAtRelease = S.vy;
  ok(vAtRelease > 1.5, 'four seconds of burner is climbing properly', vAtRelease.toFixed(2));
  const coast = run(S, NOIN, 10);
  /* it goes on climbing for seconds after the burner is out */
  let stillUp = 0;
  for (const r of coast) if (r.vy > 0) stillUp = r.t;
  ok(stillUp > 3.5, 'and she keeps climbing for over three seconds after you let go — the lag IS the balloon',
    stillUp.toFixed(1) + ' s');
  ok(stillUp < 9, 'but not for ever', stillUp.toFixed(1) + ' s');
  /* THE CONTROL: an instantaneous model would stop the moment the
     burner did. This is what distinguishes a balloon from a drone and
     it is the assertion the whole design rests on. */
  ok(coast[0].vy > 0.9 * vAtRelease,
    'and the frame after release is still doing nine tenths of it — nothing snaps');
}

/* --- the horizontal lag, and its time constant --- */
{
  const S = newFlight(0);
  const tr = run(S, { x: 0, z: 1, burn: false, vent: false }, 30);
  let tau = 0;
  for (const r of tr) { if (!tau && Math.hypot(r.vx, r.vz) > 0.632 * FLIGHT.reach) tau = r.t; }
  near(tau, 1 / FLIGHT.hLag, 0.35, 'the drift time constant is 1/hLag, about four and a half seconds',
    tau.toFixed(2) + ' s');
  ok(tau > 3, 'which is slow enough that you aim forty metres ahead or not at all');
}

/* --- the wind is a BIAS, not a passenger --- */
{
  const S = newFlight(0);
  run(S, NOIN, 60, { windX: 0.5, windZ: 0 });
  near(S.vx, 0.5 * FLIGHT.windGain, 0.02, 'with no stick she goes where the air goes', S.vx.toFixed(2));
  /* and the stick can beat it, which is the playability half */
  const S2 = newFlight(0);
  run(S2, { x: -1, z: 0, burn: false, vent: false }, 60, { windX: 0.5, windZ: 0 });
  ok(S2.vx < 0, 'and full stick into the wind still makes ground against it', S2.vx.toFixed(2));
}

/* --- THE AIR AGAINST THE STICK ---
       The design note this answers is "the stick is 7:1 over the air",
       and the only way to assert a BALANCE is to integrate both ends
       of it and take the ratio. windNom is the measured mean magnitude
       of ctx.wind.vector() (see FLIGHT), so this is the air the game
       actually has rather than the air the constants imply. */
{
  const air = FLIGHT.windNom * FLIGHT.windGain;
  ok(FLIGHT.reach / air < 3.0,
    'the stick is under three times the air — the player rides the wind rather than ignoring it',
    `stick ${FLIGHT.reach.toFixed(2)} vs air ${air.toFixed(2)} = ${(FLIGHT.reach / air).toFixed(2)}:1`);
  ok(FLIGHT.reach > air,
    'but it still beats it, or you could never come home', `${FLIGHT.reach} > ${air.toFixed(2)}`);

  const ENV = { windX: 0, windZ: FLIGHT.windNom };
  const D = newFlight(0); run(D, { x: 0, z: 1, burn: false, vent: false }, 90, ENV);
  const U = newFlight(0); run(U, { x: 0, z: -1, burn: false, vent: false }, 90, ENV);
  const down = Math.abs(D.vz), up = Math.abs(U.vz);
  near(down, RACE.street.balloon, 0.6,
    'dead downwind she makes the pace the race table quotes', down.toFixed(2));
  ok(up > 2.2 && up < 4.4,
    'dead upwind she still makes ground, at under walking pace (5.9) — this is the playability half',
    up.toFixed(2) + ' m/s');
  ok(down / up > 2.0,
    'and the two directions differ by more than a factor of two, which is the whole design note',
    `${down.toFixed(2)} / ${up.toFixed(2)} = ${(down / up).toFixed(2)}`);
  /* THE COUNTER-CASE, and it is the revert check: with the old
     3.60 windGain the same integration comes back 10.03 down and
     8.15 up, a ratio of 1.23, and the two assertions above go red. */
  const oldAir = FLIGHT.windNom * 3.60;
  ok((FLIGHT.reach + air) / (FLIGHT.reach + oldAir) > 1.0,
    'and the delivered downwind speed did not simply get slower — the air took over the difference',
    `air ${oldAir.toFixed(2)} -> ${air.toFixed(2)} m/s`);
}

/* --- the lazy turn --- */
{
  const S = newFlight(0);
  S.vx = FLIGHT.reach; S.vz = 0;              // drifting due east, facing north
  run(S, { x: 0, z: 0, burn: false, vent: false }, 1.0, AIR);
  const turned = Math.abs(S.yaw);
  ok(turned > 0.01, 'the basket comes round toward the drift', turned.toFixed(3));
  ok(turned < 0.9, 'lazily — a second is nowhere near enough to finish the turn', turned.toFixed(3));
}

/* --- it cannot be broken by a bad timestep --- */
{
  const S = newFlight(0);
  stepFlight(S, { x: 1, z: 1, burn: true, vent: false }, AIR, 6);       // a stalled tab
  ok(Number.isFinite(S.vx) && Number.isFinite(S.vy) && Number.isFinite(S.heat),
    'a six-second frame does not produce a non-finite state');
  ok(S.vy <= FLIGHT.vMaxUp, 'and cannot launch him through the clamp', S.vy.toFixed(2));
  stepFlight(S, NOIN, AIR, -1);
  ok(Number.isFinite(S.vy), 'and neither does a negative one');
}

/* --- the burner beats the vent, so the water refusal cannot be
       cancelled by a stuck key --- */
{
  const S = newFlight(0); S.heat = 0.5;
  stepFlight(S, { x: 0, z: 0, burn: true, vent: true }, AIR, 1);
  ok(S.heat > 0.5, 'burner and vent together is a burner', S.heat.toFixed(3));
}

/* ============================================================
   A3. THE FIT — the machine has to fit the elephant standing in it
   ============================================================ */
T('the fit');
near(FIT.RIM, FIT.DECK + FIT.WALL, 1e-9, 'the rim is the deck plus the wall');
near(FIT.TOP, FIT.MOUTH + FIT.ENV_H, 1e-9, 'the top is the throat plus the envelope');
ok(FIT.RIM - FIT.DECK > 0.60 && FIT.RIM - FIT.DECK < 1.05,
  'the rim crosses a 1.6 m elephant at the chest — he stands IN it, not behind it',
  (FIT.RIM - FIT.DECK).toFixed(2) + ' m over the deck');
ok(FIT.MOUTH > FIT.DECK + 1.6,
  'and the throat clears his crown, so the burner is not in his ears',
  `${FIT.MOUTH} > ${(FIT.DECK + 1.6).toFixed(2)}`);
ok(FIT.HALF > 0.45, 'the basket is wide enough that his idle arms do not clip the wall', FIT.HALF);
ok(FIT.TOP > 8 && FIT.TOP < 14, 'and the whole thing is a landmark without being a skyscraper', FIT.TOP);

/* ============================================================
   A4. THE GATES, BOTH WAYS ROUND
   ============================================================ */
T('buying it');
function rig({ rep = 90, money = 1e6, assets = 60, loc = 'treasury', hour = 11 } = {}) {
  const g = createGame({ seed: 0xba1100n ? 0xba1100 : 1, autosave: false });
  const st = g.state;
  st.rep = rep; st.money = money; st.loc = loc;
  st.time = hour * 60;
  st.known.treasury = true; st.access = st.access || {}; st.access.treasury = true;
  st.tokenized = {};
  for (let i = 0; i < assets; i++) st.tokenized[ASSETS[i].id] = true;
  return g;
}
{
  const g = rig();
  const chk = g.actions.canBuyRide('balloon');
  ok(chk.ok, 'a late-game player standing at the Treasury may buy it', chk.why);
  const bought = g.actions.buyRide('balloon');
  ok(bought.ok, 'and the purchase goes through');
  ok(g.actions.ownsRide('balloon'), 'and he owns it');
  eq(g.state.money, 1e6 - RIDES.balloon.price, 'and it cost exactly the list price');
  /* IT DOES NOT AUTO-EQUIP OVER A FASTER MACHINE. */
  const g2 = rig();
  g2.actions.grantRide('motorcycle');
  eq(g2.state.rides.equipped, 'motorcycle', 'the motorcycle equips itself when granted');
  g2.actions.buyRide('balloon');
  eq(g2.state.rides.equipped, 'motorcycle', 'and buying the balloon does NOT take it off him');
  ok(g2.actions.equipRide('balloon').ok, 'but he can choose it');
  eq(g2.state.rides.equipped, 'balloon', 'and then it is the one with him');
  eq(g2.state.rides.owned.motorcycle, true, 'while the motorcycle stays in the shed');
}
/* every gate, refused on its own */
{
  const poor = rig({ money: 100 });
  ok(!poor.actions.canBuyRide('balloon').ok, 'no money, no balloon');
  ok(/need \$/.test(poor.actions.canBuyRide('balloon').why), 'and it says so in dollars');

  const green = rig({ rep: 20 });
  ok(!green.actions.canBuyRide('balloon').ok, 'no reputation, no balloon');
  ok(/reputation/i.test(green.actions.canBuyRide('balloon').why), 'and it says which', green.actions.canBuyRide('balloon').why);

  /* THE ONE THAT MATTERS, and the one no other ride has: rich,
     reputable, standing in the right room, and refused because he has
     not actually done anything to the city yet. */
  const idle = rig({ assets: 0 });
  const c = idle.actions.canBuyRide('balloon');
  ok(!c.ok, 'a rich reputable player who has tokenized nothing is refused');
  ok(/tokenized/.test(c.why), 'and told exactly what is missing', c.why);
  eq(c.assets, RIDES.balloon.unlock.assets, 'the refusal carries the bar');
  eq(c.assetsHave, 0, 'and how far off he is');

  const away = rig({ loc: 'trunkdepot' });
  ok(!away.actions.canBuyRide('balloon').ok, 'Dispatch does not sell balloons');
  const shut = rig({ hour: 3 });
  ok(!shut.actions.canBuyRide('balloon').ok, 'and neither does the Treasury at three in the morning');
}

/* ============================================================
   A5. WHERE HE LEFT IT — the record, and the save round trip
   ============================================================ */
T('the parked spot');
{
  const g = rig();
  g.actions.buyRide('balloon');
  eq(g.actions.parkSpot('balloon'), null, 'a machine that has never been put down is nowhere');
  const r = g.actions.setParkSpot('balloon', { x: -123.456, y: 12.5, z: 88.25, yaw: 1.75 });
  ok(r.ok, 'a spot can be recorded');
  const at = g.actions.parkSpot('balloon');
  near(at.x, -123.46, 0.01, 'and it comes back');
  near(at.yaw, 1.75, 0.01, 'with its heading');
  ok(!('pitch' in at), 'and WITHOUT a pitch — the terrain re-solves that, and a stored answer could contradict it');

  /* THE ROUND TRIP, through the real save module. */
  const store = createSave({ bus: g.bus, state: g.state, makeRng: mulberry32, mutate: { note() {} } });
  const text = store.exportJSON(g.state);
  const back = store.importJSON(text);
  ok(!!back, 'the save parses back');
  ok(!!back.rides.parked.balloon, 'and the balloon is still parked somewhere in it');
  near(back.rides.parked.balloon.x, -123.46, 0.01, 'at the same place');
  eq(back.rides.owned.balloon, true, 'and still owned');

  /* AND A SPOT FOR SOMETHING HE DOES NOT OWN IS DROPPED, so a
     hand-edited file cannot put a phantom balloon on the lawn. */
  const g2 = rig();
  g2.state.rides.parked = { balloon: { x: 1, y: 2, z: 3, yaw: 0 }, motorcycle: { x: 4, y: 5, z: 6, yaw: 0 } };
  g2.actions.rides();
  eq(g2.actions.parkSpot('balloon'), null, 'a spot for an unowned machine is dropped on the next sync');

  /* and a non-finite one, which is how you lose a machine under the map */
  const g3 = rig();
  g3.actions.buyRide('balloon');
  g3.state.rides.parked.balloon = { x: NaN, y: 0, z: 0, yaw: 0 };
  g3.actions.rides();
  eq(g3.actions.parkSpot('balloon'), null, 'and so is a non-finite one');

  /* A SAVE FROM BEFORE ANY OF THIS still loads. */
  const old = newState(mulberry32(7));
  delete old.rides.parked;
  old.version = CONFIG.version;
  const fixed = store.migrate(JSON.parse(JSON.stringify(old)));
  ok(!!fixed, 'a save with no parked record migrates');
  const g4 = createGame({ seed: 1, autosave: false });
  Object.assign(g4.state, fixed);
  ok(typeof g4.actions.parkSpots() === 'object', 'and gets an empty one');
}

/* ============================================================
   A6. IT IS NEVER REQUIRED
   ============================================================ */
T('the invariant');
{
  const g = rig({ money: 0, rep: 0, assets: 0 });
  g.state.energy = 0;
  const board = g.fares(LOCATIONS[5].id);
  const walk = board.find((f) => f.mode === 'walk');
  ok(walk && walk.ok, 'a broke, exhausted, balloon-less player can still walk');
}

/* ============================================================
   A7. THE DELIVERABLE — the file the user actually opens.

   EVERY OTHER ASSERTION IN THIS SUITE IS ABOUT src/. WALLY-RPG.html is
   what a person double-clicks, and nothing in the gate used to look at
   it at all: `git show HEAD:WALLY-RPG.html` was 2 597 021 bytes and
   contained ZERO occurrences of `balloon.envelope`. Two hundred green
   assertions about a balloon, and the deliverable did not have one.
   Nothing was broken — the build had simply not been re-run, which is
   the worst failure mode available here because every symptom of it is
   invisible: the stale file boots, renders and looks entirely fine.

   `build.mjs --check` rebuilds in memory and compares byte for byte
   with the file on disk, then audits the module graph, the export
   census and the subsystem markers. It is a second or two of esbuild
   and no browser. See tools/build.mjs's header for what each check
   catches.

   REVERT CHECK: touch anything under src/ and do not rebuild, and this
   goes red with the size delta and the first byte that differs.
   ============================================================ */
T('the deliverable');
{
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/build.mjs'), '--check'],
    { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  ok(r.status === 0,
    'WALLY-RPG.html is the game this source tree builds — the standalone deliverable is not stale',
    out.split('\n').slice(-8).join(' | ') || `exit ${r.status}`);
  /* AND THE CHECKER ITSELF RAN. An audit that exited early would leave
     the line above green for the wrong reason, which is the exact
     defect this suite exists to refuse. */
  ok(/modules\s+\d+\/\d+/.test(out) && /exports\s+\d+\/\d+/.test(out)
     && /markers\s+\d+\/\d+/.test(out) && /size\s+/.test(out),
    'and it got there by running all four censuses, not by exiting early',
    out.split('\n').filter((l) => /^\s+(modules|exports|markers|size)\s/.test(l)).join(' · '));
}

if (!DATA_ONLY) await browserHalf();

/* ============================================================
   PART B — THE LIVE GAME
   ============================================================ */
async function browserHalf() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
  const server = createServer(async (req, res) => {
    try {
      const clean = decodeURIComponent(req.url.split('?')[0]);
      const path = join(ROOT, clean === '/' ? 'index.html' : clean);
      if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  try {
    await page.goto(`http://127.0.0.1:${port}/index.html?shot=1`, { waitUntil: 'load', timeout: 60000 });
    /* THE SECOND ARGUMENT IS THE PAGE FUNCTION'S ARG, NOT THE OPTIONS.
       page.waitForFunction( fn, arg, options ) — passing the options
       object where `arg` goes silently leaves the timeout at
       playwright's 30 s default, and this suite boots a whole city
       twice. It failed exactly once, at load average 41, and the
       message said 30000 ms while the call said 60000. */
    await page.waitForFunction('window.__WALLY_READY__ === true', null, { timeout: 120000 });
    await page.waitForTimeout(1500);

    /* ---------- B1. the geometry ---------- */
    T('the machine, live');
    const geo = await page.evaluate(() => {
      const T3 = WALLY.THREE;
      WALLY.debug.balloonPose(1);
      const p = WALLY.ctx.wally.rideProps.balloon;
      let env = null;
      p.group.traverse((o) => { if (o.name === 'balloon.envelope' && !o.userData.isOutlineHull) env = o; });
      const g = env.geometry;
      const pos = g.getAttribute('position'), idx = g.index;
      /* THE WINDING, MEASURED. Take every hundredth triangle, build
         its geometric face normal, and dot it with the outward
         direction from the envelope's own axis. Positive means the
         face looks out of the balloon. An inverted winding renders as
         a flat sheet of outline colour and looks entirely plausible —
         see balloon.js's index buffer note — so this is measured
         rather than eyeballed. */
      let outward = 0, inward = 0, worst = 1;
      const a = new T3.Vector3(), b = new T3.Vector3(), c = new T3.Vector3();
      const ab = new T3.Vector3(), ac = new T3.Vector3(), n = new T3.Vector3(), r = new T3.Vector3();
      for (let i = 0; i < idx.count; i += 300) {
        a.fromBufferAttribute(pos, idx.getX(i));
        b.fromBufferAttribute(pos, idx.getX(i + 1));
        c.fromBufferAttribute(pos, idx.getX(i + 2));
        ab.subVectors(b, a); ac.subVectors(c, a);
        n.crossVectors(ab, ac).normalize();
        r.set((a.x + b.x + c.x) / 3, 0, (a.z + b.z + c.z) / 3);
        if (r.lengthSq() < 1e-6) continue;
        r.normalize();
        const d = n.dot(r);
        if (d > 0) outward++; else inward++;
        worst = Math.min(worst, d);
      }
      /* the hull normals the outline pass reads must be outward too */
      const hn = g.getAttribute('aHullN');
      let hullOut = 0, hullIn = 0;
      for (let i = 0; i < pos.count; i += 37) {
        const px = pos.getX(i), pz = pos.getZ(i);
        const l = Math.hypot(px, pz);
        if (l < 0.2) continue;
        (hn.getX(i) * px / l + hn.getZ(i) * pz / l > 0) ? hullOut++ : hullIn++;
      }
      const counts = { meshes: 0, tris: 0, hulls: 0, hullTris: 0 };
      p.group.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const gg = o.geometry;
        const t = gg.index ? gg.index.count / 3 : gg.attributes.position.count / 3;
        if (o.userData.isOutlineHull) { counts.hulls++; counts.hullTris += t; }
        else { counts.meshes++; counts.tris += t; }
      });
      const bs = g.boundingSphere;
      return { outward, inward, worst, hullOut, hullIn, counts,
        vcolor: !!g.getAttribute('color'), bsR: bs ? +bs.radius.toFixed(2) : null,
        fit: WALLY.debug.balloonInfo().fit };
    });
    ok(geo.inward === 0 && geo.outward > 20,
      'the envelope\'s triangles face outward — an inverted winding renders as a flat sheet of outline colour and looks plausible',
      `${geo.outward} out / ${geo.inward} in`);
    ok(geo.hullIn === 0 && geo.hullOut > 20,
      'and so do the hull normals the §2.2 outline pass expands along',
      `${geo.hullOut} out / ${geo.hullIn} in`);
    ok(geo.vcolor, 'the livery rides in the vertex stream, so the envelope is one mesh');
    ok(geo.counts.tris < 9000, 'the machine is inside the vehicle budget', geo.counts.tris + ' triangles');
    ok(geo.counts.meshes < 20,
      'and collapsed to a handful of meshes — the draw-call count, not the triangle count, is what a prop this size costs',
      geo.counts.meshes + ' meshes, ' + geo.counts.hulls + ' hulls');
    ok(geo.counts.hulls > 0, 'and it carries §2.2 outline hulls', geo.counts.hulls);

    /* ---------- B2. the inflation morph ---------- */
    T('the inflation');
    const infl = await page.evaluate(() => {
      const p = WALLY.ctx.wally.rideProps.balloon;
      const out = [];
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        p.setInflate(t);
        let env = null;
        p.group.traverse((o) => { if (o.name === 'balloon.envelope' && !o.userData.isOutlineHull) env = o; });
        const g = env.geometry, pos = g.getAttribute('position');
        let minY = 1e9, maxY = -1e9, maxR = 0, maxX = 0;
        for (let i = 0; i < pos.count; i++) {
          const y = pos.getY(i);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getZ(i)));
          /* WIDTH IS MEASURED ON X, NOT AS A RADIUS. The cold envelope
             is folded FORWARD, so a distance-from-the-axis measure
             counts the fold as width and answers that a heap is nearly
             as wide as a balloon. x is across the fold and is the
             honest half-width of either. */
          maxX = Math.max(maxX, Math.abs(pos.getX(i)));
        }
        out.push({ t, minY: +minY.toFixed(2), maxY: +maxY.toFixed(2), maxR: +maxR.toFixed(2), maxX: +maxX.toFixed(2),
          bs: +g.boundingSphere.radius.toFixed(2), is: +p.inflation.toFixed(3) });
      }
      p.setInflate(1);
      return out;
    });
    const cold = infl[0], hot = infl[4];
    ok(cold.maxY < 4.6, 'a cold envelope is under four and a half metres tall — it fits in a street', cold.maxY);
    ok(hot.maxY > 9, 'and a hot one is a landmark', hot.maxY);
    ok(cold.minY <= 0.10, 'the cold fabric reaches the ground rather than floating over it', cold.minY);
    ok(cold.maxX < hot.maxX * 0.72, 'and it is much narrower cold than hot',
      `${cold.maxX} m half-width vs ${hot.maxX}`);
    for (let i = 1; i < infl.length; i++) {
      ok(infl[i].maxY > infl[i - 1].maxY, `inflation is monotonic at t=${infl[i].t}`, infl[i].maxY);
    }
    /* THE BOUNDING SPHERE HAS TO FOLLOW THE MORPH or the frustum
       culler pops the envelope out of a frame it is still in, which
       §6 forbids by name. */
    for (const r of infl) {
      ok(r.bs > Math.max(r.maxR, (r.maxY - r.minY) / 2) - 0.01,
        `the bounding sphere covers the fabric at t=${r.t}`, `${r.bs} vs r ${r.maxR}`);
    }

    /* ---------- B3. take-off, solved not timed ---------- */
    T('take-off');
    const lift = await page.evaluate(async () => {
      WALLY.debug.balloon(false);
      const w = WALLY.ctx.wally;
      const before = { y: w.position.y, ctl: !!w.controller.enabled };
      WALLY.debug.balloon();
      const y0 = w.position.y;
      const seen = [];
      const t0 = performance.now();
      /* a WALL-CLOCK bound as well as a frame bound: a promise that
         only ever resolves from rAF hangs for ever if rAF stalls */
      while (performance.now() - t0 < 14000) {
        await new Promise((r) => requestAnimationFrame(r));
        const s = w.flightState;
        seen.push({ t: (performance.now() - t0) / 1000, ph: s.phase, alt: s.alt, inf: s.inflate,
          burner: s.burner, gain: w.position.y - y0 });
        if (w.position.y - y0 > 30) break;
      }
      const s = w.flightState;
      /* when did she leave the ground, and how inflated was she? */
      const off = seen.find((r) => r.alt > 0.25);
      const atOff = off ? seen.find((r) => r.t >= off.t) : null;
      return { before, seen: seen.length, off: off ? off.t : null, infAtOff: atOff ? atOff.inf : null,
        finalAlt: s.alt, gain: Math.max(...seen.map((r) => r.gain)),
        phase: s.phase, burner: Math.max(...seen.map((r) => r.burner)),
        first: seen[0], ctlAfter: !!w.controller.enabled };
    });
    ok(lift.before.ctl, 'the controller is running before he boards');
    ok(!lift.ctlAfter, 'and switched off while he flies — the balloon owns the position');
    ok(lift.off !== null, 'she leaves the ground', lift.off && lift.off.toFixed(2) + ' s');
    ok(lift.infAtOff !== null && lift.infAtOff > 0.55,
      'and only once the envelope is genuinely inflated — the lift-off is solved, not timed',
      'inflation ' + (lift.infAtOff || 0).toFixed(2) + ' at lift-off');
    ok(lift.burner > 0.5, 'with the burner lit for the whole inflation', lift.burner.toFixed(2));
    ok(lift.gain > 15, 'and climbs away on the heat the inflation put in', lift.gain.toFixed(1) + ' m');
    ok(lift.first.alt < 0.3, 'nothing teleports on the first frame of a boarding', lift.first.alt);

    /* ---------- B4. the haze at altitude ---------- */
    T('the map from the air');
    const air = await page.evaluate(async () => {
      const w = WALLY.ctx.wally;
      const ground = [WALLY.ctx.scene.fog.near, WALLY.ctx.scene.fog.far];
      WALLY.debug.balloon({ alt: 200 });
      /* THE CAMERA IS DAMPED, so this has to wait for it to settle
         rather than for one frame: the rig is seeded from wherever the
         lens already was (that is the whole point — no snap) and eases
         out over about a second and a half. Measured at 900 ms it was
         still 30 m short of its target and the assertion below read as
         a failure of the framing rather than of the wait. */
      await new Promise((r) => setTimeout(r, 3000));
      const s = w.flightState;
      return { ground, s, fog: [WALLY.ctx.scene.fog.near, WALLY.ctx.scene.fog.far],
        camMode: WALLY.ctx.cam.mode, camY: WALLY.ctx.camera.position.y,
        wallyY: w.position.y, camFar: WALLY.ctx.camera.far };
    });
    ok(air.s.alt > 150, 'he is genuinely two hundred metres up', air.s.alt);
    ok(air.s.hazeK > 0.9, 'the altitude haze term is fully open', air.s.hazeK);
    ok(air.fog[1] > air.ground[1] * 3,
      'and the fog\'s far plane has opened out by more than 3x, so the island reads as a whole',
      `${air.ground[1] | 0} -> ${air.fog[1] | 0}`);
    ok(air.fog[0] > air.ground[0] * 2,
      'with the near plane opened too, so the ground below is not hazed at arm\'s length',
      `${air.ground[0] | 0} -> ${air.fog[0] | 0}`);
    ok(air.camFar > air.fog[1], 'and the camera\'s far plane is still beyond the fog', air.camFar);
    eq(air.camMode, 'override', 'the balloon is driving the camera');
    ok(air.camY > air.wallyY, 'from above the machine — absolute height, not height over the ground',
      `${air.camY.toFixed(0)} vs ${air.wallyY.toFixed(0)}`);

    /* ---------- B5. collision, both ways round ---------- */
    T('collision');
    const coll = await page.evaluate(async () => {
      const T3 = WALLY.THREE, phys = WALLY.ctx.phys, w = WALLY.ctx.wally;
      const world = WALLY.ctx.world;
      /* FIND A REAL WALL rather than trusting a location record: stand
         off the Market Hall and cast east until something solid that
         is not the ground answers. The test is worthless if it drives
         at empty air, so the wall is measured before the run. */
      const loc = WALLY.ctx.game.data.locations.find((l) => l.id === 'markethall');
      const z = loc.world.z;
      const gy = world.heightAt(loc.world.x, z);
      const y = gy + 3;
      /* CAST FIRST, THEN PLACE. Standing off a fixed 16 m and hoping
         a wall is there made the test's own precondition flaky — one
         run measured the nearest solid at 3.0 m and another at 74.6,
         because 16 m west of a location record is not necessarily
         16 m west of any wall. Sweep in from 44 m out, take the first
         solid, and put the machine twelve metres short of THAT. */
      let probe = null, startX = loc.world.x - 44;
      for (let d = 44; d > 8 && !probe; d -= 2) {
        const x = loc.world.x - d;
        const h = phys.raycast(new T3.Vector3(x, y + 0.7, z), new T3.Vector3(1, 0, 0), d + 4);
        if (h && h.distance > 10) { probe = h; startX = x + (h.distance - 12); }
      }
      if (!probe) return { wallAt: null, samples: 0 };
      WALLY.debug.balloon({ alt: 3, at: [startX, y + 0.26, z] });
      WALLY.debug.balloonStick(0, 0);
      await new Promise((r) => setTimeout(r, 80));
      /* full stick east, straight at it */
      WALLY.debug.balloonStick(1, 0);
      const t0 = performance.now();
      let closest = 1e9, inside = 0, samples = 0, maxDrift = 0;
      const east = new T3.Vector3(1, 0, 0), west = new T3.Vector3(-1, 0, 0), o = new T3.Vector3();
      while (performance.now() - t0 < 9000) {
        await new Promise((r) => requestAnimationFrame(r));
        const p = w.position;
        o.set(p.x, p.y + 0.7, p.z);
        const h = phys.raycast(o, east, 40);
        if (h) closest = Math.min(closest, h.distance);
        /* enclosed? a point inside a closed volume answers on both
           sides within its own half-width */
        const b = phys.raycast(o, west, 1.0), f = phys.raycast(o, east, 1.0);
        if (b && f && b.distance < 0.9 && f.distance < 0.9) inside++;
        maxDrift = Math.max(maxDrift, w.flightState.drift);
        samples++;
      }
      WALLY.debug.balloonStick(null, null);
      const s = w.flightState;
      return { wallAt: 12,
        closest: +closest.toFixed(2), inside, samples,
        maxDrift: +maxDrift.toFixed(2), alt: s.alt, x: +w.position.x.toFixed(2), startX: +startX.toFixed(2) };
    });
    ok(coll.wallAt !== null,
      'a real wall was found and the machine was placed twelve metres off it before the run',
      coll.wallAt + ' m');
    ok(coll.maxDrift > 3, 'and the balloon really drove at it', coll.maxDrift + ' m/s');
    ok(coll.samples > 50, 'the collision probe ran for real', coll.samples + ' frames');
    ok(coll.closest > 0.4,
      'the basket never gets inside a wall — it is stopped or it slides, and it never passes through',
      'closest approach ' + coll.closest + ' m');
    eq(coll.inside, 0, 'and is never enclosed by geometry on both sides at once');

    /* THE COUNTER-CASE. Up is never blocked: whatever the balloon is
       jammed against, the burner is always the way out. Without this
       the test above passes on code that simply freezes the machine,
       which is the "trapped" defect the brief names.

       MEASURED IN ABSOLUTE WORLD HEIGHT, AND THAT IS THE WHOLE FIX.
       This read `flightState.alt` at both ends for one round and it was
       the last flake in the suite — one red in thirteen, and the red
       one at a load of 3.95 while greens landed at 61, which is what
       ruled out a busy box. `alt` is `position.y - (flyGround + DECK)`
       CLAMPED AT ZERO, and flyGround is the highest SOLID under the
       footprint: it is a height over whatever happens to be beneath her
       rather than a height in the world. This block starts wherever B5
       left her — jammed against the Market Hall with the stick released
       and whatever eastward drift the collision did not kill still
       decaying out of her at tau 4.5 s. If the five seconds of burner
       carry her over the parapet, the ROOF slides under the basket,
       flyGround jumps by the height of the building and `alt` collapses
       while she is climbing perfectly well. Whether she tops the
       parapet inside the window is free — and it is the same
       roof-versus-street coin flip this suite was rebuilt to stop
       measuring, caught last round in the landing tests and left
       standing here, in the one block that still read a relative
       altitude. B3 above already measures its climb as
       `w.position.y - y0`; this is the same quantity, for the same
       reason.

       The position stays free, because "wherever she is jammed" IS the
       claim, and the measurement becomes the invariant that holds
       however it lands: the burner raises her IN THE WORLD, whatever
       passes underneath while it does. What the surface under her did
       is recorded and REPORTED rather than asserted, so the next time a
       roof slides under the basket this line says so instead of failing
       for it. And the control is what stops that being a loosening. */
    const escape = await page.evaluate(async () => {
      const T3 = WALLY.THREE, w = WALLY.ctx.wally, phys = WALLY.ctx.phys;
      const span = async (ms) => {
        const y0 = w.position.y, alt0 = w.flightState.alt;
        let peakVy = -1e9, lo = 1e9, hi = -1e9, n = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          await new Promise((r) => requestAnimationFrame(r));
          const s = w.flightState;
          if (s.vy > peakVy) peakVy = s.vy;
          if (s.ground < lo) lo = s.ground;
          if (s.ground > hi) hi = s.ground;
          n++;
        }
        const s = w.flightState;
        return { rise: +(w.position.y - y0).toFixed(2), frames: n,
          alt0, alt1: s.alt, peakVy: +peakVy.toFixed(2),
          groundSwing: +(hi - lo).toFixed(2) };
      };
      /* HOW JAMMED SHE ACTUALLY IS, for the record. Reported and not
         asserted: the claim is about the burner, and turning "B5 left
         her against a wall" into a second gate would only add a free
         variable to the thing that just had one taken out. */
      const o = new T3.Vector3(w.position.x, w.position.y + 0.7, w.position.z);
      const hits = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dz]) => phys.raycast(o, new T3.Vector3(dx, 0, dz), 20))
        .filter(Boolean).map((h) => h.distance);
      const wall = hits.length ? +Math.min(...hits).toFixed(2) : null;
      /* THE CONTROL FIRST, so it is the same machine wedged in the same
         place in the same air, and short enough that it cannot change
         where that place is. */
      WALLY.debug.balloonBurn(false);
      const cold = await span(1500);
      WALLY.debug.balloonBurn(true);
      const lit = await span(5000);
      WALLY.debug.balloonBurn(false);
      return { wall, cold, lit };
    });
    ok(escape.lit.rise > 3,
      'and the burner always gets her out of wherever she is — nothing can trap her, in absolute world height, so a roof passing under the basket cannot spend her altitude for her',
      `${escape.lit.rise} m of world height in ${escape.lit.frames} frames, peak ${escape.lit.peakVy} m/s`
      + `, wedged ${escape.wall === null ? 'in the open' : escape.wall + ' m off the nearest solid'}`
      + `, the surface under her moved ${escape.lit.groundSwing} m and alt read ${escape.lit.alt0} -> ${escape.lit.alt1}`);
    /* THE CONTROL. Without it "she went up" is also true of a machine
       still coasting on heat it already had, and the assertion above
       would pass on code the burner does nothing to. */
    ok(escape.lit.rise > escape.cold.rise + 3,
      'and it is the BURNER that does it — the same machine wedged in the same place does not climb with the burner out',
      `lit ${escape.lit.rise} m vs cold ${escape.cold.rise} m, peak vy ${escape.lit.peakVy} vs ${escape.cold.peakVy} m/s`);

    /* ---------- B6. landing and mooring ----------
       PINNED, and see CLEAR_SITE for how and why. What this test is
       about is the descent, the flare, the dismount and the park solve.
       WHERE she may come down is B6a's subject, and letting the wind
       decide it here is what put "standing on the ground he landed on"
       at 21.21 m against a terrain of 14.25 on the runs where she came
       down on a ROOF — which is not a defect, it is the thing criterion
       6 asks for by name. Two different questions, so two tests. */
    T('landing');
    const site = await page.evaluate(`${CLEAR_SITE}([45, 36, 30, 24, 18])`);
    ok(!!site, 'a clear inland site was found: unbuilt, unshored and gentle for a basket-landing radius in every direction',
      site && `${site.radius} m clear at ${site.x}, ${site.z} · ${site.deg} deg · ${site.shore} m from the shore · found in ${site.tries} probes`);
    if (!site) throw new Error('no clear site — see the line above');
    /* AND IT IS WIDE ENOUGH TO BE A PIN. The hands-off drift from 6 m
       is about six metres by the model's own constants and was measured
       at 13; a clearing under 18 would not contain it and the pin would
       be decoration. */
    ok(site.radius >= 18, 'and the clearing is wide enough to contain a hands-off descent', site.radius + ' m');
    const land = await page.evaluate(async (S) => {
      const w = WALLY.ctx.wally, world = WALLY.ctx.world, phys = WALLY.ctx.phys;
      /* HE HAS TO OWN IT before the spot can be recorded — game.js
         refuses a parked position for a machine that is not his, which
         is what stops a hand-edited save putting a phantom balloon on
         a lawn. The debug hook does not buy anything, so grant it. */
      WALLY.ctx.game.actions.grantRide('balloon');
      /* THE BASE WIND HELD DOWN, and the BASE restored afterwards
         rather than `wind.strength` — that getter is base PLUS gust,
         and handing it back through setStrength() would ratchet the
         whole field up by whatever gust happened to be blowing when it
         was read. This does not becalm the air (the gust machine runs
         on its own), which is why the site is clear over a
         neighbourhood and not just at a point. */
      const windWas = WALLY.ctx.wind.uniforms.uWindStrength.value;
      WALLY.ctx.wind.setStrength(0);
      WALLY.debug.balloon({ alt: 20, at: [S.x, S.y + 2, S.z] });
      await new Promise((r) => setTimeout(r, 200));
      const from = [w.position.x, w.position.z];
      /* ask her down the way the game does: unequip */
      w.setRide(null);
      const t0 = performance.now();
      let maxSink = 0, touchSink = null, phases = [], refused = false;
      while (performance.now() - t0 < 40000) {
        await new Promise((r) => requestAnimationFrame(r));
        const s = w.flightState;
        if (phases[phases.length - 1] !== s.phase) phases.push(s.phase);
        maxSink = Math.min(maxSink, s.vy);
        if (s.refusing) refused = true;
        if (s.alt < 0.4 && touchSink === null) touchSink = s.vy;
        /* A HAND ON THE STICK, HOLDING STATION OVER THE MARK — and
           it is the last thing this pin needed. Holding the base wind
           at zero does not stop the gusts, and a single gust during a
           ten-second descent moved her 19.56 m of a 30 m clearing on
           the run before this line existed. A landing nobody steers is
           B6a's subject; what THIS test is about is the flare, the
           mooring and the park solve, and all three want a known
           patch of ground under them. The stick is horizontal only, so
           nothing here touches the sink rates measured above. */
        const dx = S.x - s.at[0], dz = S.z - s.at[2];
        const d = Math.hypot(dx, dz);
        WALLY.debug.balloonStick(d > 0.2 ? (dx / d) * Math.min(1, d / 5) : 0,
          d > 0.2 ? (dz / d) * Math.min(1, d / 5) : 0);
        if (s.phase === 'off') break;
      }
      WALLY.debug.balloonStick(null);
      WALLY.ctx.wind.setStrength(windWas);
      const st = w.rideState;
      const spot = WALLY.ctx.game.actions.parkSpot('balloon');
      const p = WALLY.ctx.wally.rideProps.balloon;
      /* THE SURFACE, from the thing that knows about roofs. */
      const g = phys.groundAt(w.position.x, w.position.z);
      return { phases, maxSink: +maxSink.toFixed(2), touchSink: touchSink === null ? null : +touchSink.toFixed(2),
        parked: st.parked.map((x) => x.id), spot,
        inflation: +p.inflation.toFixed(3),
        onFeet: !!w.controller.enabled,
        camMode: WALLY.ctx.cam.mode,
        refused,
        wallyY: +w.position.y.toFixed(2),
        surfaceY: +g.y.toFixed(2),
        terrainY: +world.heightAt(w.position.x, w.position.z).toFixed(2),
        drift: +Math.hypot(w.position.x - from[0], w.position.z - from[1]).toFixed(2) };
    }, site);
    ok(land.phases.includes('landing'), 'unequipping in the air asks her down rather than dropping him', land.phases.join(' -> '));
    ok(land.phases[land.phases.length - 1] === 'off', 'and the landing completes');
    ok(land.touchSink !== null && land.touchSink > -1.6,
      'she arrives at under a metre and a half a second — the flare works',
      land.touchSink + ' m/s at touchdown');
    ok(land.maxSink < -0.5, 'having genuinely descended on the way', land.maxSink + ' m/s');
    ok(land.parked.includes('balloon'), 'and she is left standing where he got out', land.parked.join(','));
    ok(land.inflation < 0.05, 'with the envelope gone cold', land.inflation);
    ok(!!land.spot, 'the spot is recorded in the save state');
    ok(land.onFeet, 'and he is back on his own two feet');
    eq(land.camMode, 'follow', 'with the camera handed back to the follow rig');
    /* THE SURFACE IS phys.groundAt, NOT world.heightAt.
       heightAt is the TERRAIN. groundAt is the highest solid under the
       point, which is what the flight actually lands on and what makes
       a roof a place you can put it down. This assertion used to read
       heightAt and went red at 21.21 m against 14.25 on every run where
       the wind carried her onto a building — reporting a correct
       landing as a failure. */
    near(land.wallyY, land.surfaceY, 0.6,
      'he is standing on the surface she came down on — the highest solid under him, whatever it turned out to be',
      `${land.wallyY} m over a surface at ${land.surfaceY} m`);
    /* AND THE PIN HELD. Without this the assertion above is true on a
       rooftop too, and every mooring assertion below would then be
       measuring a park solve against terrain thirty metres beneath it.
       THE TOLERANCE IS 0.25 AND IT IS NOT SLACK: groundAt reads the
       collision mesh and heightAt evaluates the analytic field, and a
       tessellated hillside and the function it was tessellated from
       disagree by a few centimetres by construction. Anything built
       here is metres, not centimetres. */
    near(land.surfaceY, land.terrainY, 0.25,
      'and it is the open ground the site was chosen for rather than something built on it — the pin held',
      `groundAt ${land.surfaceY} vs terrain ${land.terrainY}, after ${land.drift} m of drift on the way down`);
    /* AND THE DRIFT STAYED INSIDE THE CLEARING, which is what makes the
       line above a pin rather than a coincidence: a landing that left
       the clear ground would be testing whatever it found out there. */
    ok(land.drift < site.radius,
      'and she came down inside the ground that was cleared for her rather than off the edge of it',
      `${land.drift} m of drift into a ${site.radius} m clearing`);
    ok(!land.refused,
      'she never had to refuse anything on the way down — the site is over a hundred and fifty metres from any water',
      site.shore + ' m from the shore');

    /* the parked machine conforms to the ground, exactly like the
       motorcycle does */
    const park = await page.evaluate(() => {
      const p = WALLY.ctx.wally.rideProps.balloon;
      const g = p.group, T3 = WALLY.THREE;
      g.updateMatrixWorld(true);
      const out = [];
      for (const w of p.wheels) {
        const v = new T3.Vector3();
        w.getWorldPosition(v);
        const h = WALLY.ctx.world.heightAt(v.x, v.z);
        out.push({ dy: +(v.y - 0.02 - h).toFixed(3) });
      }
      return { contacts: out, pitchDeg: +(g.rotation.x * 180 / Math.PI).toFixed(2),
        order: g.rotation.order, visible: g.visible, parked: p.parked };
    });
    ok(park.parked, 'the prop knows it is moored');
    eq(park.order, 'YXZ', 'and is composed yaw-then-pitch, so a machine facing east pitches nose-up');
    for (const c of park.contacts) {
      ok(Math.abs(c.dy) < 0.12,
        'each skid sits on the terrain rather than in it or over it', c.dy + ' m');
    }

    /* ---------- B6a. THE THREE PLACES YOU MIGHT COME DOWN ----------
       A roof, the sea and a hillside. Each one has a different right
       answer and each answer is a rule the player can learn in one
       go rather than a clamp they can only discover by hitting it. */
    T('where you can put it down');

    /* --- A ROOF IS GROUND. phys.groundAt takes the highest surface
       under a point, so this needs no code about roofs at all — but
       "needs no code" is exactly the kind of claim that turns out to
       be false, so it is measured.

       AND IT IS FLOWN NOW, WHICH IT DID NOT USED TO BE. This test
       dropped the machine over the tallest building with the stick at
       zero and waited. That was a fair test of the landing while the
       air was worth 1.14 m/s: twenty-two seconds of it moved her
       twenty-five metres and the roofs in this city are wider than
       that. With the air re-split against the stick (FLIGHT's header)
       the same twenty-two seconds is sixty-five metres and she is off
       the building long before she is down — which is not a bug in the
       landing, it is the design note being answered, and pretending
       otherwise by leaving the test hands-off would have quietly
       turned "the air matters" into "roofs are unreachable".

       So the approach is flown the way the stick exists to be flown,
       and the hands-off case is asserted BESIDE it as its own claim
       rather than deleted. Both are true and they are different
       statements: you can land on a roof, and you have to mean it.

       AND THE HANDS-OFF CLAIM IS NO LONGER A DISTANCE, because the
       distance is BIMODAL and a threshold on it is a coin toss. From
       6 m, hands off, the model's own constants say she travels
       3.10 * (t - 4.5 * (1 - e^-t/4.5)) metres while she falls, which
       over about five seconds of descent is six — and the roofs in
       this city are about that wide. So she either settles on the roof
       or clears the parapet and falls sixty-odd metres to the street,
       and the old `driftOff > 18` was fitted to the second outcome and
       went red on seven runs in thirteen when the coin came up the
       first. Both outcomes are CORRECT, and asserting the invariant
       instead of the distance was still not enough: on a run at load
       16.7 the hands-off machine cleared the parapet, fell to whatever
       is beside the building, and had not finished inside a 26 s
       window, so "she comes to rest" itself went red. The subject of
       that assertion was the coin, not the landing.

       SO THE COIN IS GONE AND THREE CLAIMS STAND IN ITS PLACE, and
       none of them is a number anybody watched happen:

         · FLOWN, she lands on the roof, and what she is standing on is
           the highest supported surface under her own footprint —
           reconstructed here from phys.groundAt at the basket's four
           corners, at the corner radius the basket actually has, so
           that "she is on the roof" is not the flight agreeing with
           itself;
         · HANDS OFF over B6's open site, the descent still finishes
           and still ends on real ground. That is the part of the
           hands-off case that is a property rather than a coin;
         · and THE AIR IS REAL, measured as a LAW rather than as a
           distance: twelve seconds aloft with the stick released, the
           wind recorded frame by frame, and the pure integrator
           replayed over exactly those frames. The live machine has to
           move what stepFlight says it moves in the air it was
           actually in, in magnitude AND in bearing. That claim holds
           whatever the wind did, and it fails the moment wally.js
           stops feeding the air in, scales it, or clamps it. */
    const roof = await page.evaluate(async ([HALF, SITE]) => {
      const w = WALLY.ctx.wally, world = WALLY.ctx.world, phys = WALLY.ctx.phys;
      /* the tallest thing in the city with a flat top: take the
         location with the biggest `h` and stand over its middle */
      const locs = WALLY.ctx.game.data.locations.filter((l) => l.size && l.size.h > 8);
      locs.sort((a, b) => b.size.h - a.size.h);
      const l = locs[0];
      const terrain = world.heightAt(l.world.x, l.world.z);
      const start = [l.world.x, terrain + l.size.h + 22, l.world.z];
      /* AND THE HANDS-OFF DESCENT GETS ITS OWN GROUND, which is the
         second half of the same lesson. Released over the roof she
         either settles on it or clears the parapet and falls sixty
         metres to whatever is beside the building — and "whatever is
         beside the building" is a terrace, a street, another roof or a
         quay, one of which does not always finish inside any window
         you care to wait. The FLOWN descent is what tests the roof;
         the hands-off descent tests that a landing nobody is steering
         still completes and still ends up on real ground, so it is
         flown over B6's clear site where that has one answer. */
      const openStart = [SITE.x, SITE.y + 2, SITE.z];

      /* THE HIGHEST SUPPORTED SURFACE UNDER THE BASKET, reconstructed
         from the public physics. The radius is the basket's own CORNER
         distance — hypot(FIT.HALF, FIT.HALF) — derived rather than
         copied out of wally.js, and the wall filter is the same one
         flyFootprint applies for the same reason: a probe that lands on
         the FACE of a building is not a surface a skid can stand on. */
      const footprintY = (x, z) => {
        let best = phys.groundAt(x, z).y;
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + 0.7854;
          const g = phys.groundAt(x + Math.cos(a) * HALF, z + Math.sin(a) * HALF);
          if (g.normal && g.normal.y < 0.5) continue;
          if (g.y > best) best = g.y;
        }
        return +best.toFixed(2);
      };

      async function descend(fly, from) {
        WALLY.debug.balloon({ alt: 6, at: from });
        WALLY.debug.balloonStick(0, 0);
        WALLY.debug.balloonBurn(false);
        await new Promise((r) => setTimeout(r, 150));
        const t0 = performance.now();
        let settled = null, maxOff = 0;
        while (performance.now() - t0 < 26000) {
          await new Promise((r) => requestAnimationFrame(r));
          const s = w.flightState;
          const dx = from[0] - s.at[0], dz = from[2] - s.at[2];
          const d = Math.hypot(dx, dz);
          if (d > maxOff) maxOff = d;
          /* a hand on the stick, steering back over the target */
          if (fly) WALLY.debug.balloonStick(d > 0.2 ? (dx / d) * Math.min(1, d / 5) : 0,
            d > 0.2 ? (dz / d) * Math.min(1, d / 5) : 0);
          if (s.alt < 0.2) {
            settled = { ...s, off: +d.toFixed(2),
              /* what the physics says is under her, independently of
                 what the flight decided to rest on */
              centre: +phys.groundAt(s.at[0], s.at[2]).y.toFixed(2),
              foot: footprintY(s.at[0], s.at[2]),
              terrainThere: +world.heightAt(s.at[0], s.at[2]).toFixed(2),
              secs: +((performance.now() - t0) / 1000).toFixed(2) };
            break;
          }
        }
        WALLY.debug.balloonStick(null);
        const s = w.flightState;
        /* WHY IT DID NOT SETTLE, WHEN IT DID NOT. A null with no
           diagnosis beside it costs a whole re-run to interpret, and
           this suite has now spent two rounds paying that: the last red
           it shipped said only "she also comes to rest" with nothing
           after it, and the difference between "still falling", "over
           water and refusing" and "wedged" is the entire question. */
        return { settled, maxOff: +maxOff.toFixed(1),
          gaveUp: settled ? null : {
            phase: s.phase, alt: s.alt, vy: s.vy, ground: s.ground,
            refusing: s.refusing, floored: s.floored, off: +maxOff.toFixed(1),
            at: s.at, overWater: world.isWater(s.at[0], s.at[2]),
            terrainThere: +world.heightAt(s.at[0], s.at[2]).toFixed(2),
            secs: +((performance.now() - t0) / 1000).toFixed(1) } };
      }

      /* TWELVE SECONDS ALOFT, HANDS OFF, WITH THE AIR WRITTEN DOWN.
         High enough over the same building that nothing can land, be
         refused or touch anything — this measures one thing, which is
         what the air does to a machine nobody is flying. */
      async function driftWindow(secs) {
        WALLY.debug.balloon({ alt: 120, at: start });
        WALLY.debug.balloonStick(0, 0);
        WALLY.debug.balloonBurn(false);
        await new Promise((r) => setTimeout(r, 300));
        const p0 = [w.position.x, w.position.z];
        const samples = [];
        let prev = performance.now();
        const t0 = prev;
        let touched = false, refused = false;
        while (performance.now() - t0 < secs * 1000) {
          await new Promise((r) => requestAnimationFrame(r));
          const now = performance.now();
          const dt = (now - prev) / 1000; prev = now;
          /* THE AIR AT HER OWN POSITION, the same call flyUpdate makes.
             Recorded per frame with the frame's own dt, so the replay
             below integrates the identical sequence rather than an
             average of it. */
          const v = WALLY.ctx.wind.vector(w.position.x, w.position.z);
          samples.push([+dt.toFixed(6), +v.x.toFixed(6), +v.z.toFixed(6)]);
          const s = w.flightState;
          if (s.alt < 20) touched = true;
          if (s.refusing || s.floored) refused = true;
        }
        WALLY.debug.balloonStick(null);
        const s = w.flightState;
        return { samples, touched, refused, endAlt: s.alt, phase: s.phase,
          dx: +(w.position.x - p0[0]).toFixed(3), dz: +(w.position.z - p0[1]).toFixed(3),
          moved: +Math.hypot(w.position.x - p0[0], w.position.z - p0[1]).toFixed(3) };
      }

      /* THE FLOWN ROOF DESCENT KEEPS THE LIVE AIR — beating it is the
         claim. The FREE descent holds the base wind down, because the
         biggest clearing this island can offer is thirty metres and a
         free descent from 6 m in full wind used sixteen of them: the
         claim being made there is that a landing nobody steers still
         finishes on real ground, and the air's own effect is claimed by
         the replay below, at full strength, where it belongs. */
      const flown = await descend(true, start);
      const windWas = WALLY.ctx.wind.uniforms.uWindStrength.value;
      WALLY.ctx.wind.setStrength(0);
      const drifted = await descend(false, openStart);
      WALLY.ctx.wind.setStrength(windWas);
      const air = await driftWindow(12);
      return { name: l.n, h: l.size.h, terrain: +terrain.toFixed(2),
        ground: flown.settled ? flown.settled.ground : null,
        off: flown.settled ? flown.settled.off : null,
        flownSettled: flown.settled, flownGaveUp: flown.gaveUp,
        driftSettled: drifted.settled, driftGaveUp: drifted.gaveUp,
        driftOff: drifted.maxOff, siteTerrain: SITE.y, air };
    }, [Math.hypot(FIT.HALF, FIT.HALF), site]);
    ok(roof.ground !== null, 'flown down on the stick, she comes down onto the roof', roof.name);
    ok(roof.ground > roof.terrain + 3,
      'and the thing she is standing on is the ROOF, not the street it is built on — groundAt takes the highest surface, so a roof needs no code of its own',
      `${roof.ground} m vs ${roof.terrain} m of terrain`);
    ok(roof.off !== null && roof.off < 6,
      'and she is still over the building she was aimed at', `${roof.off} m from the middle of it`);
    /* AND THE SAME SURFACE CLAIM, FROM THE PUBLIC PHYSICS. The line
       above reads the flight's own answer; this one reconstructs it
       from phys.groundAt over the basket's four corners and has to
       agree. Without it, "she is standing on the roof" is only the
       flight agreeing with itself. */
    if (ok(!!roof.flownSettled, 'the flown descent settled',
      roof.flownSettled ? `${roof.flownSettled.secs} s` : 'gave up: ' + JSON.stringify(roof.flownGaveUp))) {
      near(roof.flownSettled.ground, roof.flownSettled.foot, 0.15,
        'and what she settled on IS the highest supported surface under her footprint, measured independently',
        `flight ${roof.flownSettled.ground} m, footprint ${roof.flownSettled.foot} m, centre ray ${roof.flownSettled.centre} m`);
      ok(roof.flownSettled.foot >= roof.flownSettled.centre - 0.01,
        'and never below what a single centre ray would have found — a basket cannot rest under the thing beneath its middle',
        `${roof.flownSettled.foot} vs ${roof.flownSettled.centre}`);
    }

    /* AND A DESCENT NOBODY IS STEERING STILL FINISHES, over B6's open
       site rather than over the roof — see the note beside `openStart`
       for why that is a test-design fix and not a retreat. The claim
       is the invariant, not a distance: released, she comes down, she
       stops, and she stops ON something. */
    if (ok(!!roof.driftSettled,
      'and a descent with nobody on the stick finishes too — released over open ground she comes down and stops',
      roof.driftSettled
        ? `on ${roof.driftSettled.ground} m after ${roof.driftSettled.secs} s and ${roof.driftSettled.off} m of drift the air chose`
        : 'gave up: ' + JSON.stringify(roof.driftGaveUp))) {
      near(roof.driftSettled.ground, roof.driftSettled.foot, 0.15,
        'on the highest supported surface under her footprint, wherever the air put her down',
        `flight ${roof.driftSettled.ground} m, footprint ${roof.driftSettled.foot} m`);
      /* COMPARED ON THE CENTRE RAY, not on the flight's footprint
         answer: the footprint takes the highest of four corners at
         0.95 m, so on the 4-degree ground this site sits on it reads
         7 cm high against the terrain by arithmetic rather than by
         anything being built there. Comparing the thing that means
         "what is under her middle" against the terrain is the claim
         that was wanted, and 0.25 covers the collision mesh's own
         disagreement with the field it was tessellated from. */
      near(roof.driftSettled.centre, roof.driftSettled.terrainThere, 0.25,
        'which out here is the open ground itself — nothing is built inside the clearing and she never left it',
        `${roof.driftSettled.off} m of drift into a ${site.radius} m clearing`);
      ok(roof.driftSettled.off < site.radius,
        'and the air did not carry her off the cleared ground while she came down',
        `${roof.driftSettled.off} m against ${site.radius} m`);
    }

    /* THE AIR ITSELF, AS A LAW. Twelve seconds aloft, hands off, with
       the wind written down frame by frame; then the pure integrator —
       the same stepFlight the game runs, imported at the top of this
       file — replayed over exactly those frames. The live machine has
       to move what the model says it moves in the air it was actually
       in. This is what "the air matters" is; the 18 m it used to be
       measured against was a distance somebody watched once. */
    {
      const A = roof.air;
      const dts = A.samples.map((s) => s[0]);
      const secsFlown = dts.reduce((t, d) => t + d, 0);
      /* THE PRECONDITION IS THE TIME, NOT THE FRAME COUNT. This read
         `samples.length > 400` for one round and went red at load 17.5
         on a run where everything it was guarding passed: 361 frames is
         thirty a second, which is a slow machine and not a broken
         measurement. What the replay actually needs is that the window
         ran for the twelve seconds it claims and that it is a per-frame
         trace rather than a handful of enormous steps — and the frame
         rate is REPORTED, because a number worth knowing does not have
         to be a number worth failing on. */
      near(secsFlown, 12, 1.0,
        'the drift window ran for the twelve seconds it asks for',
        `${A.samples.length} frames at ${(A.samples.length / secsFlown).toFixed(0)} fps, phase ${A.phase}`);
      ok(A.samples.length >= 60 && dts.every((d) => d > 0 && Number.isFinite(d)),
        'and it is a frame-by-frame trace of the air, which is what the replay integrates',
        `longest frame ${Math.max(...dts).toFixed(3)} s, shortest ${Math.min(...dts).toFixed(3)} s`);
      ok(!A.touched && !A.refused,
        'at 120 m, with nothing under her to land on, refuse or bump into — so this measures the air and only the air',
        `ended at ${A.endAlt} m`);
      const S = newFlight(0);
      const E = { windX: 0, windZ: 0 };
      let px = 0, pz = 0;
      for (const [dt, wx, wz] of A.samples) {
        E.windX = wx; E.windZ = wz;
        stepFlight(S, NOIN, E, dt);
        px += S.vx * dt; pz += S.vz * dt;
      }
      const predicted = Math.hypot(px, pz);
      /* THE TOLERANCE IS TWO-SIDED AND IT IS 22%, which is what makes
         this an assertion rather than a formality: an air that had been
         scaled, clamped, sampled at the wrong point or dropped
         altogether fails it in one direction or the other. A2's
         stationary control already proves the integrator does not
         invent a drift of its own, so that is not repeated here. */
      ok(A.moved > 2,
        'hands off, the air moved her metres rather than millimetres over twelve seconds',
        `${A.moved} m in ${secsFlown.toFixed(1)} s`);
      near(A.moved, predicted, Math.max(0.8, predicted * 0.22),
        'and it moved her exactly what the flight model says that air should — the live machine obeys its own integrator',
        `live ${A.moved} m, model ${predicted.toFixed(2)} m over the same ${A.samples.length} frames`);
      /* AND THE BEARING, not just the magnitude: a scalar can agree by
         accident, two components cannot. */
      const bearing = Math.abs(Math.atan2(A.dx, A.dz) - Math.atan2(px, pz));
      ok(Math.min(bearing, Math.PI * 2 - bearing) < 0.35,
        'in the direction the model says too, not merely by the same amount',
        `live ${(Math.atan2(A.dx, A.dz) * 57.2958).toFixed(1)} deg, model ${(Math.atan2(px, pz) * 57.2958).toFixed(1)} deg`);
      /* THE DESIGN NOTE, in the two numbers this run actually produced
         and in the terms it is really about: with a hand on the stick
         she never gets more than a few metres from the mark, and with
         the stick released the air takes her further than that in the
         same air on the same day. */
      ok(A.moved > roof.off,
        'so the stick is what holds station: hands off she travels further than the flown approach ever gets from its mark',
        `${A.moved} m adrift against ${roof.off} m flown`);
    }

    /* --- THE SEA. She will not put you in it. The rule is visible:
       the burner fires itself and the machine declines. --- */
    const sea = await page.evaluate(async () => {
      const w = WALLY.ctx.wally, W = WALLY.ctx.game.data.world;
      const x = (W.islandRadiusX || 480) + 120;
      WALLY.debug.balloon({ alt: 14, at: [x, 14, 0] });
      await new Promise((r) => setTimeout(r, 120));
      let minY = 1e9, sawRefusal = false, sawFlame = false, sawFloor = false;
      const t0 = performance.now();
      while (performance.now() - t0 < 14000) {
        await new Promise((r) => requestAnimationFrame(r));
        const s = w.flightState;
        minY = Math.min(minY, s.at[1]);
        if (s.refusing) sawRefusal = true;
        if (s.burner > 0.3) sawFlame = true;
        if (s.floored) sawFloor = true;
      }
      return { minY: +minY.toFixed(2), sawRefusal, sawFlame, sawFloor,
        seaLevel: WALLY.ctx.world.seaLevel, end: w.flightState.at[1] };
    });
    ok(sea.minY > sea.seaLevel + 1.5,
      'she never gets within a metre and a half of the water', sea.minY + ' m over a sea at ' + sea.seaLevel);
    ok(sea.sawRefusal, 'because she refuses — this is a rule, not a clamp');
    ok(sea.sawFlame, 'and the refusal is VISIBLE: the burner lights itself and you can see it');
    ok(!sea.sawFloor,
      'and the burner alone did it — the hard floor under the refusal never had to engage',
      'floored: ' + sea.sawFloor);

    /* --- A SLOPE. The same conform every other machine gets. --- */
    const slope = await page.evaluate(async () => {
      const w = WALLY.ctx.wally, world = WALLY.ctx.world, T3 = WALLY.THREE;
      /* hunt a real gradient that is still inside the controller's
         own slope limit — steeper than that and she declines to
         settle, which is a different rule and is tested by the sea */
      let best = null;
      for (let i = 0; i < 4000 && !best; i++) {
        const a = i * 2.399963, r = 40 + (i % 300);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (world.isWater(x, z)) continue;
        /* WELL INLAND. A descent is not instantaneous and the wind is
           moving her the whole way down: the first version of this
           picked whatever slope it found first, she drifted over the
           shore on the way, the water refusal correctly fired the
           burner, and the test then reported a landing failure about
           a machine that was behaving perfectly. */
        if (world.shoreDistAt(x, z) < 140) continue;
        /* world.slopeAt IS 1 - n.y, NOT sin(theta). Reading it as a
           sine looked right and was out by a factor that grows with
           the angle: a search for "9 to 24 degrees" was really a
           search for 32 to 54, so this test spent two runs asking the
           machine to moor itself on a fifty-degree cliff — which she
           declined to do, correctly, through the same refusal that
           keeps her out of the sea, and the test called that a
           landing failure. theta = acos(1 - s). */
        const deg = Math.acos(Math.max(-1, Math.min(1, 1 - world.slopeAt(x, z)))) * 180 / Math.PI;
        if (deg > 9 && deg < 24) best = { x, z, deg: +deg.toFixed(1) };
      }
      if (!best) return { found: false };
      /* AND HOLD THE AIR STILL. This assertion is about the park
         solve, not about drift; §2.3's wind is asserted elsewhere and
         restored below. */
      const windWas = WALLY.ctx.wind.strength;
      WALLY.ctx.wind.setStrength(0);
      WALLY.ctx.game.actions.grantRide('balloon');
      const gy = world.heightAt(best.x, best.z);
      WALLY.debug.balloon({ alt: 4, at: [best.x, gy + 4, best.z] });
      await new Promise((r) => setTimeout(r, 150));
      w.setRide(null);
      /* THE TRACE IS KEPT, and it is kept because the first version of
         this test reported its diagnostics off the PROP GROUP — which
         is parented under `root` while he is aboard, so a failure read
         "position [0, -0.26, 0], terrain 14.46, slope 0 deg" about a
         machine three hundred metres away on a hillside. A diagnostic
         that describes the wrong object is worse than none. */
      const t0 = performance.now();
      const trace = [];
      while (performance.now() - t0 < 30000 && w.flightState.phase !== 'off') {
        await new Promise((r) => requestAnimationFrame(r));
        const s = w.flightState;
        if (!trace.length || performance.now() - t0 - trace[trace.length - 1].t > 2000) {
          trace.push({ t: Math.round(performance.now() - t0), ph: s.phase, alt: s.alt,
            vy: s.vy, ref: s.refusing, lw: s.landWanted, burn: s.burner, g: s.ground });
        }
      }
      WALLY.ctx.wind.setStrength(windWas);
      const p = WALLY.ctx.wally.rideProps.balloon;
      p.group.updateMatrixWorld(true);
      const res = [];
      for (const wh of p.wheels) {
        const v = new T3.Vector3(); wh.getWorldPosition(v);
        res.push(+(v.y - 0.02 - world.heightAt(v.x, v.z)).toFixed(4));
      }
      /* WORLD position, from the world matrix, whatever it is parented to */
      const wp = new T3.Vector3(); p.group.getWorldPosition(wp);
      return { found: true, deg: best.deg, pitchDeg: +(p.group.rotation.x * 180 / Math.PI).toFixed(2),
        rollDeg: +(p.group.rotation.z * 180 / Math.PI).toFixed(2), residuals: res,
        phase: w.flightState.phase, parked: w.rideState.parked.map((x) => x.id),
        at: [+wp.x.toFixed(1), +wp.y.toFixed(1), +wp.z.toFixed(1)],
        terrainThere: +world.heightAt(wp.x, wp.z).toFixed(2),
        slopeThere: +(Math.acos(Math.max(-1, Math.min(1, 1 - world.slopeAt(wp.x, wp.z)))) * 180 / Math.PI).toFixed(1),
        shore: +world.shoreDistAt(wp.x, wp.z).toFixed(0),
        wanted: [+best.x.toFixed(1), +best.z.toFixed(1)], trace };
    });
    ok(slope.found, 'a real hillside was found to land on', slope.deg + ' degrees');
    if (slope.found && ok(slope.parked.includes('balloon'), 'she is moored on it',
      slope.phase + ' at ' + JSON.stringify(slope.at) + ' · terrain ' + slope.terrainThere
      + ' · slope ' + slope.slopeThere + ' deg · shore ' + slope.shore + ' m · wanted '
      + JSON.stringify(slope.wanted) + ' · ' + JSON.stringify(slope.trace))) {
      ok(Math.abs(slope.pitchDeg) > 1.0,
        'the machine is PITCHED to the hill rather than stood upright on one height sample',
        slope.pitchDeg + ' deg pitch / ' + slope.rollDeg + ' deg roll on a ' + slope.slopeThere + ' deg slope');
      for (const r of slope.residuals) {
        ok(Math.abs(r) < 0.12, 'and each skid is on the ground, not in it or over it', r + ' m');
      }
      ok(!slope.residuals.some((r) => r < -0.001),
        'nothing is buried — the solve lifts rather than sinks', slope.residuals.join(', '));
    }

    /* ---------- B6b. IT SURVIVES A RELOAD ----------
       The one end-to-end the brief asks for by name, and the only
       place it can be answered: owning it and WHERE IT IS have to
       come back after the page is thrown away. Everything before this
       point is in memory. */
    T('across a reload');
    const beforeReload = await page.evaluate(() => {
      const g = WALLY.ctx.game, w = WALLY.ctx.wally;
      const found = g.actions.parkSpot('balloon');
      /* MOOR IT SOMEWHERE KNOWN. Whatever the tests above left behind
         is not this test's subject: this one is about persistence and
         restore, so it states the spot rather than inheriting one.
         parkProp's own write is asserted in the landing test. */
      if (!found) {
        const p = w.position;
        const x = p.x + 26, z = p.z + 12;
        g.actions.setParkSpot('balloon', { x, y: WALLY.ctx.world.heightAt(x, z), z, yaw: 0.8 });
      }
      g.state.rides.equipped = null;
      g.save();
      return { spot: g.actions.parkSpot('balloon'), owned: g.actions.ownsRide('balloon'),
        inherited: !!found, rides: JSON.parse(JSON.stringify(g.state.rides)) };
    });
    ok(beforeReload.owned, 'the machine is owned before the reload');
    ok(!!beforeReload.spot, 'and moored somewhere', JSON.stringify(beforeReload.rides));
    if (!beforeReload.spot) throw new Error('nothing to reload — see the line above');
    await page.reload({ waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.__WALLY_READY__ === true', null, { timeout: 120000 });
    /* THE RIG DOES NOT READ THE SAVE. game.js boots with
       `if (!ctx.flags.shot && game.hasSave()) game.load()`, so a
       ?shot=1 page starts fresh on purpose — a screenshot must not
       depend on whoever last played. Ask for the load explicitly, and
       then the restore has to cope with state that arrived AFTER
       boot, which is the case the one-shot version of restoreParked()
       could not (see its note in wally.js). */
    await page.evaluate(() => WALLY.ctx.game.load());
    /* the restore runs off bikeSync's half-second timer, so give it
       a few — bounded by the wall clock, not by a frame count */
    await page.waitForTimeout(2500);
    const afterReload = await page.evaluate(() => {
      const g = WALLY.ctx.game, w = WALLY.ctx.wally;
      const p = w.rideProps.balloon || null;
      return { owned: g.actions.ownsRide('balloon'), spot: g.actions.parkSpot('balloon'),
        built: !!p, parkedIds: w.rideState.parked.map((x) => x.id),
        at: p ? p.group.position.toArray().map((v) => +v.toFixed(2)) : null,
        inflation: p ? +p.inflation.toFixed(3) : null,
        yaw: p ? +p.group.rotation.y.toFixed(3) : null };
    });
    ok(afterReload.owned, 'he still owns it after a reload');
    ok(!!afterReload.spot, 'and the game still knows where it is');
    near(afterReload.spot.x, beforeReload.spot.x, 0.02, 'at the same x');
    near(afterReload.spot.z, beforeReload.spot.z, 0.02, 'and the same z');
    ok(afterReload.built, 'the prop was rebuilt for it');
    ok(afterReload.parkedIds.includes('balloon'), 'and stood back up as a parked machine');
    ok(afterReload.inflation < 0.05, 'still cold', afterReload.inflation);
    near(afterReload.at[0], beforeReload.spot.x, 0.5,
      'and the geometry is standing where it was left, not beside where he happens to be now',
      `${afterReload.at[0]} vs ${beforeReload.spot.x}`);
    near(afterReload.at[2], beforeReload.spot.z, 0.5, 'in z too');
    near(afterReload.yaw, beforeReload.spot.yaw, 0.02, 'facing the way it was left');

    /* ================================================================
       B9. THE SEAM — the boarding, both branches, and the dismount.

       WHAT IT MEASURES. The angle the LOOK DIRECTION moves in one
       frame, and two geometric facts the whip left behind: how close
       the aim point comes to the lens (when it walks through it the
       look is undefined and the frame whips) and whether the lens
       ever gets in FRONT of the subject along its own boom heading.
       All three come from the delivered camera, not from the rig's
       intentions.

       BOTH BRANCHES, AND THAT IS THE POINT. flyCamera()'s corrective
       damp only runs above 0.8 m/s of drift, so a boarding on a calm
       day never reaches it and the SEED alone decides where the
       camera spends the whole flight. The becalmed case is therefore
       the one that can only be passed by a correct seed; the drifting
       case is the one the drift could rescue. Asserted separately.

       THE REVERT CHECK. Put the negations back in wally.js —
       `flyCam.yaw = Math.atan2( -_fv2.x, -_fv2.z )` — and BOTH
       boardings go red on all three numbers: measured at load 27.32
       the becalmed worst frame was 1195 deg/s with pitch reaching
       -84.1, the aim passed 1.85 m from the lens and the lens spent
       part of the boarding 2.48 m on the wrong side of the subject.
       Take the target seed out (flyCam.sDist / sHigh / sAhead /
       sDown) and the frame after the hand-over goes to 3.2 deg;
       take the eased floor out and it goes to 2.7.
       ================================================================ */
    T('the seam');
    const TRACKER = `(() => { window.__S = [];
      const c = WALLY.ctx.camera; const dir = c.position.clone(); let ld = null, last = performance.now();
      const tick = () => {
        if (!window.__S) return;      // the run is over; do not push into null
        const n = performance.now(), dt = (n - last) / 1000; last = n;
        c.getWorldDirection(dir);
        let turn = 0;
        if (ld) { const dp = Math.min(1, Math.max(-1, ld.x*dir.x + ld.y*dir.y + ld.z*dir.z)); turn = Math.acos(dp) * 57.2958; }
        ld = { x: dir.x, y: dir.y, z: dir.z };
        let fi = null, fc = null;
        try { fi = WALLY.debug.balloonInfo(); fc = WALLY.debug.balloonCam(); } catch (e) {}
        window.__S.push({ dt, turn, rate: dt > 0.0005 ? turn / dt : 0,
          pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))) * 57.2958,
          aimD: fc ? fc.aimDist : 99, behind: fc ? fc.behind : 99, seeded: fc ? fc.seeded : false,
          mode: WALLY.ctx.cam.mode, ph: fi ? fi.phase : '' });
        if (window.__S.length < 2500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick); return 'on'; })()`;

    async function boarding(windStrength, stick, label) {
      await page.evaluate(() => { try { WALLY.debug.balloon(false); } catch (e) {} WALLY.ctx.game.actions.equipRide(null); });
      await page.waitForTimeout(1200);
      await page.evaluate((w) => WALLY.ctx.wind.setStrength(w), windStrength);
      await page.waitForTimeout(2500);
      const wind = await page.evaluate(() => { const v = WALLY.ctx.wind.vector(0, 0); return +Math.hypot(v.x, v.z).toFixed(3); });
      await page.evaluate(TRACKER);
      await page.waitForTimeout(500);
      await page.evaluate((sk) => {
        const g = WALLY.ctx.game; g.actions.grantRide('balloon'); g.actions.equipRide('balloon');
        if (sk) setTimeout(() => WALLY.debug.balloonStick(sk[0], sk[1]), 30);
      }, stick);
      await page.waitForTimeout(11000);
      const T2 = await page.evaluate(() => { const t = window.__S; window.__S = null; return t; });
      await page.evaluate(() => WALLY.debug.balloonStick(null));
      /* ONLY FRAMES THE RIG HAS ACTUALLY SEEDED. flyCam.pos and .aim
         are both the origin until the seed runs, so an unseeded frame
         reports an aim distance of zero and would fail the closest-
         approach assertion for a reason that has nothing to do with
         the camera. */
      const f = T2.filter((r) => r.dt > 0.004 && r.dt < 0.30 && r.ph && r.seeded);
      return {
        n: f.length, wind,
        worst: Math.max(...f.map((r) => r.rate)),
        pitch: f.reduce((m, r) => (Math.abs(r.pitch) > Math.abs(m) ? r.pitch : m), 0),
        minAim: Math.min(...f.map((r) => r.aimD)),
        minBehind: Math.min(...f.map((r) => r.behind)),
        label,
      };
    }

    for (const [w, stick, label] of [[0.0, null, 'BECALMED'], [0.85, [0, 1], 'DRIFTING']]) {
      const r = await boarding(w, stick, label);
      ok(r.n > 200, `${label}: the boarding was actually flown`, `${r.n} frames, |wind| ${r.wind}`);
      ok(r.worst < 260,
        `${label}: no frame whips — the worst single-frame look change stays under 260 deg/s`,
        `${r.worst.toFixed(1)} deg/s`);
      ok(Math.abs(r.pitch) < 45,
        `${label}: and the lens never points at the ground`, `${r.pitch.toFixed(1)} deg`);
      ok(r.minAim > 6,
        `${label}: the aim point never comes near the lens — a look direction that is about to be undefined is what a whip IS`,
        `closest ${r.minAim.toFixed(2)} m`);
      ok(r.minBehind > -0.05,
        `${label}: and the lens never gets in FRONT of the subject, which is the seed's own signature`,
        `${r.minBehind.toFixed(3)} m behind at its worst`);
    }

    /* --- and the other end of it ---
       PINNED, AND THIS ONE COST A WHOLE ASSERTION. It used to fly the
       stick for seven seconds from wherever the DRIFTING boarding
       above had left her and then dismount. On the runs where that
       carried her out over the water, the refusal correctly held the
       machine up, the landing never completed, the lens was therefore
       never handed back, and `k` came home -1 — the suite reporting a
       CAMERA fault about a balloon that was obeying its own rule
       perfectly. A test that cannot tell "the seam is broken" from
       "there was nothing to land on" is not measuring the seam.

       So it is still flown for real — seven seconds of stick in the
       wind the DRIFTING boarding left, so flyCamera's corrective damp
       has been running — and then she is put over the site B6 chose
       before he steps out. The hand-back does not care where the
       ground is; it just cannot happen without one. The precondition
       is asserted rather than assumed, so if this ever fails again the
       failure says which half went wrong. */
    {
      await page.evaluate(() => { WALLY.debug.balloon({ alt: 40 }); WALLY.debug.balloonStick(0.5, 0.5); });
      await page.waitForTimeout(7000);
      const pre = await page.evaluate((S) => {
        WALLY.debug.balloonStick(0, 0);
        const windWas = WALLY.ctx.wind.uniforms.uWindStrength.value;
        WALLY.ctx.wind.setStrength(0);
        WALLY.debug.balloon({ alt: 20, at: [S.x, S.y + 2, S.z] });
        return { windWas, shore: Math.round(WALLY.ctx.world.shoreDistAt(S.x, S.z)),
          water: WALLY.ctx.world.isWater(S.x, S.z) };
      }, site);
      ok(!pre.water && pre.shore >= site.radius + 160,
        'the dismount is over land, and far enough from it that the water refusal cannot be what this measures',
        `${pre.shore} m from the shore, against the clearing rule's own ${site.radius} + 160`);
      await page.evaluate(TRACKER);
      await page.waitForTimeout(400);
      const rel = await page.evaluate(() => {
        const s = WALLY.debug.balloonInfo();
        WALLY.debug.balloonStick(null);
        WALLY.ctx.game.actions.equipRide(null);
        return { refusing: s.refusing, floored: s.floored, alt: s.alt, phase: s.phase };
      });
      ok(!rel.refusing && !rel.floored,
        'and she was refusing nothing at the moment he stepped out — so a landing is actually possible from here',
        `${rel.phase} at ${rel.alt} m`);
      /* WAIT ON THE FACT, NOT ON A STOPWATCH. The flat 38 s this used
         to sleep for was both too long for a landing that works and too
         short to be sure about one that does not. */
      const done = await page.waitForFunction("WALLY.debug.balloonInfo().phase === 'off'", null, { timeout: 60000 })
        .then(() => true).catch(() => false);
      await page.waitForTimeout(700);         // a few follow frames after the hand-back
      await page.evaluate((v) => WALLY.ctx.wind.setStrength(v), pre.windWas);
      const T3 = await page.evaluate(() => { const t = window.__S; window.__S = null; return t; });
      ok(done, 'the landing completed rather than hanging aloft — she had somewhere to come down',
        `${T3.length} frames tracked`);
      const f = T3.filter((r) => r.dt > 0.004 && r.dt < 0.30);
      const k = f.findIndex((r) => r.mode !== 'override');
      ok(k > 5, 'the dismount handed the lens back to the follow rig', `at frame ${k} of ${f.length}`);
      if (k > 0) {
        const join = f[k];
        ok(join.turn < 1.6,
          'and the hand-back is not a step: the first follow frame moves the look under 1.6 deg',
          `${join.turn.toFixed(3)} deg (${join.rate.toFixed(1)} deg/s)`);
        /* THE COUNTER-CASE. The frames either side have to be quiet
           too, or "the join is small" is only true because everything
           was small. */
        ok(f[k - 1].turn < 0.5, 'the frame before it was quiet', f[k - 1].turn.toFixed(3));
      }
    }

    /* ================================================================
       B10. THE BURNER LIGHTS SOMETHING.
       Two claims, and they are different kinds of claim: the envelope's
       own emissive is a number, and the light on everything else is a
       difference between two rendered frames.
       REVERT CHECK: put balloon.js's envelope constant back to
       `glow * 0.085` and the first goes red at 0.09; take the
       ctx.mat.setLocalLight() call out and the second goes red,
       because nothing outside the machine changes at all.
       ================================================================ */
    T('the burner');
    const burn = await page.evaluate(async () => {
      WALLY.debug.setHour(22);
      WALLY.debug.balloon({ alt: 3.0 });
      await new Promise((r) => setTimeout(r, 900));
      const w = WALLY.ctx.wally.position.clone();
      const AT = [w.x, w.y, w.z];
      const pin = () => WALLY.debug.balloon({ at: AT });
      const read = () => {
        let env = null, th = null;
        WALLY.ctx.scene.traverse((o) => { if (o.name === 'balloon.envelope' && !o.userData.isOutlineHull) env = o;
          if (o.name === 'balloon.throat') th = o; });
        const g = WALLY.ctx.mat.globals;
        return { env: env?.material?.uniforms?.uEmissive?.value ?? null,
          inGlow: !!env?.material?.uniforms?.uGlowFade,
          throat: th?.material?.uniforms?.uEmissive?.value ?? null,
          light: g.uLocalCol ? g.uLocalCol.value.r + g.uLocalCol.value.g + g.uLocalCol.value.b : null,
          range: g.uLocalRange ? g.uLocalRange.value : null,
          sunI: g.uSunIntensity.value };
      };
      WALLY.debug.balloonBurn(false);
      for (let i = 0; i < 70; i++) { pin(); await new Promise((r) => requestAnimationFrame(r)); }
      const off = read();
      WALLY.debug.balloonBurn(true);
      for (let i = 0; i < 70; i++) { pin(); await new Promise((r) => requestAnimationFrame(r)); }
      const on = read();
      /* and by day, where it must NOT take over the frame */
      WALLY.debug.setHour(13);
      for (let i = 0; i < 70; i++) { pin(); await new Promise((r) => requestAnimationFrame(r)); }
      const day = read();
      WALLY.debug.balloonBurn(false);
      for (let i = 0; i < 40; i++) { pin(); await new Promise((r) => requestAnimationFrame(r)); }
      const out = read();
      return { off, on, day, out };
    });
    ok(burn.on.inGlow,
      'the envelope is compiled with the interior-glow gradient, so the light falls off from the throat rather than painting the whole bag');
    ok(burn.on.env > 0.6,
      'at night, at full burn, the envelope really is lit from inside — not the 0.09 it used to be',
      `uEmissive ${burn.on.env.toFixed(3)}`);
    ok(burn.off.env < burn.on.env * 0.15,
      'and with the burner out only the heat already in the bag is still glowing — an eighth of it, not a lamp',
      `${burn.off.env.toFixed(3)} against ${burn.on.env.toFixed(3)}`);
    ok(burn.on.throat > 1.7,
      'the throat crosses postfx\'s bloom threshold, so the mouth flares',
      burn.on.throat.toFixed(3));
    ok(burn.on.light > 0.5, 'and there is a real light at the burner', burn.on.light.toFixed(3));
    ok(burn.on.range > 8 && burn.on.range < 40,
      'with a reach that gets to the basket and the ground and no further', burn.on.range);
    ok(burn.out.light === 0,
      'the light goes out with the burner — a global uniform left lit would light the whole world for ever');
    ok(burn.day.env < burn.on.env * 0.55,
      'and by daylight it is a blush rather than a lantern, so a lit envelope cannot flatten the two-band ramp',
      `noon ${burn.day.env.toFixed(3)} vs night ${burn.on.env.toFixed(3)}, sun ${burn.day.sunI.toFixed(2)} vs ${burn.on.sunI.toFixed(2)}`);

    /* ================================================================
       B11. THE INK AND THE SEA AT ALTITUDE.
       Both are the same fact seen twice: the flight opens the haze, and
       two things that were tuned against the closed haze have to open
       with it. Both are asserted AT BOTH ALTITUDES, because a number
       that is only ever read at 200 m will agree with itself.
       REVERT CHECK: take the hazeK multiplier out of toon.js's
       cullHulls and the drawn count at 200 m goes back to 89 of 517;
       take flySea() out of wally.js's lateUpdate and uWaveFade at
       altitude is the authored 520/1400 again.
       ================================================================ */
    T('the frame at altitude');
    const alt = await page.evaluate(async () => {
      const snap = () => ({
        out: WALLY.ctx.mat.setOutline({}),
        fade: WALLY.ctx.water.uniforms.uWaveFade.value.map((v) => [+v.x.toFixed(1), +v.y.toFixed(1)]),
        fog: WALLY.ctx.scene.fog ? [Math.round(WALLY.ctx.scene.fog.near), Math.round(WALLY.ctx.scene.fog.far)] : null,
        camY: +WALLY.ctx.camera.position.y.toFixed(1),
      });
      WALLY.debug.balloon(false);
      WALLY.ctx.game.actions.equipRide(null);
      for (let i = 0; i < 120; i++) await new Promise((r) => requestAnimationFrame(r));
      const ground = snap();
      WALLY.ctx.game.actions.equipRide('balloon');
      /* WAIT FOR THE ENVELOPE TO BE UP. flyUpdate holds the machine on
         its skids for the whole inflation (`canLift`), so an altitude
         written during the boarding is put back on the grass on the
         very next frame and the rest of this measures a balloon in a
         field. Bounded by frames, not by a promise that only a rAF can
         resolve. */
      for (let i = 0; i < 900 && WALLY.debug.balloonInfo().phase !== 'aloft'; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      WALLY.debug.balloon({ alt: 200 });
      WALLY.debug.balloonStick(0, 0);
      const w = WALLY.ctx.wally.position.clone();
      const AT = [w.x, w.y, w.z];
      for (let i = 0; i < 150; i++) { WALLY.debug.balloon({ at: AT }); await new Promise((r) => requestAnimationFrame(r)); }
      const air = snap();
      return { ground, air };
    });
    near(alt.ground.out.hazeK, 1, 1e-6,
      'on the ground the haze multiplier is exactly one, so every outline number in toon.js is the number it was',
      `cullFar ${alt.ground.out.cullFarNow} m`);
    near(alt.ground.out.cullFarNow, 185, 0.01, 'and the cull is 185 m to the metre');
    ok(alt.air.out.hazeK > 3,
      'at 200 m the fog has been opened several times over', `${alt.air.out.hazeK}x, fog ${JSON.stringify(alt.air.fog)}`);
    ok(alt.air.out.cullFarNow > 600, 'so the ink reaches the far side of the island', `${alt.air.out.cullFarNow} m`);
    ok(alt.air.out.hullsDrawn > alt.air.out.hulls * 0.7,
      'and most of the island is inked from the air instead of a seventh of it',
      `${alt.air.out.hullsDrawn} of ${alt.air.out.hulls} hulls`);
    /* the counter-case for the budget: minPx still throws away the
       things that are too small to carry a stroke */
    ok(alt.air.out.hullsDrawn < alt.air.out.hulls,
      'the screen-size budget is still doing its job — this is not "draw everything"',
      `${alt.air.out.hulls - alt.air.out.hullsDrawn} still culled`);
    near(alt.ground.fade[0][0], 520, 0.5,
      'on the ground the ocean carries the wave fades water.js authored', JSON.stringify(alt.ground.fade[0]));
    ok(alt.air.fade[0][0] < 200,
      'and from 200 m they are pulled in, so the swell is not asked of geometry that cannot carry it',
      `${JSON.stringify(alt.air.fade[0])} against 520/1400`);
    ok(alt.air.camY > 150, 'measured with the lens actually up there', alt.air.camY);

    /* ================================================================
       B12. WHAT THE BASKET IS STANDING ON.
       A rigid basket rests on the highest thing under its footprint,
       and a single centre ray cannot know what that is. Asserted at a
       roof edge in 0.4 m steps, WITH the counter-case: past the
       footprint's own reach the two answers must agree again, or this
       is measuring an unconditional "always says roof".
       REVERT CHECK: drop flyFootprint() from flyUpdate and every
       offset outside the edge answers with the terrace 15 m down.
       ================================================================ */
    T('the footprint');
    const edge = await page.evaluate(async () => {
      let best = null;
      for (const b of WALLY.debug.cityList()) {
        const rec = WALLY.ctx.city.buildingAt(b.id); if (!rec) continue;
        const p = rec.center;
        const g = WALLY.ctx.phys.groundAt(p.x, p.z);
        const terr = WALLY.ctx.world.heightAt(p.x, p.z);
        if (g.normal.y < 0.9 || g.y - terr < 8) continue;
        if (!best || g.y - terr > best.above) best = { id: b.id, x: p.x, z: p.z, y: +g.y.toFixed(2), above: +(g.y - terr).toFixed(2) };
      }
      if (!best) return null;
      WALLY.ctx.game.actions.equipRide('balloon');
      const rows = [];
      for (let d = 0; d <= 16; d += 0.8) {
        WALLY.debug.balloonStick(0, 0);
        WALLY.debug.balloon({ at: [best.x + d, best.y + 2.2, best.z] });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const info = WALLY.debug.balloonInfo();
        const centre = WALLY.ctx.phys.groundAt(best.x + d, best.z);
        rows.push({ d: +d.toFixed(1), foot: info.ground, centre: +centre.y.toFixed(2) });
      }
      WALLY.debug.balloonStick(null);
      return { best, rows };
    });
    ok(!!edge, 'there is a flat roof at least eight metres over its own ground to test on', edge && JSON.stringify(edge.best));
    if (edge) {
      const R = edge.best.y;
      const onRoof = (v) => Math.abs(v - R) < 0.6;
      const gained = edge.rows.filter((r) => onRoof(r.foot) && !onRoof(r.centre));
      const agree = edge.rows.filter((r) => !onRoof(r.foot) && !onRoof(r.centre));
      ok(gained.length > 0,
        'over the parapet the footprint finds the roof where the centre ray finds a thirty-metre drop',
        `${gained.length} offsets: ${gained.map((r) => r.d + ' m').join(', ')}`);
      ok(agree.length > 0,
        'AND past the basket\'s own width the two agree again — the footprint is not simply answering "roof"',
        `${agree.length} offsets clear of the building`);
      ok(edge.rows.every((r) => r.foot >= r.centre - 0.01),
        'the footprint is never LOWER than the centre ray: a basket cannot rest below the thing under its middle');
    }

    /* ---------- B7. the cost, differenced across real frames ---------- */
    T('what it costs');
    /* IN A SETTLED SCENE. The difference is between two frames that
       are meant to be alike in everything but the prop, so it has to
       be taken somewhere the rest of the frame is not still changing:
       measured straight after a page reload, with grass and NPCs still
       streaming in behind it, the delta came back NEGATIVE. Aloft over
       open country, with three seconds to settle, the frame either
       side of the toggle is the same frame. */
    const cost = await page.evaluate(async () => {
      WALLY.debug.balloon({ alt: 170 });
      await new Promise((r) => setTimeout(r, 3000));
      return WALLY.debug.balloonCost(40);
    });
    ok(cost.frames >= 30, 'the cost was measured over real frames', cost.frames);
    ok(cost.balloon.calls > 0, 'the machine costs draw calls', cost.balloon.calls);
    ok(cost.balloon.calls < 70,
      'and fewer than a parked bicycle does (106, measured in wally.js) despite being ten metres tall',
      cost.balloon.calls + ' calls, ' + cost.balloon.tris + ' triangles a frame');

    /* ---------- B8. nothing threw ---------- */
    T('the console');
    const real = errs.filter((e) => !/favicon|Download the React/i.test(e));
    ok(real.length === 0, 'the whole run produced no page errors', real.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
}

/* ---------------- report ----------------
   THE LOAD IS PART OF THE RECORD. Half of this suite is wall-clock
   bounded and the other half boots a city twice; a green run at load
   1 and a green run at load 12 are different claims, and a suite that
   does not say which one it made cannot be held to either. */
const LOAD = loadavg().map((v) => v.toFixed(2)).join(' / ');
if (fails.length) {
  console.log(`\nFAIL — ${fails.length} of ${pass + fails.length} assertions red   (load ${LOAD}):\n`);
  for (const f of fails) console.log('  ' + f);
  process.exit(1);
}
console.log(`PASS — ${pass} assertions green.   load ${LOAD}`);
console.log(`  The Assessor · $${RIDES.balloon.price} · rep ${RIDES.balloon.unlock.rep} · `
  + `${RIDES.balloon.unlock.assets}/${CONFIG.totalAssets} assets · at the ${LOC_BY_ID.treasury.n}`);
console.log(`  climb ${FLIGHT.vMaxUp} m/s · sink ${FLIGHT.vMaxDown} m/s · drift ${FLIGHT.reach} m/s `
  + `· tau ${(1 / FLIGHT.hLag).toFixed(1)} s · ${FIT.TOP} m tall`);
