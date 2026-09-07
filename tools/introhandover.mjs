/* introhandover.mjs — the cinematic hands the character back INTACT.
 *
 * WHY THIS EXISTS. Every other suite here boots with ?skipIntro, so the
 * WATCHED intro — what every real player sees on their first load — had
 * never been driven by a test. A bug that fired on every first visit
 * ("he moves but no walk animation or bike animation") survived eleven
 * rounds of adversarial review inside that blind spot.
 *
 * WHAT IT ASSERTS, and the groups are separate on purpose:
 *
 *   LOCOMOTION (4)  position, animator speed, the leg's actual travel,
 *     and the frame counter are four different failures. The bug this
 *     file was written for moved the position perfectly while the
 *     animator sat at zero, so any check that only asked "did he move"
 *     reported healthy — mine did, twice, before I looked at the right
 *     number.
 *
 *   THE ARMS (4)  the second shipped bug at the same seam, and it is
 *     the same class one layer over: the intro poses him, the game's
 *     animator takes over, and the two did not meet. Measured rather
 *     than screenshotted — a screenshot of an arm halfway down looks
 *     like an arm.
 *
 *   THE ARRIVAL (3)  he arrives on whatever the save says he last rode,
 *     and a machine that is HIS is still standing there afterwards.
 *
 * ONE CASE PER RIDE. There are exactly four (data.js RIDES: bike,
 * scooter, motorcycle, balloon — there is no "advanced bicycle"; the
 * rung above the bicycle is the scooter) and the arms are in a
 * different place at the C -> D cut for every one of them, so a fix
 * tuned to the bicycle would not hold. The no-save case runs first and
 * is the one a brand-new player gets.
 *
 * TRAPS, all of which fooled this file's earlier drafts:
 *   · SPACE releases the boot gate AND skips the intro. Press it to get
 *     past the gate and you have skipped the thing under test. Release
 *     with a CLICK.
 *   · headless Chrome auto-allows audio, so ask() never runs and the real
 *     first-run path never happens. Launch with user-gesture-required.
 *   · a promise that only resolves from requestAnimationFrame hangs for
 *     ever if rAF stalls. Every sampler here has a wall-clock fallback.
 *   · a per-frame angle DELTA is frame-rate dependent, and this machine
 *     runs 10-18 load average. Every arm threshold below is a RATE in
 *     degrees per second, divided by the frame's own dt, so a 40 ms
 *     hitch during the settle cannot be read as a snap.
 *   · a case whose save silently failed to load would then pass every
 *     arm assertion for the wrong reason, on the bicycle. The ride is
 *     asserted BEFORE the arms are, twice: once off the save and once
 *     off what the director actually staged.
 *   · a revert that did not install is indistinguishable from a fix
 *     that works, because both leave every assertion green. The
 *     `applied` flag is asserted before anything is measured.
 *
 * ==================================================================
 * THE REVERT CHECK.  node tools/introhandover.mjs --revert
 *
 * A REVERT CHECK RUNS TODAY'S TEST AGAINST YESTERDAY'S CODE. Nothing
 * else is one. Yesterday's test against yesterday's code passes by
 * construction — they were written together. And quoting the number a
 * bug used to produce ("measured ~70-100 deg/s with the settle cue
 * reverted") is a CITATION, not a measurement: it stays in the file,
 * word for word, after the fix it refers to has been deleted.
 *
 * This file used to have only citations. It now has a switch. Three
 * prior behaviours live behind WALLY.debug.revert(name) in src/main.js
 * — see RUNTIME REVERTS there for what each one restores and why the
 * switch is in main.js rather than in the module it wraps:
 *
 *   locomotion  restoreWorld() never hands the locomotion latch back.
 *               Must break: ANIM-TRACKS, LEGS.
 *   settle      the action layer is released AT the cut instead of
 *               1.70 s before it.
 *               Must break: ACTION-RELEASED, MEET, SEAM.
 *   crossfade   anim.js play() substitutes the pose instead of blending
 *               out of the outgoing clip.
 *               Must break: SWAP.
 *
 * `--revert` runs one watched intro per revert and INVERTS exactly the
 * assertions that revert names: each must now FAIL, and every other
 * assertion in the run must still pass. An assertion that stays green
 * under its own revert is an assertion that is measuring nothing, and
 * this suite says so out loud instead of shipping it.
 *
 * A revert that cannot be applied (the module it wraps is not on ctx)
 * reports applied:false and is a FAILURE here, never a silent skip.
 *
 * All three ran green on 2026-09-06 — headless Chrome, ANGLE Metal
 * Renderer on an Apple M1 Max, 1280x720, watched intro reaching the
 * hand-over at director t = 34.68 s. 15 assertions each; the numbers
 * they produced are in THE THRESHOLDS below, beside the fixed ones.
 * ==================================================================
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
let fails = 0, passes = 0;
const ok = (c, m, d = '') => { if (c) { passes++; console.log(`PASS  ${m}`, d); } else { fails++; console.log(`FAIL  ${m}`, d); } };

/* ------------------------------------------------------------------
   THE REVERT TABLE. `breaks` is a CONTRACT, not documentation: under
   `--revert`, the named assertions must fail and everything else in
   the same run must still pass. Keys match the okk() calls below.
   ------------------------------------------------------------------ */
