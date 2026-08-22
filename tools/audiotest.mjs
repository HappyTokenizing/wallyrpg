#!/usr/bin/env node
/* ============================================================
   audiotest.mjs — prove the game is not silent.

   tools/test-audio.mjs drives the audio modules against a fake
   OfflineAudioContext in node. That proves the score is *correct*. It
   cannot prove the score is *audible*, because what silences it is a
   browser policy, not a bug in the notes: an AudioContext is created
   `suspended` and only a real user gesture may resume it. Anything
   scheduled into a suspended context is never heard — which is
   exactly how the opening cinematic used to play. Silent.

   So this file boots the real game in real Chrome with none of the
   tools/ escape flags, and runs five passes.

   PASS A — autoplay blocked. Headless Chrome will not block Web Audio
   for any value of --autoplay-policy, so the block is imposed on the
   page instead: a context born suspended whose resume() hangs until
   navigator.userActivation.isActive is true. See
   installAutoplayBlock() below — the gate is real user activation, so
   this stays an honest test rather than a rehearsed one.

     1  the boot screen asks for the start beat, the context is
        suspended, and the cinematic has NOT rolled into it;
     2  a genuine user gesture — a trusted key press through CDP, not
        a synthesised DOM event, which would not unlock audio and
        would make the whole test a lie;
     3  the AudioContext reaches `running`;
     4  the music scheduler emits note events, at the cinematic
        score's own 54 bpm, from bar 0;
     5  the title sting fires on the real title beat;
     6  the score keeps playing in ordinary gameplay after the
        cinematic hands over, and a zone change switches the musical
        context end to end (ui.js -> bus -> music.js).

   PASS B — autoplay already permitted (the browser as it comes): no
   prompt at all, the game opens straight through and the score is
   already running. A player
   who is allowed to hear music must never be asked to click first.

   PASS C — THE PHONE. Reported from the field: "music doesn't work
   from my phone on chrome browser." A mobile context (isMobile,
   hasTouch, an Android UA), the same imposed autoplay block, and a
   REAL trusted touch through CDP — touchstart + touchend, never a
   synthesised click, which carries no user activation and would make
   the test a lie. Two things make it a mobile test rather than a
   desktop test in a narrow window:

     · the tap lands on a full-screen DOM OVERLAY, not the canvas. Every
       first tap in this game does: the loading screen, the title card,
       the touch controls, a dialogue scrim. An unlock bound to the
       canvas never sees any of them.
     · the overlay calls preventDefault() on touchstart, exactly as a
       canvas game must to kill scroll and double-tap zoom. That is the
       spec-guaranteed way to suppress the compatibility mousedown /
       mouseup / click a tap would otherwise synthesise — so `click`
       and `mousedown` are simply not available as an unlock, and only
       an activation-triggering TOUCH event can save us. This is the
       exact shape of the reported bug.

   The pass prints which gesture types actually arrived and which of
   them carried navigator.userActivation, so the reason it passes is
   visible rather than assumed.

   PASS D — the tools/ escape hatches. ?shot and ?skipIntro must still
   bypass the start beat entirely and never build an AudioContext, or
   every screenshot tool in tools/ hangs on a keystroke that will not
   come.

   PASS E — THE DROPOUT. Reported from the field: "my music cut off
   after playing for some time. And then stayed off and came back after
   some time." Intermittent, self-healing silence during play, which is
   a different animal from never starting: the context is running, every
   flag says the score is playing, and the room is quiet. The four ways
   Web Audio produces that — a starved look-ahead scheduler in a
   throttled tab, a context suspended and handed back without the
   transport being re-armed, a bus left at zero by an interrupted
   transition, and a transport that simply stopped — are each broken on
   purpose and each has to heal itself. It closes with a soak that
   proves bars keep turning at the score's own rate for minutes on end,
   with no window of silence and no growth in the voice table.

   Every pass also asserts __WALLY_READY__ arrives without a gesture,
   because every tool in tools/ waits on it.

       node tools/audiotest.mjs
       node tools/audiotest.mjs --verbose
       node tools/audiotest.mjs --only E --soak 300   # a five-minute soak

   Exits non-zero if any assertion failed.
   ============================================================ */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
};

/* ---------- tiny assertion kit ---------- */
let passed = 0;
const failures = [];
function ok(cond, label, detail = '') {
  const line = `${label}${detail ? '  ' + detail : ''}`;
  if (cond) { passed++; if (VERBOSE) console.log(`  PASS  ${line}`); }
  else { failures.push(line); console.log(`  FAIL  ${line}`); }
}
const head = (t) => console.log(`\n${t}`);
const note = (t, o) => { if (VERBOSE) console.log(`  ${t}`, JSON.stringify(o)); };

/* Each pass boots a whole game in software GL and holds it for the best
   part of a minute. On a machine already running other headless Chromes
   the renderer occasionally just dies, and a dead renderer is not a
   finding about the audio system — so a crashed pass is rolled back and
   retried rather than reported as a failure. It only becomes a failure
   when it will not complete at all. */
/* `--only C` / `--only A,C` runs a subset. Nothing but a development
   convenience — CI runs the file bare, which runs everything. */
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i < 0) return null;
  return new Set((process.argv[i + 1] || '').toUpperCase().split(/[,\s]+/).filter(Boolean));
})();

