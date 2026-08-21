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
   tools/ escape flags, and runs two passes.

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

   Both passes also assert __WALLY_READY__ arrives without a gesture,
   because every tool in tools/ waits on it.

       node tools/audiotest.mjs
       node tools/audiotest.mjs --verbose

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
async function attempt(label, fn, tries = 3) {
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

   So pass A installs the policy itself, before any page script runs:
   an AudioContext that is born suspended and whose resume() returns a
   promise that NEVER SETTLES until the page holds real user
   activation, which is exactly what Chrome does to a blocked context.
   The gate is navigator.userActivation.isActive, so a page-side
   dispatchEvent still cannot unlock it — only a trusted gesture can.
   The game sees an ordinary blocked context and has to cope. */
async function installAutoplayBlock(page) {
  await page.addInitScript(() => {
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
        const active = !!navigator.userActivation?.isActive;
        if (!active) return new Promise(() => {});   // hangs, like the real thing
        this.__blocked = false;
        return super.resume();
      }
    }
    window.AudioContext = Blocked;
    window.webkitAudioContext = Blocked;
  });
}

/* --mute-audio only silences the output device; the context still runs
   and the scheduler still schedules, which is what we measure. */
async function boot({ block = false } = {}) {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('crash', () => errors.push('[renderer crashed]'));
  if (block) await installAutoplayBlock(page);

  /* NO ?shot and NO ?skipIntro — this is how a player loads the game. */
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
  /* Let openTheDoor()'s resume() probe finish its 400 ms race. */
  await page.waitForTimeout(1400);
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

server.close();

console.log('');
if (failures.length) {
  console.log(`FAIL — ${failures.length} failed, ${passed} passed`);
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log(`PASS — ${passed} assertions green. The opening is not silent.`);
process.exit(0);