const REVERTS = {
  locomotion: { breaks: ['ANIM-TRACKS', 'LEGS'] },
  settle:     { breaks: ['ACTION-RELEASED', 'MEET', 'SEAM'] },
  crossfade:  { breaks: ['SWAP'] },
};

/* The armed revert for the run in progress, and the keys it owes a
   failure. Empty on a normal run, which is then byte-for-byte the
   suite it always was. */
let armed = null;
const inverted = new Set();

/* A KEYED assertion. On a normal run it is `ok`. Under a revert that
   names this key it is the exact NEGATION of the same predicate on the
   same measurement — not a looser one, or the revert arm would be
   agreeing with the fix rather than contradicting it. */
const okk = (key, c, m, d = '') => {
  if (!inverted.has(key)) return ok(c, `[${key}] ${m}`, d);
  ok(!c, `[${key}] REVERT ${armed}: this must FAIL — ${m}`, d);
};

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

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--autoplay-policy=user-gesture-required'],
});

/* ------------------------------------------------------------------
   THE THRESHOLDS, AND THE MEASUREMENT BEHIND EACH.

   EVERY "BROKEN" NUMBER BELOW IS NOW A LIVE READING, not a quotation.
   They were taken by `node tools/introhandover.mjs --revert` on
   2026-09-06, headless Chrome, ANGLE Metal Renderer on an Apple M1 Max
   (the same rig the fixed run below was measured on), and re-running
   that command reproduces them. Anything you cannot reproduce that way
   does not belong in this comment.

   The first three are degrees per second on the fastest-moving joint
   of either arm (shoulder, elbow, wrist, both sides), taken between
   two consecutive rendered frames and divided by that frame's own dt.

   SEAM_RATE 20 — the MEDIAN arm rate over the 0.35 s after the cut.
     Idle's own arm motion is 1.5-2 deg/s and that is what a healthy
     hand-over measures: FIXED reads 0.8 deg/s over 22 frames. With
     `--revert=settle` the same window measures 107.8 deg/s (peak
     191.1), because the release from `welcome` runs for 1.33 s INTO
     gameplay. 130x, on the same page, on the same walk. Median, and
     the after-half only: see the note at the measurement.
   SWAP_RATE 600 — nothing may snap once the title has landed. FIXED
     peaks at 169 deg/s. With `--revert=crossfade`, `cool -> welcome`
     measures 3376.6 deg/s — a whole-pose substitution in one frame.
     (The 4771 this file used to quote was the same defect on a faster
     frame; a rate is the right unit precisely because it is not.)
   MEET_DEG 1.2 — degrees, not a rate: how far the worst arm joint
     travels in the 0.30 s after the cut. This is the "do the two poses
     MEET" test, and the reference it is printed against is the same
     measurement over the 0.30 s BEFORE the cut. FIXED: 0.24 deg after,
     0.10 before. `--revert=settle`: 37.89 deg after, 0.51 before,
     because the release from `welcome` — both arms 42 degrees abducted,
     86 degrees of supination — is barely started 0.30 s into gameplay.

   And a fourth, which is a state rather than a rate:
   ACTION-RELEASED — actionW on the last cinematic frame. FIXED: 0,
     clip `none`. `--revert=settle`: 1, still holding `welcome`, with
     0.2674 left a third of a second into the player's game.

   Every one of them separates fixed from broken by at least 3x, in
   both directions, and the broken side is produced on demand rather
   than remembered: see THE REVERT CHECK at the top of this file.
   ------------------------------------------------------------------ */
