/* ============================================================
   arrival.js — WHAT HE ARRIVES ON, and how the shot is staged for it.

   The opener used to be written around one machine. It built its own
   bicycle, drove it down a 24.5 m road at 3.3 m/s, and deleted it
   afterwards because a free bicycle standing next to a shop selling
   the same bicycle for $180 reads as a bug. All three of those
   decisions were correct FOR A PLAYER WHO HAS NOTHING. None of them
   is correct for a returning player who bought a Thunderhead.

   ------------------------------------------------------------------
   WHAT RIDES ACTUALLY EXIST — and there is no "advanced bicycle"
   ------------------------------------------------------------------
   data.js RIDES has exactly four rows, and this file will not invent
   a fifth to satisfy a list:

     bike        Second-hand Bicycle   speed 1     $180, rep 0
     scooter     Barnaby's Scooter     speed 1.5   quest q_side_scooter
     motorcycle  Thunderhead 900       speed 3     $3,300, rep 50
     balloon     The Happy Skies       speed 2.2   $24,000, rep 75, 40 assets

   The rung between the bicycle and the motorcycle is the SCOOTER. It
   is not for sale at any price — Barnaby signs it over — so a player
   who has "the bike after the bike" has a scooter, and that is what
   an "advanced bike" is in this game. There is no upgraded bicycle,
   no second bicycle, and no bicycle variant. Four machines, four
   silhouettes (rides.js: a comb, a slab, a barbell, and a balloon).

   ------------------------------------------------------------------
   WHICH ONE HE ARRIVES ON
   ------------------------------------------------------------------
   `state.rides.equipped` is the machine he was last actually ON, and
   it is the answer whenever there is one: a player who parked the
   bicycle and took the scooter to the café should arrive on the
   scooter. Failing that, the fastest machine he owns — RIDE_ORDER's
   head, which is what the game's own `bestRide()` means by "your
   best ride". Failing THAT he owns nothing, and the answer is the
   old one: a bicycle that is not his.

   The three cases are separate on purpose. `owned` is not cosmetic;
   it decides whether the machine is still standing there when the
   player takes control. See THE MACHINE STAYS in intro.js.

   ------------------------------------------------------------------
   ONE PROP CONTRACT, FOUR MACHINES
   ------------------------------------------------------------------
   bike.js, rides.js and balloon.js all publish the same surface —
   `group`, `wheels`, `roll(metres)`, `setCrankPhase(rad)`,
   `park(on, roll)`, `parkLean`, `standFoot`, `SADDLE`, `dispose()` —
   and their origins are all on the ground, forward +Z. That is not
   luck: rides.js and balloon.js each say in their headers that they
   keep the bicycle's contract so the caller has one path. So the
   intro has one path, and `createArrivalProp` is the bicycle wrapper
   that was in shots.js with the machine as an argument.
   ============================================================ */

import { createBike } from '../character/bike.js';
import { createScooter, createMotorcycle } from '../character/rides.js';
import { createBalloon, FIT as BALLOON_FIT } from '../character/balloon.js';

const BUILD = {
  bike: createBike,
  scooter: createScooter,
  motorcycle: createMotorcycle,
  balloon: createBalloon,
};

/* ------------------------------------------------------------------
   THE STAGING, PER MACHINE.

   `dist` is how much road he covers between rolling into shot and
   stopping, and it is NOT the machine's cruise speed times the ride's
   duration. At the motorcycle's own ladder rung (anim.js MOTO_STEPS,
   8.00 m/s) that arithmetic gives 54 m, and 54 m of straight clear
   corridor is not something chooseStage can promise inside a city —
   its road probe would be scoring a line through two buildings on
   every bearing, so every bearing would score badly and the picker
   would be choosing between equally bad frames. These are what the
   stage search can actually find, and the ride reads as ARRIVING
   rather than racing, which is what a man pulling up at his own door
   is doing anyway.

   `aimY` is where SEQ C's cameras look, in metres over the road: the
   rider's chest. It drops with the machine because the rider does —
   anim.js folds him down over a motorcycle's tank and stands him up
   on a scooter's floor, and a lens aiming at a bicycle's chest height
   from 40 m puts a motorcyclist's head in the top third of frame.

   `clip` is the ride posture, on the ACTION layer. The three ground
   machines each have one; the balloon has none, and does not need
   one, because wally.js's own flight code stands him in the basket on
   plain `idle` (its words: "HE IS STANDING, NOT SEATED"). That single
   fact is why the balloon hand-over is arm-continuous for free.
   ------------------------------------------------------------------ */
