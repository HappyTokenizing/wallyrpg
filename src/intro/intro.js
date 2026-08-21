/* ============================================================
   intro.js — ctx.intro. The first thirty seconds.

   The original 2D game booted like an arcade cabinet: CRT sweep, POST
   text, a memory count, then a logo slam over PRESS START. What is
   worth keeping from that is not the CRT — it is the *shape*: a long
   patient build, one hard hit, and a skip chip in the corner the
   whole time. This is that shape, cut for a 3D game, and the thing it
   shows off is the island rather than a fake monitor.

     0.000  SEQ A   the sea at dawn, low to the water, gulls, drifting
    11.111  SEQ B   crane up and back — the island, whole
    20.000  SEQ C   drop into the city and find him on the bicycle
    26.667  SEQ D   he stops; push in
    31.111          TITLE — on bar 7, on the sting
    34.667          release to the player

   Four ctx.cam.cinematic() calls, so three hard cuts, all on bar
   lines of the 54 bpm `cinematic` score. See shots.js for why each
   camera sits where it does.

   ------------------------------------------------------------------
   THINGS THIS FILE IS CAREFUL ABOUT
   ------------------------------------------------------------------
   * It does not run when ctx.flags.shot or ctx.flags.skipIntro is
     set. The screenshot harness always sets `?shot=1`, and every
     other agent's reference shot depends on that staying true. The
     debug hooks below still work, because they are explicit.
   * The cinematic delivers Wally to the position he was spawned at.
     Nothing teleports at the hand-over — the last frame of the intro
     and the first frame of gameplay are the same pose in the same
     place, which is the only way a skippable opener can "land cleanly
     in gameplay".
   * Skipping is a 0.22 s dip to black, then the restore, then a
     0.55 s lift back out. Cutting straight from a 292 m aerial to a
     4.2 m follow boom is a lurch; a dip is what an editor would do.
   * scene.fog is 60/420 by default and the aerials need ~2600 m of
     visibility. This module is boot stage 13, so its update() runs
     after sky.update() and its fog write is the one that survives to
     the render. It stops writing at the end and sky restores its own
     values on the very next frame — nothing is left mutated.
   * prefers-reduced-motion gets no flight at all: one held frame, the
     title, and out.
   ============================================================ */

import { clamp, damp } from '../core/contracts.js';
import { createTitleCard } from './titlecard.js';
import {
  storyboard, chooseStage, MARKS, TIMING, RIDE, ridePath, rideSpeed,
  createGulls, createBicycle,
} from './shots.js';

const SADDLE_Y = 0.92;                 // top of the bicycle saddle, metres
const CRANK_TURNS_PER_M = 1 / 2.2;     // one crank revolution per 2.2 m

/* The opener is a sunrise: 06:03 on the water, 07:21 by the title.
   A debug seek has to jump the sky as well as the clock, or every
   reference shot of the hero and the title card comes back lit for
   the wrong hour. */
const HOUR0 = 6.05, HOUR1 = 7.35;