const SEAM_RATE = 20;
const SWAP_RATE = 600;
const MEET_DEG = 1.2;
const ARMS = ['armL0', 'armL1', 'handL', 'armR0', 'armR1', 'handR'];

/* A save with one ride owned and equipped, written straight into
   localStorage before the page loads. It exercises the REAL path:
   game.js load()s it at boot whenever ?shot is not set, which is
   exactly the boot the watched intro happens on.
   `version: 6` is load-bearing and not a detail — save.js migrate()
   returns null for a record with no numeric `version`, so a seed
   without it is silently no save at all and every case would run on
   the bicycle and pass for the wrong reason. Below CONFIG.version, so
   the forward-fill from newState() supplies every other field and this
   stays four keys long. */
const seedSave = (id) => `(() => { try { localStorage.setItem('wally_rpg_save_v7',
  JSON.stringify({ version: 6, rides: { owned: { ${id}: true }, equipped: '${id}' } })); } catch (e) {} })()`;

async function run(label, opts = {}) {
  const { mobile = false, ride = null, expect = 'bike', owned = false, revert = null } = opts;
  armed = revert;
  inverted.clear();
  if (revert) for (const k of REVERTS[revert].breaks) inverted.add(k);
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }
    : { viewport: { width: 1280, height: 720 } });
  if (ride) await ctx.addInitScript(seedSave(ride));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 90000 });

  /* ------------------------------------------------------------------
     ARM THE REVERT, BEFORE THE THING IT BREAKS HAPPENS.

     The settle cue fires at TIMING.end - 1.70, about 29 s of director
     time from here, and the gate below has not even been released yet,
     so this is comfortably early. It is also asserted rather than
     assumed: `applied:false` means the wrapper found nothing to wrap,
     and every "must FAIL" below would then pass for the wrong reason —
     which is the exact defect class this whole block exists to close.
     ------------------------------------------------------------------ */
  if (revert) {
    const r = await page.evaluate((n) => WALLY.debug.revert(n), revert);
    ok(!!r && r.applied === true && r.on === true,
       `${label}: the revert is actually installed`,
       JSON.stringify(r));
    if (!r || !r.applied) { await ctx.close(); return; }
  }

  /* Did the save actually arrive? A case that silently fell back to the
     bicycle would pass every arm assertion below for the wrong reason. */
  const rides = await page.evaluate(() => {
    try { return WALLY.ctx.game.actions.rides().map((r) => `${r.id}${r.owned ? '+' : '-'}${r.equipped ? 'E' : ''}`).join(' '); }
    catch (e) { return null; }
  });
  if (ride) {
    ok(!!rides && rides.includes(`${ride}+E`), `${label}: the save loaded — ${ride} owned and equipped`, rides || 'no rides()');
  }

  /* ------------------------------------------------------------------
     RELEASING THE GATE — and NOT skipping the thing under test.

     main.js openTheDoor() only puts the "press any key to begin" chip
     up when the AudioContext is actually blocked. Headless Chrome has
     no audio device, so `audio.unavailable` is true, `allowed` is true,
     and begin() runs WITHOUT a gesture: the opener is already playing
     by the time this file is ready to click. Clicking then does not
     release a gate — intro.js's skip listener is armed and its 0.4 s
     deaf window has long expired, so the click SKIPS the cinematic.

     MEASURED, and it is the exact failure this file's header warns
     about: with an unconditional click the opener was skipped at
     director t = 0.15 s, `intro:done` reported {skipped: true}, and
     `saw` still went true-then-false so "the intro actually ran"
     PASSED. Every arm assertion after it was then measuring a hand-over
     that had never happened.

     So: wait to see whether it starts on its own, and only click if it
     does not. And the assertion below is no longer "running went true
     and then false" — it is "the director got past the hero mark",
     which a skip at 0.15 s cannot fake.
     ------------------------------------------------------------------ */
  let auto = false;
  for (let i = 0; i < 12 && !auto; i++) {
    auto = await page.evaluate(() => !!(WALLY?.ctx?.intro?.running));
    if (!auto) await page.waitForTimeout(250);
  }
  /* CLICK, never SPACE: SPACE releases the gate AND skips the intro. */
  if (!auto) {
    if (mobile) await page.touchscreen.tap(195, 420); else await page.mouse.click(640, 360);
    await page.waitForTimeout(1200);
  }

  /* ---- the arm sampler, armed for the whole opener ----
     It stops itself after 5000 frames, so it cannot leak into the
     gameplay measurements below. Every record carries its own dt so a
     RATE can be formed without assuming 60 fps on a loaded machine. */
  await page.evaluate((names) => {
    const w = WALLY.ctx.wally, a = w.animator;
    window.__ARMS = [];
    let last = performance.now();
    const tick = () => {
      const n = performance.now();
      const r = {
        dt: (n - last) / 1000,
        t: WALLY.ctx.intro ? WALLY.ctx.intro.time : -1,
        run: !!(WALLY.ctx.intro && WALLY.ctx.intro.running),
        /* THE SEAM IS THE CAMERA CUT, NOT `intro.running`. finish()
           hands control and the camera back inside restoreWorld() and
           only THEN runs a 0.9 s outro with `running` still true — so
           anchoring on running going false measures a window 0.9 s
           after the hand-over, which is long enough for a broken
           release to have finished and look healthy. Measured: with
           the settle cue removed, a running-anchored window reported
           0.37 deg and passed. cam.mode leaves 'cinematic' on the
           exact frame ctx.cam.release() runs, which is the frame the
           player gets the controls. */
        cam: (WALLY.ctx.cam && WALLY.ctx.cam.mode) || '',
        aw: a.actionW || 0,
        act: a.action ? a.action.name : null,
        j: [],
      };
      last = n;
      for (const nm of names) {
        const b = w.bones[nm];
        r.j.push(b ? b.rotation.x * 57.2958 : 0, b ? b.rotation.y * 57.2958 : 0, b ? b.rotation.z * 57.2958 : 0);
      }
      window.__ARMS.push(r);
      if (window.__ARMS.length < 5000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ARMS);

  /* ---- let the whole opener run ---- */
  const t0 = Date.now(); let saw = false, far = -1;
  while (Date.now() - t0 < 150000) {
    const s2 = await page.evaluate(() => ({ up: !!WALLY?.ctx?.intro?.running, t: WALLY?.ctx?.intro?.time ?? -1 }));
    if (s2.up) saw = true;
    if (s2.t > far) far = s2.t;
    if (saw && !s2.up) break;
    await page.waitForTimeout(400);
  }
  /* 26.667 s is TIMING.hero — the C -> D cut. A skipped opener stops
     dead wherever the skip landed, so this cannot pass for a run that
     did not reach the hand-over it is here to measure. */
  ok(saw && far > 26.667, `${label}: the intro actually ran to the hand-over (not skipped)`,
     `director reached ${far.toFixed(2)} s, gate ${auto ? 'opened itself' : 'released with a click'}`);

  /* Which machine did it stage? Read before the arms, so a wrong ride
     is reported as a wrong ride rather than as an arm failure. */
  const ist = await page.evaluate(() => (WALLY.ctx.intro ? WALLY.ctx.intro.state() : null));
  ok(!!ist && ist.ride === expect && !!ist.owned === owned,
     `${label}: staged the right machine`,
     `${ist ? ist.ride : 'none'} owned=${ist ? ist.owned : '?'}, wanted ${expect} owned=${owned}`);

  await page.waitForTimeout(1400);

  /* ================================================================
     THE ARMS
     ================================================================ */
  const arms = await page.evaluate(() => {
    const S = window.__ARMS || [];
    const rate = (i) => {
      const a = S[i - 1], b = S[i];
      if (!a || !b || !(b.dt > 0.001)) return 0;
      let m = 0;
      for (let k = 0; k < b.j.length; k++) m = Math.max(m, Math.abs(b.j[k] - a.j[k]));
      return m / b.dt;
    };
    let cut = -1;
    for (let i = 1; i < S.length; i++) {
      if (S[i - 1].cam === 'cinematic' && S[i].cam !== 'cinematic') { cut = i; break; }
    }
    if (cut < 0) return { cut: -1, frames: S.length };
    /* SEAM: every frame within 0.35 s either side of the cut. Walked
       out from the cut rather than differenced on wall clock, so a
       stalled frame cannot silently widen the window. */
    /* THE MEDIAN OF THE FRAMES AFTER THE CUT, against the median of
       the frames before it.

       NOT THE PEAK, and not the two halves pooled — both were tried and
       both were measured blind. Re-enabling the character controller on
       the cut frame lets it report its own first speed, and that ONE
       frame moves an arm about two thirds of a degree however healthy
       the hand-over is, so a peak cannot tell it from a snap (fixed 41
       deg/s against broken 226 — under two-fold). Pooling the halves is
       worse: the frames BEFORE the cut are a held pose in both states,
       so they outvote the interesting ones and the median came back 1.9
       deg/s with the fix REVERTED. A release that is still running moves
       every frame after the cut and none before it, which is exactly
       what these two numbers are. */
    const half = (from, dir) => {
      const r = [];
      for (let i = from, d = 0; i > 0 && i < S.length && d < 0.35; i += dir, d += S[i] ? S[i].dt : 1) r.push(rate(i));
      r.sort((a, b) => a - b);
      return { med: r.length ? r[r.length >> 1] : 0, peak: r.length ? r[r.length - 1] : 0, n: r.length };
    };
    const A = half(cut, 1), B = half(cut - 1, -1);
    const seam = A.med, seamPeak = A.peak, seamN = A.n, seamBefore = B.med;
    /* SWAP: everything from the title beat (7 bars = 31.111 s) to the cut */
    let swap = 0;
    for (let i = 1; i <= cut; i++) if (S[i].cam === 'cinematic' && S[i].t >= 31.111) swap = Math.max(swap, rate(i));
    /* IDLE reference: the quiet part of the hero hold, before the title */
    let idle = 0;
    for (let i = 1; i < cut; i++) if (S[i].t > 28.0 && S[i].t < 30.5) idle = Math.max(idle, rate(i));
    /* MEET: how far the arms travel in the 0.30 s AFTER the cut,
       against how far they travelled in the 0.30 s BEFORE it. The
       window is short on purpose — `idle` has its own 8.4 s weight
       shift that moves a shoulder about a degree over a second, so a
       one-second window measures the idle rather than the hand-over. */
    const walk = (from, dir, secs) => {
      let i = from, acc = 0;
      while (i + dir > 0 && i + dir < S.length && acc < secs) { i += dir; acc += S[i].dt; }
      return i;
    };
    const after = walk(cut, 1, 0.30);
    const before = walk(cut - 1, -1, 0.30);
    let meet = 0, worst = -1, ref = 0;
    for (let k = 0; k < S[cut - 1].j.length; k++) {
      const d = Math.abs(S[after].j[k] - S[cut - 1].j[k]);
      if (d > meet) { meet = d; worst = k; }
      ref = Math.max(ref, Math.abs(S[cut - 1].j[k] - S[before].j[k]));
    }
    return {
      cut, seam: +seam.toFixed(1), seamPeak: +seamPeak.toFixed(1), seamN,
      seamBefore: +seamBefore.toFixed(1), swap: +swap.toFixed(1), idle: +idle.toFixed(1),
      meet: +meet.toFixed(2), ref: +ref.toFixed(2), worst,
      awLast: +(S[cut - 1].aw).toFixed(4), actLast: S[cut - 1].act,
      awAfter: +(S[after].aw).toFixed(4), frames: S.length,
      camBefore: S[cut - 1].cam, camAfter: S[cut].cam, tCut: +S[cut].t.toFixed(2),
    };
  });

  if (arms.cut < 0) {
    ok(false, `${label}: the arm sampler saw the hand-over`, `${arms.frames || 0} frames, no running->stopped edge`);
  } else {
    /* (a) BRANCH: intro.js settle(). The action layer is handed back
       BEFORE the cut, not across it. */
    okk('ACTION-RELEASED', arms.awLast < 0.02 && arms.awAfter < 0.02,
       `${label}: the action layer is released before the cut, not over it`,
       `actionW ${arms.awLast} on the last cinematic frame (${arms.actLast || 'none'}) at t=${arms.tCut}, ${arms.awAfter} after; cam ${arms.camBefore} -> ${arms.camAfter}`);
    /* (b) BRANCH: settle() plus restoreWorld's !settled guard. The two
       poses MEET — the last frame of the opener and a second into
       gameplay are the same arms. */
    okk('MEET', arms.meet < MEET_DEG,
       `${label}: the intro pose and the game pose are the same pose`,
       `worst arm joint moves ${arms.meet} deg in the 0.30 s after the cut, ${arms.ref} in the 0.30 s before it (limit ${MEET_DEG})`);
    /* (c) BRANCH: anim.js play()'s prev/prevW crossfade. Nothing snaps
       once the title has landed. */
    okk('SWAP', arms.swap > 0 && arms.swap < SWAP_RATE,
       `${label}: no arm snap after the title lands`,
       `peak ${arms.swap} deg/s (limit ${SWAP_RATE}; the un-crossfaded clip swap measured 4771)`);
    /* (d) and the seam itself is as quiet as the idle it hands over to */
    okk('SEAM', arms.seam < SEAM_RATE,
       `${label}: the arms are still across the seam`,
       `median ${arms.seam} deg/s over the ${arms.seamN} frames after the cut (peak ${arms.seamPeak}), ${arms.seamBefore} over the frames before it, idle reference ${arms.idle} (limit ${SEAM_RATE})`);
  }

  /* ================================================================
     THE ARRIVAL — is the machine still there, and does the save agree?
     ================================================================ */
  const world = await page.evaluate((want) => {
    /* NAME-MATCHED, not "any intro prop". Counting every `intro.*`
       group let this pass on a run where the director had staged the
       BICYCLE instead of the machine the save asked for — the intro's
       own bicycle was standing there, so "his machine is in the world"
       read true about somebody else's. */
    let n = 0, other = [];
    WALLY.ctx.scene.traverse((o) => {
      if (!o.isGroup || !o.visible || !/^intro\./.test(o.name || '')) return;
      if (o.name === `intro.${want}`) n++; else other.push(o.name);
    });
    let spot = null, parked = null;
    try { spot = WALLY.ctx.game.actions.parkSpot(want); } catch (e) {}
    try { parked = WALLY.ctx.wally.rideState.parked.map((p) => p.id); } catch (e) {}
    return { introProps: n, other, spot, parked };
  }, expect);

  if (owned) {
    ok(!!world.spot, `${label}: his own machine is registered where he left it`,
       world.spot ? `${expect} at [${world.spot.x}, ${world.spot.y}, ${world.spot.z}] yaw ${world.spot.yaw}` : 'no park spot');
    ok((world.parked || []).includes(expect) || world.introProps > 0,
       `${label}: ...and it is actually standing in the world`,
       `wally parked=${JSON.stringify(world.parked)}, intro.${expect} visible=${world.introProps}, other intro props ${JSON.stringify(world.other)}`);
  } else {
    /* A BRAND-NEW PLAYER'S PATH IS EXACTLY WHAT IT WAS: the machine he
       arrived on is not his, and nothing claims otherwise. */
    ok(!world.spot, `${label}: a machine that is not his leaves no park record`, JSON.stringify(world.spot));
  }

  /* ================================================================
     LOCOMOTION — the original four
     ================================================================ */
  const f0 = await page.evaluate(() => WALLY?.ctx?.frame ?? 0);
  const p0 = await page.evaluate(() => ({ x: WALLY.ctx.wally.root.position.x, z: WALLY.ctx.wally.root.position.z }));

  if (mobile) {
    await page.touchscreen.tap(90, 700).catch(() => {});
    await page.evaluate(() => { WALLY.ctx.wally.setInput?.(() => ({ x: 0, z: 1, run: false })); return true; });
  } else await page.keyboard.down('KeyW');

  /* NEVER let this hang. A promise that only resolves from requestAnimationFrame
     never resolves if rAF stops, and page.evaluate then waits forever — that wedged
     the mobile run of this very file for four and three quarter hours with no output.
     A wall-clock fallback resolves with whatever was sampled, and a stalled rAF then
     reports as a FAILED assertion instead of a hung suite. */
  const legs = await page.evaluate(() => new Promise((res) => {
    const w = WALLY.ctx.wally; let bone = null;
    w.root.traverse((o) => { if (!bone && o.isBone && /leg|thigh|shin/i.test(o.name)) bone = o; });
    if (!bone) return res({ bone: null, range: -1, why: 'no leg bone' });
    const s = []; let n = 0, done = false;
    const finish = (why) => { if (done) return; done = true;
      res({ bone: bone.name, frames: s.length, why,
            range: s.length ? +(Math.max(...s) - Math.min(...s)).toFixed(4) : -1 }); };
    const t = () => { if (done) return; s.push(bone.rotation.x);
      if (++n < 60) requestAnimationFrame(t); else finish('sampled'); };
    requestAnimationFrame(t);
    setTimeout(() => finish('rAF stalled'), 4000);
  }));
  await page.waitForTimeout(900);
  const st = await page.evaluate(() => {
    const w = WALLY.ctx.wally, a = w.anim ?? w.animator ?? w._anim;
    return { animSpeed: +(a?.speed ?? -1).toFixed(3), ctrlSpeed: +(w.controller?.planarSpeed ?? -1).toFixed(3),
             x: w.root.position.x, z: w.root.position.z, frame: WALLY.ctx.frame ?? 0 };
  });
  if (!mobile) await page.keyboard.up('KeyW');

  const moved = Math.hypot(st.x - p0.x, st.z - p0.z);
  ok(moved > 0.5, `${label}: he travels`, `${moved.toFixed(2)} m`);
  ok(st.frame > f0 + 30, `${label}: the frame loop is alive`, `${f0} -> ${st.frame}`);
  ok(st.ctrlSpeed > 0.5, `${label}: the controller reads a real speed`, `${st.ctrlSpeed} m/s`);
  /* THE ONE THE FIRST BUG BROKE. The animator must be told the speed the
     controller is actually producing — not a value the cinematic pinned. */
  okk('ANIM-TRACKS', Math.abs(st.animSpeed - st.ctrlSpeed) < 0.25,
     `${label}: the animator tracks the controller — locomotion handed back`,
     `anim ${st.animSpeed} vs controller ${st.ctrlSpeed}`);
  okk('LEGS', legs.range > 0.5, `${label}: the legs actually swing`, `${legs.range} rad over ${legs.frames ?? 0} frames (${legs.why}); idle sway is ~0.16`);

  /* ---- and the machine that is NOT his still leaves ----
     THE OTHER HALF OF THE ARRIVAL DECISION, and the one a change to
     it would break silently. A free bicycle identical to the $180 one
     in the pawnshop, standing at the player's feet, deletes the day-one
     purchase the early economy turns on — so it goes on the first frame
     it is outside the frustum, which the walk above has just put it.
     An owned machine must NOT go, and is asserted the other way up. */
  if (!owned) {
    /* WALK RIGHT AWAY FROM IT, and 5 m is not far enough — measured.
       The follow boom sits 4.2 m BEHIND him, so after a five-metre
       walk the camera is barely past the spawn and the machine is
       still inside the frustum. It is not supposed to go while it can
       be seen: intro.js's own rule is that a pop is a defect and a
       bicycle standing there while you stare at it is not. Twelve more
       metres puts the camera well past it. Desktop failed this at 5 m
       while the portrait mobile viewport passed, which is the same
       fact seen through a narrower lens. */
    if (mobile) await page.evaluate(() => { WALLY.ctx.wally.setInput?.(() => ({ x: 0, z: 1, run: true })); return true; });
    else await page.keyboard.down('KeyW');
    await page.waitForTimeout(4000);
    if (!mobile) await page.keyboard.up('KeyW');
    else await page.evaluate(() => { WALLY.ctx.wally.setInput?.(null); return true; });
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      gone = await page.evaluate(() => {
        let n = 0;
        WALLY.ctx.scene.traverse((o) => { if (o.isGroup && /^intro\./.test(o.name || '')) n++; });
        return n === 0;
      });
      if (!gone) await page.waitForTimeout(400);
    }
    ok(gone, `${label}: the arrival machine is collected once he looks away`);
  } else {
    const still = await page.evaluate((want) => {
      try { return !!WALLY.ctx.game.actions.parkSpot(want); } catch (e) { return false; }
    }, expect);
    ok(still, `${label}: ...and HIS machine is still on the record after he walks off`);
  }
  ok(errs.length === 0, `${label}: no page errors`, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

const argv = process.argv.slice(2);
const only = argv.filter((a) => !a.startsWith('-'));
/* --revert            all three
   --revert=settle     one of them, by name */
const revArg = argv.find((a) => a === '--revert' || a.startsWith('--revert='));
const REVERT_NAMES = revArg
  ? (revArg.includes('=') ? revArg.split('=')[1].split(',') : Object.keys(REVERTS))
  : [];
for (const n of REVERT_NAMES) {
  if (!REVERTS[n]) { console.log(`FAIL  no revert named "${n}" — have ${Object.keys(REVERTS).join(', ')}`); fails++; }
}

const CASES = [
  /* NO SAVE FIRST. It is the path a brand-new player takes and the one
     every other case is a deviation from. */
  ['no save, watched intro', { expect: 'bike', owned: false }],
  ['bicycle owned', { ride: 'bike', expect: 'bike', owned: true }],
  ['scooter owned', { ride: 'scooter', expect: 'scooter', owned: true }],
  ['motorcycle owned', { ride: 'motorcycle', expect: 'motorcycle', owned: true }],
  ['balloon owned', { ride: 'balloon', expect: 'balloon', owned: true }],
  ['no save, mobile', { mobile: true, expect: 'bike', owned: false }],
];

if (REVERT_NAMES.length) {
  /* THE REVERT ARM. One watched intro per revert, on the brand-new
     player's path — the same case the fixed suite opens with, so the
     only difference between the green run and this one is the code.
     Each run demands a failure from exactly the assertions its revert
     names, and a pass from every other assertion in the same run. */
  for (const n of REVERT_NAMES.filter((k) => REVERTS[k])) {
    console.log(`\n---- REVERT ${n}: ${REVERTS[n].breaks.join(', ')} must fail ----`);
    await run(`revert:${n}`, { expect: 'bike', owned: false, revert: n });
  }
} else {
  for (const [label, o] of CASES) {
    if (only.length && !only.some((k) => label.includes(k))) continue;
    await run(label, o);
  }
}

await browser.close(); server.close();
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