export const ARRIVAL = Object.freeze({
  bike: Object.freeze({
    id: 'bike', clip: 'ride-bicycle', air: false,
    dist: 24.5, aimY: 1.15, park: [1.45, 1.55], parkYaw: 1.05,
  }),
  scooter: Object.freeze({
    id: 'scooter', clip: 'ride-scooter', air: false,
    dist: 30.0, aimY: 1.10, park: [1.55, 1.70], parkYaw: 1.05,
  }),
  motorcycle: Object.freeze({
    id: 'motorcycle', clip: 'ride-moto', air: false,
    dist: 38.0, aimY: 0.98, park: [1.70, 1.90], parkYaw: 1.02,
  }),
  /* THE BALLOON DOES NOT USE THE ROAD AT ALL. `dist` is still read by
     chooseStage's corridor probe, and a balloon needs no corridor —
     but it DOES need somewhere to put five metres of cold envelope,
     so the number is the mooring clearance rather than a road. */
  balloon: Object.freeze({
    id: 'balloon', clip: null, air: true,
    dist: 8.0, aimY: 1.15,
    /* 6.4 / 5.6, AND THE NUMBER WAS READ OFF THE FRAME. At the
       bicycle's 1.45 / 1.55 the moored Happy Skies is 3.6 m from him
       and about 10 m from the hero lens; balloon.js measures her at 3.2 m
       across and just under 4 tall, so she subtended nearly thirty
       degrees of a thirty-two degree lens and the envelope crossed the
       title lockup's own band. At 8.5 m from him she reads as a
       moored balloon parked over there rather than as a wall behind
       his head, and the top of the envelope sits clear under the logo
       — shots/ih-balloon-34p4.png. */
    park: [6.40, 5.60], parkYaw: 0.62,
    /* THE DESCENT. `top` is metres over the mooring when SEQ C opens
       and `sink` is the rate she flies it at.

       20 m AND 3.4 m/s, NOT 28 AND 4.5, and the reason is the frame
       rather than the physics. At 28 m the whole machine — 10 m of
       envelope over the basket — is 38 m of subject, and no camera
       that fits it also has the island in shot: the opening frame came
       back as a balloon on an empty blue sky, no coast, no horizon and
       no city, which ART_DIRECTION 6 rules out by name. 20 m puts the
       crown 30 m up, and a lens 36 m out at head height holds the
       envelope in the top half and the city and the horizon across the
       bottom — shots/ih-balloon-20p4.png. 3.4 m/s is
       still inside balloon.js FLIGHT's own 3.3-4.5 m/s descent band
       and it keeps the flare — solved, not dialled — at 2.97 s. */
    top: 20.0, sink: 3.4,
    deck: BALLOON_FIT.DECK,
  }),
});

/**
 * Which machine the opener stages, read off the save.
 *
 * @returns {{id: string, owned: boolean, why: string}}
 */
export function pickArrival(ctx) {
  const none = { id: 'bike', owned: false, why: 'no ride owned' };
  const acts = ctx?.game?.actions;
  if (!acts?.rides) return { ...none, why: 'no game module' };
  let rows = null;
  try { rows = acts.rides(); } catch (e) { return { ...none, why: 'rides() threw' }; }
  if (!Array.isArray(rows) || !rows.length) return none;

  /* `rides()` is RIDE_ORDER — fastest first — so the first owned row
     IS bestRide(). `equipped` is the one he was last on. */
  const equipped = rows.find((r) => r.owned && r.equipped);
  const best = rows.find((r) => r.owned);
  const row = equipped || best;
  if (!row || !ARRIVAL[row.id]) return none;
  return {
    id: row.id,
    owned: true,
    why: equipped ? 'equipped' : 'best owned',
  };
}

/**
 * The arrival machine, in the intro's own idiom.
 *
 * WHAT THIS WRAPPER ADDS, and it is the same short list it added when
 * it was `createBicycle` in shots.js: `park()` here takes a WORLD
 * placement, because the intro's machine is a scene prop rather than a
 * child of Wally's root, where the prop's own park() only knows about
 * the stand and the lean.
 */
export function createArrivalProp(ctx, id = 'bike') {
  const key = BUILD[id] ? id : 'bike';
  const prop = BUILD[key](ctx);
  prop.group.name = `intro.${key}`;

  const api = {
    id: key,
    group: prop.group,
    prop,
    /** Where the rider's pelvis has to land. Read off the prop rather
        than copied — that constant getting out of step with the frame
        is exactly how the feet left the pedals. */
    SADDLE: prop.SADDLE,
    PEDAL: prop.PEDAL,
    R: prop.R,

    /** Axle to axle (skid to skid on the balloon), off the prop. */
    wheelbase: prop.wheels && prop.wheels.length > 1
      ? Math.abs(prop.wheels[0].position.z - prop.wheels[1].position.z) : 0,

    roll(metres) { return prop.roll(metres); },
    get parkLean() { return prop.parkLean; },
    get standFoot() { return prop.standFoot || null; },
    setCrankPhase(ph) { prop.setCrankPhase(ph); },
    /** Balloon only; a no-op elsewhere so the driver has one path. */
    setInflate(t) { if (prop.setInflate) prop.setInflate(t); },
    setBurner(on, heat, dt) { if (prop.setBurner) prop.setBurner(on, heat, dt); },

    /** Take it off the stand — it is being RIDDEN again. */
    unpark() {
      prop.park(false);
      prop.group.rotation.order = 'XYZ';
      prop.group.rotation.set(0, 0, 0);
      if (prop.setInflate && key === 'balloon') prop.setInflate(1);
    },

    /**
     * Lean it on its stand at a world placement.
     *
     * ROTATION ORDER IS LOAD-BEARING — 'YXZ' gives Ry*Rx*Rz: yaw in the
     * world, pitch about the machine's own lateral axis, then park()'s
     * lean on z, innermost, about its own forward axis. See wally.js
     * parkProp() and the measured before/after there.
     */
    park(x, y, z, yaw, pitch = 0, roll) {
      prop.group.position.set(x, y, z);
      prop.group.rotation.order = 'YXZ';
      prop.group.rotation.set(Number.isFinite(pitch) ? pitch : 0, yaw, 0);
      prop.park(true, roll);
    },

    dispose() { prop.dispose(); },
  };
  return api;
}

export default { ARRIVAL, pickArrival, createArrivalProp };