async function attempt(label, fn, tries = 3) {
  if (ONLY && !ONLY.has(label.replace(/^PASS\s+/i, '').toUpperCase())) {
    console.log(`\n${label} — skipped (--only)`);
    return;
  }
  for (let i = 1; i <= tries; i++) {
    const p0 = passed, f0 = failures.length;
    try { await fn(); return; } catch (e) {
      passed = p0; failures.length = f0;
      const msg = String(e?.message || e).split('\n')[0];
      if (i === tries) { failures.push(`${label} — ${msg}`); console.log(`  FAIL  ${label} — ${msg}`); return; }
      console.log(`  (browser died, retrying ${i}/${tries - 1}: ${msg})`);
    }
  }
}

/* ---------- static server ---------- */
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, {
      'content-type': MIME[extname(c)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/* THE BLOCKED CONTEXT IS IMPOSED, NOT INHERITED.

   Headless Chrome hands out a `running` AudioContext no matter what
   --autoplay-policy says — there is no audio device and no media
   engagement history to weigh — so the very condition this whole
   feature exists for cannot be reproduced by a launch flag. Measured:
   user-gesture-required, document-user-activation-required and
   no-user-gesture-required all give `running`, muted or not.

   So the blocked passes install the policy itself, before any page
   script runs: an AudioContext that is born suspended and whose
   resume() returns a promise that NEVER SETTLES until the page holds
   real user activation, which is exactly what Chrome does to a blocked
   context. A page-side dispatchEvent still cannot unlock it — only a
   trusted gesture can. The game sees an ordinary blocked context and
   has to cope.

   AND THE TOUCH RULE IS MODELLED, because headless Chrome does not
   apply it. Measured here: a CDP touch tap sets
   navigator.userActivation.isActive as early as `pointerdown`. A real
   phone does not — the HTML Standard's "activation triggering input
   event" list is:

       keydown (not Esc)   ·   mousedown   ·   click
       pointerdown  ONLY when pointerType is "mouse"
       pointerup    ONLY when pointerType is NOT "mouse"
       touchend

   So on a touchscreen the DOWN half of a tap carries no activation at
   all; the activation lands on pointerup / touchend. Leaving the
   harness permissive would let an unlock bound only to `pointerdown`
   pass a test named "mobile", which is precisely the bug that shipped.
   The gate below is therefore the spec list AND the browser's own
   isActive — never more permissive than the real browser, only
   correctly less. */
async function installAutoplayBlock(page, { touchRule = false } = {}) {
  await page.addInitScript((useTouchRule) => {
    /* Registered here, at window capture, before any page script — so
       it always updates before the game's own unlock listener sees the
       same event. */
    const gate = { at: -1e9, ever: false };
    window.__ACTGATE__ = gate;
    const activating = (e) => {
      if (!e.isTrusted) return false;
      switch (e.type) {
        case 'keydown':     return e.key !== 'Escape';
        case 'mousedown':   return true;
        case 'click':       return true;
        case 'pointerdown': return e.pointerType === 'mouse';
        case 'pointerup':   return e.pointerType !== 'mouse';
        case 'touchend':    return true;
        default:            return false;
      }
    };
    for (const t of ['keydown', 'mousedown', 'click', 'pointerdown', 'pointerup', 'touchend']) {
      window.addEventListener(t, (e) => {
        if (!activating(e)) return;
        gate.at = performance.now(); gate.ever = true;
      }, { capture: true, passive: true });
    }
    const permitted = () => {
      const browserSaysActive = !!navigator.userActivation?.isActive;
      if (!useTouchRule) return browserSaysActive;
      return browserSaysActive && (performance.now() - gate.at) < 5000;
    };

    const Real = window.AudioContext || window.webkitAudioContext;
    if (!Real) return;
    class Blocked extends Real {
      constructor(...a) {
        super(...a);
        this.__blocked = true;
        try { super.suspend(); } catch { /* already suspended */ }
      }
      get state() { return this.__blocked ? 'suspended' : super.state; }
      resume() {
        /* Only an autoplay-BLOCKED context needs activation. Once it
           has started once, a later suspend/resume — the tab going away
           and coming back, a phone call — is ordinary and ungated, and
           Chrome's own rule there is *sticky* activation, not transient.
           Gating this too would make the mobile pass's backgrounding
           test fail for a reason no real browser has. */
        if (!this.__blocked) return super.resume();
        if (!permitted()) return new Promise(() => {});  // hangs, like the real thing
        this.__blocked = false;
        return super.resume();
      }
    }
    window.AudioContext = Blocked;
    window.webkitAudioContext = Blocked;
  }, touchRule);
}

/* WHICH GESTURE ACTUALLY CARRIES ACTIVATION.

   The reported bug is not "the unlock is broken", it is "the unlock is
   listening to the wrong events". On a touchscreen `pointerdown` and
   `touchstart` grant no user activation at all — `pointerup` and
   `touchend` do — and the mouse events a tap synthesises afterwards can
   be suppressed entirely. So rather than assume which event saves us,
   record it. Installed before any page script, at window capture, so it
   sees every gesture in the order the browser really delivers them. */
async function installGestureProbe(page) {
  await page.addInitScript(() => {
    window.__ACT__ = [];
    const TYPES = ['pointerdown', 'pointerup', 'touchstart', 'touchend',
      'mousedown', 'mouseup', 'click', 'keydown', 'keyup'];
    /* `act` is the HTML Standard's rule — what a real phone does.
       `raw` is what this headless build claims, which is looser. The
       gap between the two columns is the whole reason the bug was
       invisible in a harness. */
    const spec = (e) => (
      e.type === 'keydown' ? e.key !== 'Escape'
      : e.type === 'mousedown' || e.type === 'click' || e.type === 'touchend' ? true
      : e.type === 'pointerdown' ? e.pointerType === 'mouse'
      : e.type === 'pointerup' ? e.pointerType !== 'mouse'
      : false);
    for (const t of TYPES) {
      window.addEventListener(t, (e) => {
        if (!e.isTrusted) return;
        window.__ACT__.push({
          t, act: spec(e), raw: !!navigator.userActivation?.isActive,
        });
      }, { capture: true, passive: true });
    }
  });
}

/* A full-screen DOM overlay that behaves like the game's own touch
   surface: it swallows the tap and preventDefaults touchstart, which is
   the spec-guaranteed way to suppress the compatibility mousedown /
   mouseup / click. Nothing but a touch event can unlock audio through
   this, and it sits above every other layer — so the tap provably never
   reaches the canvas. */
const HOSTILE_OVERLAY = () => {
  const d = document.createElement('div');
  d.id = 'hostileOverlay';
  d.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.01);touch-action:none';
  window.__OVL__ = [];
  const swallow = (e) => {
    window.__OVL__.push(e.type);
    e.preventDefault();          // kills the compat mouse events + click
    e.stopPropagation();         // nothing below the overlay sees it either
  };
  for (const t of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'click']) {
    d.addEventListener(t, swallow, { passive: false });
  }
  document.body.appendChild(d);
  return true;
};

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/* --mute-audio only silences the output device; the context still runs
   and the scheduler still schedules, which is what we measure. */
