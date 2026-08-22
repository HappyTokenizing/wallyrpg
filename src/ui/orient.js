/* ============================================================
   orient.js — LANDSCAPE PLAY, the optional one.

   Portrait is the game. This is the switch in Settings for the
   player who went looking for it, and every line of this file exists
   because there is no single API that rotates a phone.

   ------------------------------------------------------------
   WHAT ACTUALLY ROTATES A SCREEN
   ------------------------------------------------------------
   `screen.orientation.lock('landscape')` is the mechanism, and every
   engine that implements it only permits it while the document is
   FULLSCREEN. So the sequence is: requestFullscreen() on the tap,
   lock() when it resolves — both hanging off the one gesture. That
   is why setEnabled() must be reached straight out of a click
   handler with nothing awaited in front of it, and why apply()
   issues requestFullscreen() before its first `await`. Put one
   yield in front of that call and the browser refuses, silently.

   ------------------------------------------------------------
   WHERE IT CANNOT WORK — SAY SO, DO NOT PRETEND
   ------------------------------------------------------------
   iOS Safari has no `screen.orientation.lock` at all, and no element
   fullscreen (only <video> goes fullscreen there). An iPhone cannot
   be turned by a web page, full stop. So `mode` is capability-tested
   rather than sniffed, and where it comes back 'manual' the settings
   row drops the switch entirely and prints the honest instruction
   instead. A switch that silently does nothing is worse than no
   switch — and the instruction is only honest because the LAYOUT
   work landed too: turn the phone by hand and the game lays itself
   out for landscape, because ui/style.js triggers on the viewport,
   never on this preference.

   ------------------------------------------------------------
   WHAT TAKES THE LOCK AWAY AGAIN
   ------------------------------------------------------------
   Leaving fullscreen (a swipe, a back gesture, the OS), a
   backgrounded tab, and the phone's own rotation lock. None of them
   announce themselves, and none of them can be undone without a
   fresh user gesture — a lock is not re-takeable from a timer. So:
   watch fullscreenchange and visibilitychange, drop `locked` the
   instant it stops being true, and arm exactly ONE re-apply on the
   next real gesture. status() is the whole truth and the row reads
   it every time it changes, so the interface never claims a state
   this module is not in.

   THE SECOND ESCAPE IS AN ANSWER. Re-arming forever turns a
   deliberate swipe out of fullscreen into a fight with the player,
   so a second exit while the re-apply is still fresh switches the
   preference off and says so out loud.
   ============================================================ */

/* A phone-shaped thing. The row is for handhelds and nothing else:
   a desktop must not grow an option to rotate a monitor.

   Two ways in, because neither alone is enough. A real phone reports
   a coarse primary pointer AND touch points (the same test touch.js
   uses to decide it is worth drawing a thumbstick). A phone-shaped
   VIEWPORT counts too — that is a headless capture rig, a device
   emulator, or a desktop window dragged down to a phone's width, and
   in every one of those cases the landscape layout is the thing on
   screen so the option should be reachable. Both are wrong on a
   1600x900 desktop, which is the point. */