export async function init(ctx) {
  const T = ctx.THREE;

  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- state ---------------- */
  let card = null;
  let board = null;
  let gulls = null;
  let bike = null;

  let armed = false;            // props built, world state saved
  let running = false;
  let finished = false;
  let clock = 0;
  let beat = -1;                // index into BEATS
  let outro = null;             // { phase, t, reason }
  let fogNear = 60, fogFar = 420;
  let fogTarget = [60, 420];
  let hipsLocal = 0.66;         // his hip height above his soles, live

  const saved = {};
  let stage = null;
  const anchor = new T.Vector3();
  const _v = new T.Vector3();

  const BEATS = ['sea', 'island', 'arrival', 'hero'];
  const hourAt = (t) => HOUR0 + (HOUR1 - HOUR0) * clamp(t / TIMING.end, 0, 1);

  /* ================================================================
     Setup of the world state the cinematic borrows
     ================================================================ */
  function arm() {
    if (armed) return true;
    if (!ctx.cam?.cinematic) return false;
    armed = true;

    card = card || createTitleCard(ctx);

    /* Where he is standing right now is where the cinematic WANTS to
       end. chooseStage only moves him if the city has boxed his spawn
       in — see the note in shots.js — and reports how far it went. */
    if (ctx.wally) anchor.copy(ctx.wally.position);
    else anchor.set(0, 0, 0);
    anchor.y = ctx.world?.heightAt?.(anchor.x, anchor.z) ?? anchor.y;
    stage = chooseStage(ctx, anchor);
    anchor.copy(stage.anchor);

    saved.timeScale = ctx.sky?.timeScale ?? 0;
    saved.grade = typeof ctx.sky?.grade === 'string' ? ctx.sky.grade : 'day';
    saved.yaw = ctx.wally?.rotation?.y ?? 0;

    board = storyboard(anchor, ctx.world?.heightAt, stage.yaw);

    /* Dawn, and the sun keeps rising through the whole opener: 06:03
       on the water, 07:21 by the title. The score, the grade, the
       shadow length and the sea colour all move with it, which is
       most of why four cut sequences do not feel like four unrelated
       postcards. */
    ctx.sky?.setHour?.(HOUR0);
    ctx.sky?.setTimeScale?.((HOUR1 - HOUR0) / TIMING.end);

    gulls = createGulls(ctx, {
      from: board.sea.shots[0].position,
      toward: board.sea.shots[0].target,
    });
    ctx.scene.add(gulls.group);

    bike = createBicycle(ctx);
    bike.group.visible = false;
    ctx.scene.add(bike.group);

    ctx.wally?.setControlled?.(false);
    card.chrome(false);
    return true;
  }

  /* ================================================================
     Cues — one-shot beats, replayed in order when seeking
     ================================================================ */
  function startRide() {
    if (!ctx.wally) return;
    bike.group.visible = true;
    ctx.wally.play('ride-bicycle', { loop: true, fade: 0.28, speed: 1.6 });
  }

  /* The C -> D cut. He is pedalling on one side of it and standing in
     the reference 'cool' pose on the other, which is how a film gets
     a character off a bicycle without an animation for it. */
  function dismount() {
    const g = board.groundY(0, 0);
    if (ctx.wally) {
      ctx.wally.root.position.set(anchor.x, g, anchor.z);
      ctx.wally.root.rotation.y = board.yaw;
      ctx.wally.pose('cool', { fade: 0.001, instant: true });
    }
    /* Parked behind his left shoulder: out of the lens' path to his
       face, still legible as the thing he arrived on. */
    const px = anchor.x - board.f.x * 1.45 - board.r.x * 1.55;
    const pz = anchor.z - board.f.z * 1.45 - board.r.z * 1.55;
    bike.group.visible = true;
    bike.park(px, board.groundY(px - anchor.x, pz - anchor.z), pz, board.yaw + 1.05);
  }

  function landTitle() {
    card.show();
    card.hint(false);
    ctx.audio?.sting?.('title');
    ctx.bus?.emit('intro:titlecard', { t: clock });
  }

  function poseWelcome() {
    ctx.wally?.pose?.('welcome', { fade: 0.55 });
  }

  const CUES = [
    { t: 1.60, f: () => card.hint(true) },
    { t: RIDE.t0, f: startRide },
    { t: TIMING.hero, f: dismount },
    { t: TIMING.title, f: landTitle },
    { t: TIMING.title + 0.55, f: poseWelcome },
    /* A debug seek holds on its mark instead of handing over: a
       screenshot taken 2.5 s after introShot(7) must still be the
       title, not the follow camera. */
    { t: TIMING.end, f: () => { if (!seeked) finish('end'); } },
  ];
  let cueAt = 0;
  let seeked = false;

  /* ================================================================
     Sequence changes — the cuts
     ================================================================ */
  function playSeq(i, fromShot = 0) {
    beat = i;
    const seq = board[BEATS[i]];
    fogTarget = seq.fog;
    if (fromShot > 0) { fogNear = fogTarget[0]; fogFar = fogTarget[1]; }
    ctx.cam.cinematic(seq.shots.slice(fromShot), { ...seq.opts, grade: seq.grade });
    ctx.bus?.emit('intro:shot', { seq: seq.name, index: i, t: clock });
  }

  /* ================================================================
     Per-frame character + prop driving
     ================================================================ */
  function driveCharacter(dt) {
    if (!ctx.wally || clock < RIDE.t0 || clock > TIMING.hero) return;

    const back = RIDE.dist - ridePath(clock);
    const x = anchor.x - board.f.x * back;
    const z = anchor.z - board.f.z * back;
    const g = board.groundY(x - anchor.x, z - anchor.z);

    /* Sit him ON the saddle rather than dropping the bicycle through
       the road: his hips in the ride clip land ~0.66 m over his soles
       and the saddle is at 0.92, so the difference is a lift, not a
       sink. Measured live off the bone, because the clip's hip drop
       and the rig's bind height both belong to another module. */
    if (ctx.wally.bonePosition) {
      const hp = ctx.wally.bonePosition('hips', _v);
      if (hp) hipsLocal = damp(hipsLocal, hp.y - ctx.wally.root.position.y, 8, dt);
    }
    const lift = clamp(SADDLE_Y - hipsLocal, 0, 0.62);

    ctx.wally.root.position.set(x, g + lift, z);
    ctx.wally.root.rotation.y = board.yaw;

    const v = rideSpeed(clock);
    ctx.wally.setLocomotion?.(v, 0);
    const act = ctx.wally.animator?.action;
    if (act && act.name === 'ride-bicycle') act.speed = v * CRANK_TURNS_PER_M;

    bike.group.position.set(x, g, z);
    bike.group.rotation.set(0, board.yaw, 0);
    bike.update(dt, v);
  }

  /* ================================================================
     Hand-over
     ================================================================ */
  function restoreWorld() {
    ctx.sky?.setTimeScale?.(saved.timeScale ?? 0);
    ctx.render?.setGrade?.(
      typeof ctx.sky?.grade === 'string' ? ctx.sky.grade : saved.grade, 1.0);
    if (ctx.wally) {
      ctx.wally.release?.(0.35);
      ctx.wally.setPosition(anchor.x, anchor.y, anchor.z);
      ctx.wally.setYaw(board.yaw);
      ctx.wally.setControlled?.(true);
    }
    ctx.cam?.release?.();
    card.chrome(true);
    gulls?.dispose();
    gulls = null;
    /* The bicycle stays. He rode it here; it is parked where he left
       it, and popping it out of existence on the frame the player
       takes control would be the loudest cut in the game. */
  }

  function finish(reason) {
    if (finished || outro) return;
    if (reason === 'skip') {
      outro = { phase: 'dip', t: 0, reason };
      card.setVeil(1, 0.22);
      card.hint(false);
      return;
    }
    outro = { phase: 'out', t: 0, reason };
    card.hide();
    restoreWorld();
  }

  function stepOutro(dt) {
    outro.t += dt;
    if (outro.phase === 'dip') {
      if (outro.t < 0.24) return;
      card.hide(true);
      restoreWorld();
      card.setVeil(0, 0.55);
      outro = { phase: 'out', t: 0, reason: outro.reason };
      return;
    }
    if (outro.t > 0.9) {
      running = false;
      finished = true;
      const skipped = outro.reason === 'skip';
      outro = null;
      detachSkip();
      ctx.bus?.emit('intro:done', { skipped });
    }
  }

  /* ================================================================
     Skip — any key, any tap, at any time
     ================================================================ */
  let skipOn = false;
  let skipArmed = 0;              // when the listeners went on, ms

  /* THE GESTURE THAT STARTS THE GAME MUST NOT ALSO SKIP IT.
     main.js rolls the opener from the player's first press, and one
     physical tap is several events: pointerdown, then touchstart, then
     mousedown, then click. The start beat consumes the first of them
     and play() attaches these listeners while that same tap is still
     being delivered — so the next event in the sequence would arrive
     here a millisecond later and cut a thirty-second cinematic to
     black before its first frame. A short deaf window is the whole
     fix, and it costs nothing: the skip hint does not appear until
     t = 1.6 s. */
  const SKIP_DEAF = 0.4;          // seconds
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function onSkip(e) {
    if (e && e.type === 'keydown' && (e.key === 'F5' || e.key === 'F12')) return;
    if (now() - skipArmed < SKIP_DEAF * 1000) return;
    if (!running || outro) return;
    finish('skip');
  }
  function attachSkip() {
    skipArmed = now();
    if (skipOn || typeof window === 'undefined') return;
    skipOn = true;
    addEventListener('keydown', onSkip, { capture: true });
    addEventListener('pointerdown', onSkip, { capture: true });
    addEventListener('touchstart', onSkip, { capture: true, passive: true });
  }
  function detachSkip() {
    if (!skipOn) return;
    skipOn = false;
    removeEventListener('keydown', onSkip, { capture: true });
    removeEventListener('pointerdown', onSkip, { capture: true });
    removeEventListener('touchstart', onSkip, { capture: true });
  }

  /* ================================================================
     Entry points
     ================================================================ */
  function play(opts = {}) {
    if (!arm()) return false;
    finished = false;
    outro = null;
    clock = 0;
    cueAt = 0;
    beat = -1;
    seeked = false;

    if (reduced && !opts.force) return playStatic();

    card.setVeil(1, 0);
    card.hide(true);
    running = true;
    ctx.bus?.emit('intro:start', { reduced: false });
    playSeq(0);
    fogNear = board.sea.fog[0];
    fogFar = board.sea.fog[1];
    card.setVeil(0, 1.7);
    attachSkip();
    return true;
  }

  /* Reduced motion: no flight, no cuts, no push in. One held frame of
     the hero framing, the card, and out. */
  function playStatic() {
    running = true;
    clock = TIMING.title;
    ctx.sky?.setHour?.(hourAt(clock));
    cueAt = CUES.length - 1;
    CUES[CUES.length - 1] = { t: TIMING.title + 4.2, f: () => finish('end') };
    ctx.bus?.emit('intro:start', { reduced: true });
    dismount();
    poseWelcome();
    fogTarget = board.hero.fog;
    fogNear = fogTarget[0];
    fogFar = fogTarget[1];
    beat = BEATS.indexOf('hero');
    ctx.cam.cinematic([board.hero.shots[1]], {
      ...board.hero.opts, handheld: 0, grade: board.hero.grade,
    });
    card.setVeil(0, 0.5);
    landTitle();
    attachSkip();
    return true;
  }

  /** Jump the director to one of the MARKS in shots.js. */
  function seek(n) {
    if (!arm()) return null;
    const m = MARKS[clamp(n | 0, 0, MARKS.length - 1)];
    finished = false;
    outro = null;
    running = true;
    seeked = true;
    clock = m.t;
    ctx.sky?.setHour?.(hourAt(clock));
    card.setVeil(0, 0);
    card.hide(true);
    /* Replay every cue up to here, in order — they are all
       idempotent, so this reconstructs the exact character state the
       mark implies rather than approximating it. */
    cueAt = 0;
    while (cueAt < CUES.length && CUES[cueAt].t <= clock + 1e-4) {
      if (CUES[cueAt].t < TIMING.end - 1e-4) CUES[cueAt].f();
      cueAt++;
    }
    playSeq(BEATS.indexOf(m.seq), m.from);
    attachSkip();
    return m;
  }

  /* ================================================================
     Frame
     ================================================================ */
  function update(dt) {
    if (!running && !outro) return;
    dt = dt > 0 ? Math.min(dt, 0.05) : 1 / 60;

    if (outro) {
      /* Ease the fog back toward the sky's own numbers so the last
         frame of the intro and the first of gameplay share a horizon;
         stop writing once we are inside them and sky takes over. */
      fogNear = damp(fogNear, 60, 2.2, dt);
      fogFar = damp(fogFar, 420, 2.2, dt);
      if (ctx.sky?.fog && fogFar > 432) { ctx.sky.fog.near = fogNear; ctx.sky.fog.far = fogFar; }
      gulls?.update(dt, ctx.elapsed);
      stepOutro(dt);
      return;
    }

    clock += dt;

    /* cuts */
    const next = beat + 1;
    if (next < BEATS.length && clock >= TIMING[BEATS[next]]) playSeq(next);

    /* one-shots */
    while (cueAt < CUES.length && clock >= CUES[cueAt].t) {
      CUES[cueAt++].f();
      if (outro) return;
    }

    /* fog — this write is the one that reaches the renderer */
    fogNear = damp(fogNear, fogTarget[0], 1.5, dt);
    fogFar = damp(fogFar, fogTarget[1], 1.5, dt);
    if (ctx.sky?.fog) { ctx.sky.fog.near = fogNear; ctx.sky.fog.far = fogFar; }

    driveCharacter(dt);
    gulls?.update(dt, ctx.elapsed);
  }

  /* ================================================================
     ctx.intro
     ================================================================ */
  const api = {
    play,
    seek,
    skip: () => finish('skip'),
    get running() { return running; },
    get time() { return clock; },
    marks: MARKS,
    timing: TIMING,
    update,
    resize() {},
    dispose() {
      detachSkip();
      card?.dispose();
      gulls?.dispose();
      bike?.dispose();
      card = gulls = bike = null;
    },
    state() {
      return {
        running, finished, t: +clock.toFixed(2),
        seq: beat >= 0 ? BEATS[beat] : null,
        fog: [Math.round(fogNear), Math.round(fogFar)],
        hour: ctx.sky?.hour != null ? +ctx.sky.hour.toFixed(2) : null,
        title: !!card?.visible,
        yaw: board ? +(board.yaw * 57.2958).toFixed(1) : null,
        stage: stage ? { moved: stage.moved, score: stage.score } : null,
        cam: ctx.cam?.mode ?? null,
      };
    },
  };

  /* ================================================================
     Debug hooks
     ================================================================ */
  if (typeof window !== 'undefined' && window.WALLY) {
    const dbg = window.WALLY.debug || (window.WALLY.debug = {});
    dbg.playIntro = () => { play({ force: true }); return api.state(); };
    dbg.introShot = (n = 0) => seek(n);
    dbg.titleCard = () => seek(7);
    dbg.skipIntro = () => { finish('skip'); return 'skipping'; };
    dbg.introState = () => api.state();
    dbg.introMarks = () => MARKS.map((m) => `${m.n}  ${m.t.toFixed(2)}s  ${m.label}`);
    dbg.intro = api;
  }

  /* NOTHING AUTO-PLAYS FROM HERE ANY MORE.

     This module used to call play() at the end of its own init. That
     meant the opener began while the AudioContext was still
     suspended — browsers only resume one on a real user gesture, and
     boot is not a gesture — so the score never started and the title
     sting at 31.11 s was scheduled into a context that was not
     running. The whole cinematic played silent.

     main.js now rolls the opener from inside the player's first
     gesture (see THE START BEAT there), once the context has actually
     reached `running`, so the music and the picture begin on the same
     instant and the title lands on bar 7 with the sting under it.

     main.js calls ctx.intro.play() only when neither flags.shot nor
     flags.skipIntro is set — the same condition that used to guard
     this line. Every tool in tools/ boots with one of them and none
     of them ever sees the cinematic. */

  return api;
}

export default init;