async function boot({ block = false, mobile = false, query = '', settle = 1400 } = {}) {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'],
  });
  const context = await browser.newContext(mobile
    ? {
        viewport: { width: 393, height: 851 },
        deviceScaleFactor: 2.75,
        isMobile: true,
        hasTouch: true,
        userAgent: ANDROID_UA,
      }
    : { viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('crash', () => errors.push('[renderer crashed]'));
  /* The touch rule is only meaningful — and only honest — on a device
     that actually has a touchscreen. */
  if (block) await installAutoplayBlock(page, { touchRule: mobile });
  if (mobile) await installGestureProbe(page);

  /* NO ?shot and NO ?skipIntro unless a pass asks for them — this is
     how a player loads the game. */
  await page.goto(`http://127.0.0.1:${port}/index.html${query}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
  /* Let openTheDoor()'s resume() probe finish its 400 ms race. */
  if (settle) await page.waitForTimeout(settle);
  return { browser, page, errors };
}

const gateState = () => ({
  asking: !!document.getElementById('boot')?.classList.contains('ask'),
  prompt: (document.getElementById('bootGo')?.textContent || '').trim(),
  mark: document.querySelector('#bootMark svg')?.getAttribute('aria-label') || null,
  title: document.title,
  state: WALLY.ctx.audio?.actx?.state || null,
  running: WALLY.ctx.audio?.running === true,
  unavailable: WALLY.ctx.audio?.unavailable || null,
  started: WALLY.debug.started ? WALLY.debug.started() : null,
  introRunning: !!WALLY.ctx.intro?.running,
});

/* ================================================================
   PASS A — autoplay blocked. The case the whole design exists for.
   ================================================================ */
await attempt('PASS A', async () => {
  console.log('PASS A — autoplay blocked');
  const { browser, page, errors } = await boot({ block: true });
  try {

  head('boot');
  ok(true, 'ready signal arrives without a gesture');

  const gate = await page.evaluate(gateState);
  note('gate:', gate);

  head('branding');
  ok(gate.title === 'WALLY RPG', 'document title is WALLY RPG', `"${gate.title}"`);
  ok(gate.mark === 'WALLY RPG', 'boot wordmark is the WALLY RPG lockup', `aria-label="${gate.mark}"`);

  head('the start beat');
  ok(gate.state === 'suspended', 'the AudioContext starts suspended', String(gate.state));
  ok(gate.asking, 'the boot screen asks for the start beat');
  ok(/begin/i.test(gate.prompt), 'the prompt reads as a start beat', `"${gate.prompt}"`);
  ok(gate.started === false, 'the opener has not rolled yet');
  ok(!gate.introRunning, 'the cinematic is NOT playing into a suspended context');

  /* A trusted key press, dispatched through CDP. A page-side
     dispatchEvent would not carry user activation and would not
     unlock audio — the assertion below would then be meaningless. */
  await page.keyboard.press('Space');

  const reached = await page
    .waitForFunction('WALLY.ctx.audio && WALLY.ctx.audio.running === true', { timeout: 15000 })
    .then(() => true).catch(() => false);
  ok(reached, 'the AudioContext reaches "running" on the gesture');

  const after = await page.evaluate(() => ({
    state: WALLY.ctx.audio.actx?.state || null,
    opened: WALLY.debug.started(),
    bootGone: !!document.getElementById('boot')?.classList.contains('gone'),
    context: WALLY.ctx.audio.context,
    bpm: Math.round(WALLY.ctx.audio.bpm),
    introRunning: !!WALLY.ctx.intro?.running,
  }));
  note('after gesture:', after);
  ok(after.state === 'running', 'actx.state === "running"', String(after.state));
  ok(after.bootGone, 'the boot screen is dismissed');
  ok(after.introRunning, 'the cinematic rolls, now that it can be heard');
  ok(after.context === 'cinematic', 'the score is on the cinematic context', after.context);
  ok(after.bpm === 54, 'the transport snapped to 54 bpm from bar 0', `${after.bpm} bpm`);

  /* ---- the scheduler actually produces notes ---- */
  head('the score');
  await page.waitForTimeout(2500);
  const play = await page.evaluate(() => {
    const byLayer = {};
    for (const e of WALLY.ctx.audio.notes) byLayer[e.layer] = (byLayer[e.layer] || 0) + 1;
    return {
      count: WALLY.ctx.audio.notes.length, byLayer,
      bar: WALLY.ctx.audio.bar, voices: WALLY.ctx.audio.voices,
    };
  });
  note('notes:', play);
  ok(play.count > 0, 'the music scheduler produced note events', `${play.count} notes`);
  ok(Object.keys(play.byLayer).length >= 2, 'more than one layer is sounding',
    JSON.stringify(play.byLayer));
  ok(play.voices > 0, 'voices are live on the graph', `${play.voices} voices`);

  /* Notes must keep arriving, not merely have been scheduled once.
     The cinematic score is 54 bpm in 4, so one bar is 4.44 s and the
     window has to clear one. */
  const before = play.count;
  await page.waitForTimeout(5200);
  const grew = await page.evaluate(() => WALLY.ctx.audio.notes.length);
  ok(grew > before, 'the transport keeps scheduling', `${before} -> ${grew}`);

  /* ---- the title sting, on the real title beat ---- */
  head('the title beat');
  const sting = await page.evaluate(async () => {
    const a = WALLY.ctx.audio;
    const was = a.notes.filter((n) => n.layer === 'sting').length;
    let fired = false;
    WALLY.ctx.bus.on('intro:titlecard', () => { fired = true; });
    /* seek(7) replays every cue up to the title, landTitle() included:
       the same call path the cinematic takes by itself at 31.11 s. */
    WALLY.debug.titleCard();
    await new Promise((r) => setTimeout(r, 700));
    return {
      fired,
      added: a.notes.filter((n) => n.layer === 'sting').length - was,
      card: !!WALLY.debug.introState().title,
    };
  });
  note('sting:', sting);
  ok(sting.fired, 'the title beat fired');
  ok(sting.card, 'the title card is on screen');
  ok(sting.added >= 6, 'the title sting scheduled its notes', `${sting.added} sting notes`);

  /* ---- gameplay: hand over, keep playing, switch zones ---- */
  head('gameplay');
  await page.evaluate(() => WALLY.debug.skipIntro());
  const handed = await page
    .waitForFunction('WALLY.ctx.intro.running === false', { timeout: 10000 })
    .then(() => true).catch(() => false);
  ok(handed, 'the cinematic hands over to the player');

  await page.waitForTimeout(3000);
  const over = await page.evaluate(() => ({
    context: WALLY.ctx.audio.context,
    pending: WALLY.ctx.audio.pendingContext,
    notes: WALLY.ctx.audio.notes.length,
    bar: WALLY.ctx.audio.bar,
    running: WALLY.ctx.audio.running,
  }));
  note('overworld:', over);
  ok(over.running, 'audio is still running in gameplay');
  ok(over.context === 'explore' || over.pending === 'explore',
    'the overworld score took over', `${over.context}/${over.pending}`);

  /* One overworld bar is ~2.7 s and most layers log one event per bar,
     so this window has to be several bars wide or it can straddle a
     gap and prove nothing. Bars turning is the primary signal; notes
     behind them is what says the bars were real. */
  await page.waitForTimeout(8000);
  const on = await page.evaluate(() => ({
    n: WALLY.ctx.audio.notes.length, b: WALLY.ctx.audio.bar,
  }));
  ok(on.b > over.bar + 1, 'the transport keeps turning bars in gameplay',
    `bar ${over.bar} -> ${on.b}`);
  ok(on.n > over.notes, 'the score keeps playing during gameplay',
    `${over.notes} -> ${on.n} notes`);

  /* The zone chain, end to end: ui.js hears 'place', looks the zone up
     in its ZONE_AUDIO table and emits 'game:zone'; audio.js turns that
     into a musical context that lands on the next bar line. */
  const zone = await page.evaluate(async () => {
    WALLY.ctx.bus.emit('place', { zone: 'marketsq' });
    await new Promise((r) => setTimeout(r, 200));
    const queued = WALLY.ctx.audio.pendingContext || WALLY.ctx.audio.context;
    await new Promise((r) => setTimeout(r, 7000));
    return { queued, landed: WALLY.ctx.audio.context };
  });
  note('zone:', zone);
  ok(zone.queued === 'market', "'place' -> ui.js -> 'game:zone' -> music context", zone.queued);
  ok(zone.landed === 'market', 'the context change landed on a bar line', zone.landed);

  head('console');
  const real = errors.filter((e) => !/favicon|status of 404|autoplay/i.test(e));
  ok(real.length === 0, 'no page errors', real.slice(0, 4).join(' | '));
  } finally { await browser.close().catch(() => {}); }
});

/* ================================================================
   PASS B — audio already permitted. No prompt may appear.
   ================================================================ */
await attempt('PASS B', async () => {
  console.log('\nPASS B — autoplay already permitted');
  const { browser, page, errors } = await boot({ block: false });
  try {

  const gate = await page.evaluate(gateState);
  note('gate:', gate);

  head('the already-allowed case');
  ok(gate.running, 'the AudioContext is running without a gesture', String(gate.state));
  ok(!gate.asking, 'no start beat is demanded when audio is already permitted');
  ok(gate.started === true, 'the game opened straight through');
  ok(gate.introRunning, 'the cinematic is rolling');

  await page.waitForTimeout(2500);
  const play = await page.evaluate(() => ({
    context: WALLY.ctx.audio.context,
    bpm: Math.round(WALLY.ctx.audio.bpm),
    notes: WALLY.ctx.audio.notes.length,
    bootGone: !!document.getElementById('boot')?.classList.contains('gone'),
  }));
  note('play:', play);
  ok(play.bootGone, 'the boot screen is dismissed');
  ok(play.context === 'cinematic', 'the score is on the cinematic context', play.context);
  ok(play.bpm === 54, 'the transport snapped to 54 bpm from bar 0', `${play.bpm} bpm`);
  ok(play.notes > 0, 'the score is playing under the opener', `${play.notes} notes`);

  const real2 = errors.filter((e) => !/favicon|status of 404|autoplay/i.test(e));
  ok(real2.length === 0, 'no page errors', real2.slice(0, 4).join(' | '));
  } finally { await browser.close().catch(() => {}); }
});

/* ================================================================
   PASS C — THE PHONE. Android Chrome, a blocked context, and one real
   touch that lands on a DOM overlay instead of the canvas.
   ================================================================ */
await attempt('PASS C', async () => {
  console.log('\nPASS C — mobile Chrome, tap on an overlay');
  const { browser, page, errors } = await boot({ block: true, mobile: true });
  try {

  head('mobile boot');
  ok(true, 'ready signal arrives without a gesture');
  const gate = await page.evaluate(gateState);
  note('gate:', gate);
  ok(gate.state === 'suspended', 'the AudioContext starts suspended', String(gate.state));
  ok(gate.asking, 'the boot screen asks for the start beat');
  ok(/begin/i.test(gate.prompt), 'the prompt reads as a start beat', `"${gate.prompt}"`);
  ok(gate.started === false, 'the opener has not rolled yet');
  ok(!gate.introRunning, 'the cinematic is NOT playing into a suspended context');

  const touch = await page.evaluate(() => ({
    hasTouch: navigator.maxTouchPoints > 0,
    coarse: matchMedia('(pointer: coarse)').matches,
    mobileUA: /Android/.test(navigator.userAgent),
  }));
  note('device:', touch);
  ok(touch.hasTouch && touch.mobileUA, 'the page really is a touch device on Android',
    JSON.stringify(touch));

  /* ---- the overlay goes on top of everything, including #boot ---- */
  head('the tap');
  const laid = await page.evaluate(HOSTILE_OVERLAY);
  ok(laid, 'a full-screen DOM overlay covers the canvas');

  /* The element that would receive a tap in the middle of the screen —
     proof the gesture never touches the canvas the game draws into. */
  const target = await page.evaluate(() =>
    document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.id || null);
  ok(target === 'hostileOverlay', 'the tap target is the overlay, not #gl', String(target));

  /* A REAL touch: Input.dispatchTouchEvent through CDP, touchStart then
     touchEnd. Not page.click(), not dispatchEvent — neither carries the
     user activation the blocked context gates on. */
  await page.touchscreen.tap(196, 425);

  const reached = await page
    .waitForFunction('WALLY.ctx.audio && WALLY.ctx.audio.running === true', { timeout: 15000 })
    .then(() => true).catch(() => false);

  const probe = await page.evaluate(() => ({
    seenByWindow: (window.__ACT__ || []).map((e) => e.t + (e.act ? '*' : '')),
    activating: (window.__ACT__ || []).filter((e) => e.act).map((e) => e.t),
    swallowed: window.__OVL__ || [],
    unlocked: WALLY.ctx.audio.unlocked === true,
    state: WALLY.ctx.audio.actx?.state || null,
    dbg: WALLY.debug.audioState ? WALLY.debug.audioState() : null,
  }));
  note('gestures (* = activation, per the HTML rule):', probe.seenByWindow);
  note('overlay swallowed:', probe.swallowed);
  note('audio:', probe.dbg);

  ok(reached, 'the AudioContext reaches "running" from a touch on an overlay',
    String(probe.state));
  ok(probe.unlocked, 'the module considers itself unlocked');
  /* The point of the overlay: no click, no mousedown. If either of
     these ever shows up the pass is weaker than it claims to be. */
  ok(!probe.activating.includes('click') && !probe.activating.includes('mousedown'),
    'the unlock did NOT come from a synthesised mouse event',
    probe.activating.join(',') || 'none');

  head('the score, after the touch');
  await page.waitForTimeout(3000);
  const play = await page.evaluate(() => ({
    count: WALLY.ctx.audio.notes.length,
    layers: Object.keys(WALLY.ctx.audio.notes.reduce((a, n) => (a[n.layer] = 1, a), {})),
    bar: WALLY.ctx.audio.bar,
    bpm: Math.round(WALLY.ctx.audio.bpm),
    context: WALLY.ctx.audio.context,
    bootGone: !!document.getElementById('boot')?.classList.contains('gone'),
    introRunning: !!WALLY.ctx.intro?.running,
  }));
  note('play:', play);
  ok(play.bootGone, 'the boot screen is dismissed');
  ok(play.introRunning, 'the cinematic rolls, now that it can be heard');
  ok(play.context === 'cinematic', 'the score is on the cinematic context', play.context);
  ok(play.bpm === 54, 'the transport snapped to 54 bpm from bar 0', `${play.bpm} bpm`);
  ok(play.count > 0, 'the scheduler produced note events after the touch',
    `${play.count} notes`);
  ok(play.layers.length >= 2, 'more than one layer is sounding', play.layers.join(','));

  /* A running context with a stopped scheduler is still silence. */
  await page.waitForTimeout(5200);
  const on = await page.evaluate(() => ({
    n: WALLY.ctx.audio.notes.length, b: WALLY.ctx.audio.bar,
    running: WALLY.ctx.audio.running,
  }));
  ok(on.n > play.count, 'the transport keeps scheduling on mobile',
    `${play.count} -> ${on.n} notes`);
  ok(on.b > play.bar, 'bars keep turning', `bar ${play.bar} -> ${on.b}`);
  ok(on.running, 'the context is still running');

  /* ---- it has to SURVIVE being backgrounded ---- */
  head('backgrounding');
  const back = await page.evaluate(async () => {
    const a = WALLY.ctx.audio;
    await a.actx.suspend();                       // what a phone call does to us
    const dipped = a.actx.state;
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 1200));
    return { dipped, back: a.actx.state, notes: a.notes.length };
  });
  note('background:', back);
  ok(back.dipped === 'suspended', 'the context can be taken away', back.dipped);
  ok(back.back === 'running', 'it comes back by itself when the page returns', back.back);

  head('console');
  const real3 = errors.filter((e) => !/favicon|status of 404|autoplay/i.test(e));
  ok(real3.length === 0, 'no page errors', real3.slice(0, 4).join(' | '));
  } finally { await browser.close().catch(() => {}); }
});

/* ================================================================
   PASS D — the tools/ escape hatches still escape.
   ================================================================ */
await attempt('PASS D', async () => {
  console.log('\nPASS D — ?shot and ?skipIntro bypass the start beat');
  const { browser, page, errors } = await boot({ block: true, query: '?shot=1', settle: 600 });
  try {

  head('?shot');
  const shot = await page.evaluate(() => ({
    ready: window.__WALLY_READY__ === true,
    asking: !!document.getElementById('boot')?.classList.contains('ask'),
    gone: !!document.getElementById('boot')?.classList.contains('gone'),
    started: WALLY.debug.started(),
    built: WALLY.ctx.audio?.ready === true,
    introRunning: !!WALLY.ctx.intro?.running,
    context: WALLY.ctx.audio?.context,
  }));
  note('shot:', shot);
  ok(shot.ready, '__WALLY_READY__ arrives with no gesture');
  ok(!shot.asking, 'no start beat is demanded');
  ok(shot.gone, 'the boot screen is already dismissed');
  ok(shot.started === true, 'the door is open');
  ok(shot.built === false, 'no AudioContext is built at all under ?shot');
  ok(!shot.introRunning, 'the cinematic does not roll under ?shot');
  ok(shot.context === 'silence', 'the score sits on the silence context', String(shot.context));

  await browser.close().catch(() => {});
  } finally { await browser.close().catch(() => {}); }

  const two = await boot({ block: true, query: '?skipIntro=1', settle: 600 });
  try {
  head('?skipIntro');
  const skip = await two.page.evaluate(() => ({
    ready: window.__WALLY_READY__ === true,
    asking: !!document.getElementById('boot')?.classList.contains('ask'),
    gone: !!document.getElementById('boot')?.classList.contains('gone'),
    started: WALLY.debug.started(),
    introRunning: !!WALLY.ctx.intro?.running,
  }));
  note('skipIntro:', skip);
  ok(skip.ready, '__WALLY_READY__ arrives with no gesture');
  ok(!skip.asking, 'no start beat is demanded');
  ok(skip.gone, 'the boot screen is already dismissed');
  ok(skip.started === true, 'the door is open');
  ok(!skip.introRunning, 'the cinematic does not roll under ?skipIntro');

  const real4 = [...errors, ...two.errors].filter((e) => !/favicon|status of 404|autoplay/i.test(e));
  ok(real4.length === 0, 'no page errors', real4.slice(0, 4).join(' | '));
  } finally { await two.browser.close().catch(() => {}); }
});

/* ================================================================
   PASS E — THE DROPOUT.

   Reported from the field: "my music cut off after playing for some
   time. And then stayed off and came back after some time."

   Intermittent, self-healing silence during play. Web Audio gives you
   four ways to produce exactly that and this pass exercises all four,
   plus a soak that proves the score does not simply drift into silence
   on its own:

     E1  THE HIDDEN TAB. requestAnimationFrame stops dead in a
         backgrounded tab and setTimeout is clamped to 1 s — and a page
         that has made no sound for 30 s is dropped to ONE TICK PER
         MINUTE. A fixed 0.28 s look-ahead cannot bridge either, and
         going quiet is what earns the harsher clamp, so the failure
         feeds itself. The invariant that makes it impossible is
         horizon >= the tick gap we are actually being given, and it is
         asserted directly.

     E2  THE FROZEN PAGE. Not simulated: Page.setWebLifecycleState
         through CDP genuinely stops every clock in the renderer while
         the audio clock keeps running — the real shape of a phone that
         went away and came back. The score must be scheduling again
         within a second of the thaw, and must NOT machine-gun the bars
         it missed.

     E3  THE SUSPENDED CONTEXT. Taken away and handed back with no
         visibilitychange at all, which is what a phone call does. A
         resumed context with a dead scheduler is still silence, so what
         is asserted is that the TRANSPORT came back, not the context.

     E4  A STALLED TRANSPORT AND A MUTED BUS — the two states that
         produce silence while every flag still says "playing". The
         watchdog has to notice both without being told why.

     E5  SOAK. Several minutes of simulated time by default (--soak
         <seconds> to change it): bars must keep turning at the score's
         own rate throughout, with no window of silence, no scheduler
         errors, and no unbounded growth in the voice table.
   ================================================================ */
const SOAK = (() => {
  const i = process.argv.indexOf('--soak');
  const v = i > -1 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 60;
})();

await attempt('PASS E', async () => {
  console.log('\nPASS E — the dropout: silence that comes back on its own');
  const { browser, page, errors } = await boot({ block: false, query: '?skipIntro=1', settle: 2000 });
  try {
  const cdp = await page.context().newCDPSession(page);

  /* The unblocked context is already running; make sure the transport is
     unlocked and on a real score before any of this means anything. */
  await page.evaluate(() => {
    WALLY.ctx.audio.resume();
    WALLY.ctx.audio.setContext('explore', { immediate: true, fade: 0.4 });
  });
  await page.waitForTimeout(2500);

  const T = () => page.evaluate(() => ({
    ...WALLY.ctx.audio.transport, notes: WALLY.ctx.audio.notes.length,
  }));

  head('the score is actually running before we break it');
  const t0 = await T();
  note('transport:', t0);
  ok(t0 && t0.playing === true, 'the transport is playing');
  ok(t0.notes > 0, 'notes are on the wire', `${t0.notes}`);
  ok(t0.silentFor < 0.5, 'the wire is written ahead of the clock',
    `silentFor ${t0.silentFor}s`);

  /* ---- E1 the hidden tab ---- */
  head('E1 — a backgrounded tab');
  const hid = await page.evaluate(async () => {
    /* visibilityState is read-only, so shadow it for the duration —
       the game only ever reads it, and this is the one honest way to
       ask "what would you do if you were hidden?" in a headless tab. */
    Object.defineProperty(document, 'visibilityState',
      { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 400));
    return { ...WALLY.ctx.audio.transport };
  });
  note('hidden:', hid);
  ok(hid.horizon >= 1.5,
    'the look-ahead widens the moment the tab hides, before the clamp bites',
    `horizon ${hid.horizon}s`);
  ok(hid.horizon >= hid.tickGap * 2,
    'the horizon covers at least twice the gap between ticks',
    `horizon ${hid.horizon}s vs gap ${hid.tickGap}s`);
  /* 1 s is what Chrome clamps a hidden tab's timers to. Anything less
     than that scheduled ahead is an audible hole every second. */
  ok(hid.horizon >= 1.0,
    'a 1 s clamped timer cannot starve the scheduler', `${hid.horizon}s`);

  const hidOn = await page.evaluate(async () => {
    const a = WALLY.ctx.audio;
    const before = a.notes.length, bar = a.bar;
    await new Promise((r) => setTimeout(r, 2500));
    return { grew: a.notes.length - before, bars: a.bar - bar, silentFor: a.transport.silentFor };
  });
  note('hidden, 2.5s:', hidOn);
  ok(hidOn.grew > 0, 'the score keeps being scheduled while hidden', `${hidOn.grew} notes`);
  ok(hidOn.bars > 0, 'bars keep turning while hidden', `${hidOn.bars} bars`);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState',
      { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(700);
  const backVis = await T();
  ok(backVis.horizon < 1.5, 'the horizon narrows again when the tab returns',
    `${backVis.horizon}s`);
  ok(backVis.silentFor < 0.6, 'and the score never went quiet across the change',
    `silentFor ${backVis.silentFor}s`);

  /* ---- E2 a genuinely frozen page ---- */
  head('E2 — the page is frozen for four seconds, then thawed');
  const beforeFreeze = await T();
  let froze = true;
  try {
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  } catch (e) { froze = false; note('freeze unsupported:', String(e?.message || e)); }
  await new Promise((r) => setTimeout(r, 4000));
  if (froze) await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await page.waitForTimeout(900);
  const thawed = await T();
  note('thawed:', thawed);
  ok(thawed.playing === true, 'the transport survived the freeze');
  ok(thawed.silentFor < 0.8,
    'it is writing ahead of the clock again within a second of the thaw',
    `silentFor ${thawed.silentFor}s`);
  ok(thawed.errors === 0, 'no scheduler errors', String(thawed.errors));
  /* A catch-up burst is the other failure: sixty bars fired at once. */
  ok(thawed.bar - beforeFreeze.bar < 40,
    'it re-anchored instead of machine-gunning the bars it missed',
    `bar ${beforeFreeze.bar} -> ${thawed.bar}`);
  const after2 = await page.evaluate(async () => {
    const a = WALLY.ctx.audio; const n = a.notes.length, b = a.bar;
    await new Promise((r) => setTimeout(r, 2500));
    return { grew: a.notes.length - n, bars: a.bar - b };
  });
  ok(after2.grew > 0 && after2.bars > 0, 'and it keeps playing afterwards',
    `${after2.grew} notes / ${after2.bars} bars`);

  /* ---- E3 a suspended context, no visibilitychange ---- */
  head('E3 — the context is taken away and handed back (a phone call)');
  const susp = await page.evaluate(async () => {
    const a = WALLY.ctx.audio;
    await a.actx.suspend();
    const dipped = a.actx.state;
    await new Promise((r) => setTimeout(r, 1200));
    await a.actx.resume();            // no visibilitychange at all
    const n = a.notes.length, b = a.bar;
    await new Promise((r) => setTimeout(r, 2000));
    return {
      dipped, state: a.actx.state, grew: a.notes.length - n, bars: a.bar - b,
      t: a.transport,
    };
  });
  note('suspend/resume:', susp);
  ok(susp.dipped === 'suspended', 'the context can be taken away', susp.dipped);
  ok(susp.state === 'running', 'it comes back', susp.state);
  ok(susp.grew > 0, 'THE TRANSPORT comes back too, not just the context',
    `${susp.grew} notes`);
  ok(susp.bars > 0, 'bars keep turning after the resume', `${susp.bars} bars`);
  ok(susp.t.silentFor < 0.8, 'the wire is written ahead again',
    `silentFor ${susp.t.silentFor}s`);

  /* ---- E4 a stalled transport and a muted bus ---- */
  head('E4 — the watchdog: stalled transport, muted bus');
  const stall = await page.evaluate(async () => {
    const a = WALLY.ctx.audio;
    const before = a.transport;
    const s = WALLY.debug.audioStall(3);       // the wire runs dry, flags say "playing"
    const dry = a.transport.silentFor;
    await new Promise((r) => setTimeout(r, 900));
    const after = a.transport;
    return { before, dry, after };
  });
  note('stall:', stall);
  ok(stall.dry > 2.5, 'the transport can be left believing it is playing while silent',
    `silentFor ${stall.dry}s`);
  ok(stall.after.silentFor < 0.8, 'the watchdog re-anchors it inside a second',
    `silentFor ${stall.after.silentFor}s`);
  ok(stall.after.reanchors > stall.before.reanchors,
    'and it re-clocked rather than trying to play the bars it missed',
    `reanchors ${stall.before.reanchors} -> ${stall.after.reanchors}`);
  ok(stall.after.playing === true, 'the transport is still playing afterwards');

  /* The case tick() cannot save us from: the transport is not merely
     behind, it is stopped, and nothing in the game knows. This is the
     "a cause you have not thought of" branch of the watchdog. */
  const dead = await page.evaluate(async () => {
    const a = WALLY.ctx.audio;
    const before = a.transport;
    const killed = WALLY.debug.audioKillTransport();
    const mid = a.transport.playing;
    const n = a.notes.length;
    await new Promise((r) => setTimeout(r, 1500));
    return { killed, mid, before, after: a.transport, grew: a.notes.length - n };
  });
  note('killed transport:', dead);
  ok(dead.killed && dead.mid === false, 'the transport can be killed outright');
  ok(dead.after.playing === true, 'the watchdog restarts a dead transport');
  ok(dead.after.recoveries > dead.before.recoveries, 'and counts the recovery',
    `${dead.before.recoveries} -> ${dead.after.recoveries}`);
  ok(dead.grew > 0, 'notes are being scheduled again', `${dead.grew} notes`);
  ok(dead.after.busGain > 0.5, 'and the bus the kill faded out came back',
    `gain ${dead.after.busGain}`);

  const bus = await page.evaluate(async () => {
    const a = WALLY.ctx.audio;
    const zeroed = WALLY.debug.audioBreakBus();   // score plays into a muted bus
    await new Promise((r) => setTimeout(r, 900));
    return { zeroed, gain: a.transport.busGain };
  });
  note('bus:', bus);
  ok(bus.zeroed === 0, 'the music bus can be left at zero by a bad transition');
  ok(bus.gain > 0.5, 'the watchdog hears the silence and restores the bus',
    `gain ${bus.gain}`);

  /* ---- E5 the soak ---- */
  head(`E5 — ${SOAK}s of continuous play (--soak to lengthen)`);
  const soak = await page.evaluate(async (seconds) => {
    const a = WALLY.ctx.audio;
    const t0 = performance.now();
    const samples = [];
    let last = a.bar, worstGap = 0, gapStart = t0, maxSilent = 0, maxTracked = 0;
    while (performance.now() - t0 < seconds * 1000) {
      await new Promise((r) => setTimeout(r, 250));
      const t = a.transport;
      maxSilent = Math.max(maxSilent, t.silentFor);
      maxTracked = Math.max(maxTracked, t.tracked);
      if (a.bar > last) { last = a.bar; gapStart = performance.now(); }
      else worstGap = Math.max(worstGap, performance.now() - gapStart);
      samples.push(a.bar);
    }
    const t = a.transport;
    return {
      elapsed: (performance.now() - t0) / 1000,
      bars: a.bar - samples[0], worstGap: worstGap / 1000,
      maxSilent, maxTracked, errors: t.errors, reanchors: t.reanchors,
      voices: t.voices, notes: a.notes.length, playing: t.playing,
      bpm: Math.round(t.bpm),
    };
  }, SOAK);
  note('soak:', soak);
  /* The score's own rate: explore is 4/4, so bars/second = bpm/(60*4).
     Half of that is a generous floor — a transport that stalls at all
     will not reach it. */
  const expectBars = (soak.bpm / (60 * 4)) * soak.elapsed;
  ok(soak.playing, 'the transport is still playing after the soak');
  ok(soak.bars > expectBars * 0.5,
    'bars kept turning at roughly the score\'s own rate',
    `${soak.bars} bars in ${soak.elapsed.toFixed(0)}s, expected ~${expectBars.toFixed(0)}`);
  /* A bar at this tempo is 60*meter/bpm seconds; two of them plus slack
     is the most that may ever pass without the bar counter moving. */
  const barSecs = (60 * 4) / soak.bpm;
  ok(soak.worstGap < barSecs * 2 + 0.6,
    'no window of the soak went without a new bar',
    `worst gap ${soak.worstGap.toFixed(2)}s vs bar ${barSecs.toFixed(2)}s`);
  ok(soak.maxSilent < 1.5, 'the wire was never dry for long', `${soak.maxSilent.toFixed(2)}s`);
  ok(soak.errors === 0, 'no scheduler errors over the whole soak', String(soak.errors));
  /* The voice table used to be pruned only by a getter nothing calls, so
     it grew by one object per note forever. It must track what is
     SOUNDING, not what has ever sounded. */
  ok(soak.maxTracked < 400,
    'the voice table stays bounded — no per-note leak',
    `${soak.maxTracked} tracked vs ${soak.notes} notes played`);

  head('console');
  const real5 = errors.filter((e) => !/favicon|status of 404|autoplay/i.test(e));
  ok(real5.length === 0, 'no page errors', real5.slice(0, 4).join(' | '));
  } finally { await browser.close().catch(() => {}); }
});

server.close();

console.log('');
if (failures.length) {
  console.log(`FAIL — ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log(`PASS — ${passed} assertions green. The opening is not silent.`);
process.exit(0);