export function isHandheld() {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(location.search).get('handheld');
  if (q === '1' || q === 'on') return true;
  if (q === '0' || q === 'off') return false;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const points = (navigator.maxTouchPoints | 0) > 0 || 'ontouchstart' in window;
  if (coarse && points) return true;
  return Math.min(innerWidth, innerHeight) <= 560;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function createOrient(ctx, ui) {
  const el = document.documentElement;
  const so = (typeof screen !== 'undefined' && screen.orientation) || null;

  const canFS = !!(el.requestFullscreen || el.webkitRequestFullscreen);
  const canLock = !!(so && typeof so.lock === 'function');
  /* 'lock'   — the page can hold the phone sideways itself
     'manual' — it cannot, and the row says so (iOS Safari lives here) */
  const mode = canFS && canLock ? 'lock' : 'manual';
  const handheld = isHandheld();

  let locked = false;
  let ourFS = false;          // WE opened fullscreen, so WE may close it
  let why = mode === 'lock' ? '' : 'manual';
  let exits = 0;              // fullscreen escapes since the last good lock
  let lastApply = 0;
  let armed = null;
  let wasLandscape = false;

  const subs = new Set();
  const off = [];

  /* The preference lives in the save, not here — one source of
     truth, already persisted and migrated (game/save.js). */
  const S = () => ctx.game?.state?.settings || null;
  const want = () => !!S()?.landscape;

  /* THE VIEWPORT, NOT THE SCREEN. screen.orientation.type describes
     the DISPLAY: on a desktop browser with a 390-wide window it
     cheerfully answers 'landscape-primary', which had the row telling
     a portrait phone-sized viewport it was already sideways. The
     question this module is actually asked is "is the game laid out
     for landscape right now", and the thing that decides that is the
     media query in ui/style.js — so ask the same question it does. */
  function isLandscape() {
    if (typeof matchMedia === 'function') return matchMedia('(orientation: landscape)').matches;
    return innerWidth >= innerHeight;
  }
  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }

  /* ------------------------------------------------------------
     the truth, in one object
     ------------------------------------------------------------ */
  function status() {
    return {
      mode, handheld, want: want(), locked,
      fullscreen: !!fsEl(), landscape: isLandscape(), why,
    };
  }
  function emit() {
    const s = status();
    for (const fn of [...subs]) { try { fn(s); } catch (e) { /* a listener must not break the lock */ } }
    try { ctx.bus?.emit?.('orient', s); } catch (e) {}
    return s;
  }
  function onChange(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  /* ------------------------------------------------------------
     fullscreen, prefixes and all
     ------------------------------------------------------------ */
  function requestFS() {
    try {
      if (el.requestFullscreen) return Promise.resolve(el.requestFullscreen({ navigationUI: 'hide' }));
      if (el.webkitRequestFullscreen) { el.webkitRequestFullscreen(); return Promise.resolve(); }
    } catch (e) { return Promise.reject(e); }
    return Promise.reject(new Error('no fullscreen'));
  }
  function exitFS() {
    if (!fsEl()) return;
    try {
      if (document.exitFullscreen) { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}); }
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } catch (e) {}
  }
  function tryLock() {
    try {
      const r = so.lock('landscape');
      return r && typeof r.then === 'function' ? r : Promise.resolve();
    } catch (e) { return Promise.reject(e); }
  }

  /* ------------------------------------------------------------
     apply / release

     apply() MUST be called synchronously from the gesture. Its first
     statement that touches the browser is requestFS(); everything
     after it hangs off that promise, which is what keeps the lock
     inside the same activation.
     ------------------------------------------------------------ */
  function apply() {
    if (mode !== 'lock' || !want()) return Promise.resolve(emit());
    lastApply = now();
    disarm();
    let p;
    if (fsEl()) p = Promise.resolve();
    else { ourFS = true; p = requestFS(); }
    return p.then(() => lockLandscape(), () => fail('nofullscreen'));
  }

  function lockLandscape() {
    return tryLock().then(
      () => { locked = true; why = ''; exits = 0; return emit(); },
      /* The phone said no — its own rotation lock, or an engine that
         has lock() but will not take 'landscape'. */
      () => fail('refused'),
    );
  }

  /* A REFUSAL PUTS THE SWITCH BACK. `on` has one meaning — the game
     is being held sideways — so leaving it lit after the browser
     said no is the dead toggle this whole file exists to avoid. The
     preference goes back to false and does not persist as true; the
     REASON survives in `why`, which is what the row prints, so the
     player gets an explanation and an obvious second attempt rather
     than a switch that sits there lying. And nobody is left stranded
     in a fullscreen we opened for a rotation that never happened. */
  function fail(reason) {
    const s = S();
    if (s) s.landscape = false;
    locked = false;
    why = reason;
    disarm();
    if (ourFS) { ourFS = false; exitFS(); }
    return emit();
  }

  function release() {
    disarm();
    locked = false;
    why = mode === 'lock' ? '' : 'manual';
    exits = 0;
    try { if (so && so.unlock) so.unlock(); } catch (e) {}
    if (ourFS) { ourFS = false; exitFS(); }
    return Promise.resolve(emit());
  }

  /* the player has answered by leaving twice — stop arguing */
  function quit(msg) {
    const s = S();
    if (s) s.landscape = false;
    release();
    try { ui?.toast?.(msg, 'info'); } catch (e) {}
    return emit();
  }

  /* ------------------------------------------------------------
     ONE re-apply, on the next real gesture. A lock cannot be retaken
     without one, so this is the only honest way back.
     ------------------------------------------------------------ */
  function arm() {
    if (armed || mode !== 'lock') return;
    const go = () => { disarm(); if (want()) apply(); };
    armed = go;
    addEventListener('pointerdown', go, true);
    addEventListener('touchend', go, true);
    addEventListener('keydown', go, true);
  }
  function disarm() {
    if (!armed) return;
    removeEventListener('pointerdown', armed, true);
    removeEventListener('touchend', armed, true);
    removeEventListener('keydown', armed, true);
    armed = null;
  }

  /* ------------------------------------------------------------
     the three things that steal the lock
     ------------------------------------------------------------ */
  function onFsChange() {
    if (fsEl()) {
      if (want() && mode === 'lock' && !locked) { lockLandscape(); return; }
    } else {
      ourFS = false;
      locked = false;
      if (want() && mode === 'lock') {
        exits++;
        if (exits >= 2 && now() - lastApply < 6000) {
          quit('Landscape play is off. Turn it back on in Settings.');
          return;
        }
        why = 'waiting';
        arm();
      }
    }
    emit();
  }
  function onVis() {
    if (document.visibilityState !== 'visible') return;
    /* A backgrounded tab loses the lock without a fullscreenchange on
       some builds, so re-arm on the way back rather than trusting it. */
    if (want() && mode === 'lock' && !fsEl()) { locked = false; why = 'waiting'; arm(); }
    emit();
  }
  function onFlip() {
    const l = isLandscape();
    if (l === wasLandscape) return;
    wasLandscape = l;
    emit();
  }

  function bind(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    off.push(() => target.removeEventListener(type, fn, opts));
  }
  bind(document, 'fullscreenchange', onFsChange);
  bind(document, 'webkitfullscreenchange', onFsChange);
  bind(document, 'visibilitychange', onVis);
  bind(window, 'resize', onFlip);
  bind(window, 'orientationchange', onFlip);
  if (so && so.addEventListener) bind(so, 'change', onFlip);

  /* ------------------------------------------------------------
     boot — the preference survived, the lock did not

     A saved `landscape: true` cannot be honoured on load: there has
     been no gesture yet. Arm one instead, so the very first tap the
     player makes (the boot start chip, most likely) takes the lock
     back. Nothing here claims to be locked in the meantime.
     ------------------------------------------------------------ */
  function boot() {
    wasLandscape = isLandscape();
    if (want() && mode === 'lock') { why = 'waiting'; arm(); }
    return emit();
  }

  /* ------------------------------------------------------------
     the public object
     ------------------------------------------------------------ */
  return {
    /** 'lock' — the page can hold it sideways. 'manual' — it cannot. */
    mode,
    /** Is this a phone-shaped thing at all? The row is gated on it. */
    handheld,
    boot, status, onChange,
    /** Flip the preference. MUST be called inside a user gesture. */
    setEnabled(on) {
      on = !!on;
      const s = S();
      if (s) s.landscape = on;
      exits = 0;
      if (!on) return release();
      if (mode !== 'lock') { why = 'manual'; return Promise.resolve(emit()); }
      return apply();
    },
    get want() { return want(); },
    get locked() { return locked; },
    get landscape() { return isLandscape(); },
    dispose() {
      disarm();
      for (const f of off) f();
      subs.clear();
      if (ourFS) { ourFS = false; exitFS(); }
    },
  };
}

export default createOrient;
