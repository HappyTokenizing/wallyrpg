/* ============================================================
   kbowner.js — WHO OWNS THE KEYBOARD. One module, one answer, and
   every other file in src is a CALLER of it rather than a
   participant in it.

   THE INVARIANT, and it is the whole file:

     THE KEYBOARD BELONGS TO THE GAME UNLESS THE PLAYER PUT IT ON A
     UI CONTROL THEMSELVES — and a focus arrival that no call site
     DECLARED is, by definition, the player's.

   Read the second clause twice, because it is the part five previous
   rounds did not have. The first clause has been right since round
   one. What kept reopening is that the rule was INFERRED from focus
   events, and `document.activeElement` is a global that the whole UI
   writes to from call sites nobody had counted. Every round produced
   a better inference and every better inference had a hole:

     1  a refused secondary press still focused the button, so the
        next key ran the verb the gate had just refused
     2  a genuine Tab left focus parked forever, so Space belonged to
        that button for the rest of the session
     3  the sheet-close hand-back re-focused a pad button and the pad
        read that as the PLAYER focusing it — one Tab, ever, poisoned
        everything after it
     4  signing the hand-back fixed 3 and ate a Tab pressed inside the
        hand-back's own retry window
     5  yielding the signature when focus had moved fixed 4, and left
        two holes of its own:
          · a Shift-Tab landing on a LIVE element outside the closing
            panel had its destination taken away by the restore — the
            keystroke kept its MEANING and lost its DESTINATION, which
            is the same class of failure as blur() and was rejected in
            about twenty lines of reasoning the first time
          · a dialogue opening inside the retry window looked exactly
            like the player moving focus, so the hand-back went
            unsigned and defect 3 came back for a thumb-only player

   The tell was in round 5's own residual: it said there were
   "exactly two" other focus() call sites in the layer. THERE ARE
   FOUR. Two of them use optional chaining, which is precisely why a
   grep for `.focus(` did not see them. An inference that has to
   enumerate the things that could fool it will always be one call
   site behind the codebase.

   SO NOTHING INFERS ANY MORE. Focus does not move in src except
   through kb.focus(), which names the site doing it and the INTENT
   behind it. The owner then knows, without guessing, which arrivals
   are its own — and everything left over is the player. There is no
   deadline, no element-identity match, no single-use token and no
   race, because the authorisation is the SAME SYNCHRONOUS CALL STACK
   as the focusin it authorises. The old signature's three bounds
   existed to keep a guess from outliving its focus; a call stack
   cannot outlive itself.

   THE THREE INTENTS. They are not decoration — each one is a
   different answer to "what does this focus move say about who the
   player is talking to":

     take     The UI is putting focus somewhere for its OWN reasons:
              a panel root on open, a search box, a dialogue's first
              choice, the boot chip. It says nothing about the player
              choosing a control, so it does not move the routing bit.
     restore  The UI is handing back a place it banked when a modal
              opened. Also says nothing: it is the player's OLD
              position being returned, not a new choice. This is what
              round 3 got wrong by having no way to say it.
     adopt    The UI is carrying a focus THE PLAYER PERFORMED out of
              a node that is about to be removed. It is still their
              choice, so it DOES move the routing bit — the keystroke
              keeps its meaning even though its node did not survive.

   WHAT IS PRESERVED, AND ASSERTED RATHER THAN ASSUMED:

     · focus is NEVER taken from the player. blur() is not used here
       and the guard below RECORDS any blur() anywhere in the page, so
       "we do not blur" is a measurement and not a promise.
     · a genuine Tab then Space activates the button. An unauthorised
       arrival is the player's, and Tab is unauthorised by definition.
     · a screen-reader ROTOR gesture moves focus with no DOM input
       event at all. Nothing here consults an input event, so the
       rotor is indistinguishable from Tab — which is the correct
       answer, not a lucky one.
     · isTrusted is TRUE for a scripted focus() (measured, byte
       identical to a real Tab). Never consulted.
     · the last input event's type cannot express the rule: at a
       keyboard activation the last trusted input IS the activating
       keystroke. Never consulted.
     · a sheet still hands focus back on close. The one case that now
       does NOT is the case where handing it back would DESTROY a
       place the player chose for themselves and that is going to
       survive — see survives() at the call site in ui.js.

   THE REGISTRATION ASSERTION, which is worth more than any of the
   six fixes because it is the thing that stops a seventh round.
   Two halves, and they fail in different ways on purpose:

     RUNTIME   HTMLElement.prototype.focus (and SVGElement's, and
               blur on both) is wrapped. A call that arrives without
               an authorisation on the stack is recorded with its
               stack trace. It cannot be defeated by optional
               chaining, computed access, an alias, Reflect.apply or
               a file this agent does not own, because it intercepts
               the DISPATCH and not the syntax.
     STATIC    tools/touchtest.mjs strips comments and strings from
               every file in src/ and fails if the identifier `focus`
               is used in a call or alias position anywhere except
               this file. That half catches a new call site that the
               suite never happens to execute.

   Runtime alone misses the unexecuted path; static alone misses the
   alias. Together they are the enumeration.

   THE RESIDUAL, STATED PLAINLY, BECAUSE THE LAST FIVE ROUNDS EACH
   HAD ONE AND ONLY THE LAST ONE WROTE IT DOWN. The authorisation is
   the call stack, so anything that moves focus SYNCHRONOUSLY from
   inside a focusin or focusout handler that fires during kb.focus()
   would inherit that authorisation and be read as the UI's. Nothing
   in src does this, and KB-3 proves it structurally — there is no
   raw focus() left in the tree to do it with — but a future handler
   that reaches for one would be the shape to look at first. It is a
   strictly smaller hole than round 5's, whose signature could be
   inherited by any focus within 50 ms rather than only by one inside
   the same synchronous call.

   THE COMPLETE CALL SITE LIST is SITES below — six physical calls
   carrying seven declared intents, one of the six being a debug-only
   forwarder that carries no site of its own. A site id that is not
   in the register throws in strict mode and is recorded otherwise.
   ============================================================ */

/* ------------------------------------------------------------
   THE REGISTER. Every focus move src is allowed to perform.

   THE COMPLETE CALL SITE LIST, and this time it is complete because
   it is asserted from both ends rather than counted by hand. SIX
   physical kb.focus() calls carry SEVEN declared intents:

     src/ui/ui.js:668        attemptHandBack — panel.take on an open,
                             panel.restore on a faithful close,
                             panel.adopt when the player's own
                             destination is dying. One call, three
                             intents, decided at the attempt that
                             lands because the hand-back retries for
                             up to six frames.
     src/ui/ui.js:1153       openQuickBuy, the ticker box       (take)
     src/ui/menus.js:648     the ✕ in the search field          (take)
     src/ui/dialogue.js:189  the first choice                   (take)
     src/main.js:543         the "press any key" chip           (take)
     src/ui/ui.js:1958       WALLY.debug.kbFocus — a debug-only
                             forwarder that carries NO site of its
                             own. It cannot widen the register: it
                             passes the caller's site id straight
                             through, so an unknown one is recorded
                             (or throws under kb.strict) exactly as
                             it would anywhere else. Listed because
                             a call site nobody wrote down is how the
                             last five rounds went.

   The last four of the five product sites are the ones round 5
   counted as two. dialogue.js and main.js reach the method through
   optional chaining, which is precisely why a grep for `.focus(`
   returned two — and main.js is not in the ui layer at all.

   File and line above are for a reader. Neither is trusted by a
   test: KB-3 re-derives every one of them off disk, and KB-4 catches
   anything the file scan cannot see.
   ------------------------------------------------------------ */
export const SITES = {
  /* ui.js — the panel stack's one focus() call, in attemptHandBack().
     It carries three intents because the same retry loop serves an
     open, a close and the close's player-adoption branch. */
  'panel.take':      { file: 'src/ui/ui.js',        fn: 'attemptHandBack (from pushSheet)',   intent: 'take' },
  'panel.restore':   { file: 'src/ui/ui.js',        fn: 'attemptHandBack (from releaseFocus)', intent: 'restore' },
  'panel.adopt':     { file: 'src/ui/ui.js',        fn: 'attemptHandBack (dying destination)', intent: 'adopt' },
  /* ui.js — openQuickBuy puts the caret in the ticker box. */
  'sheet.input':     { file: 'src/ui/ui.js',        fn: 'openQuickBuy',                        intent: 'take' },
  /* menus.js — the ✕ inside the search field puts the caret back. */
  'menus.clear':     { file: 'src/ui/menus.js',     fn: 'quickBuy Clear button',               intent: 'take' },
  /* dialogue.js — first choice takes focus so Enter picks it.
     OPTIONAL CHAINING, which is why four rounds counted it as zero. */
  'dialogue.choice': { file: 'src/ui/dialogue.js',  fn: 'showChoices',                         intent: 'take' },
  /* main.js — the "press any key" chip. OPTIONAL CHAINING, same. */
  'boot.chip':       { file: 'src/main.js',         fn: 'ask',                                 intent: 'take' },
};

const INTENTS = new Set(['take', 'restore', 'adopt']);

/* ------------------------------------------------------------
   state
   ------------------------------------------------------------ */
/** Depth of an in-flight authorised focus(). focusin is dispatched
    SYNCHRONOUSLY inside focus() (measured on this project), so this
    is non-zero for exactly the arrival it authorises and for nothing
    else. No deadline, no identity match, no single use — a call
    stack cannot outlive itself. */
let authorising = 0;
/** The intent of the authorisation currently in flight. */
let authIntent = null;
/** The site id of the authorisation currently in flight. */
let authSite = null;

/** Roots whose controls, when the PLAYER focuses one, mean the
    player is talking to the interface rather than to the game. The
    pad registers itself; nothing else does, deliberately — see
    WHY THE BLAST RADIUS STAYS SMALL below. */
const regions = [];
/* THE ROUTING BIT, AND ITS BOOT VALUE IS NOT AN ACCIDENT.

   false is "the player has made no claim on the keyboard with their
   thumbs since the last time they focused a control". A detail-0
   click on a pad button ALREADY implies focus is on that button, and
   at boot nothing but the player could have put it there — so the
   assistive path is honoured from the first frame, which is PAD-30
   and predates all of this.

   It is `driving` from src/ui/touch.js, moved here whole and given a
   name that says what it decides rather than what set it. Nothing
   about its transitions has changed; what changed is that only this
   module can see the events that move it. */
let gameHasKeyboard = false;
/** Monotonic count of focus arrivals this owner did NOT authorise.
    Document-wide, unlike playerOnControls. */
let playerMoves = 0;
/** The last element the player focused themselves, live or not. */
let lastPlayerEl = null;

const listeners = [];

/* ============================================================
   WHY THE BLAST RADIUS STAYS SMALL, AND WHY IT IS TWO NUMBERS AND
   NOT ONE.

   Round 5 rejected widening the pad's focusin rule beyond its own
   root, and it was right to: giving every focus anywhere in the
   document a say in the pad's routing puts panel knowledge in the
   pad and makes every sheet, every input and every dialogue a
   participant in whether Space jumps.

   But the panel layer's YIELD decision genuinely needs a
   document-wide fact — "did the player move focus while this
   hand-back was in flight, and where to" — and inferring that from
   activeElement identity is exactly what broke on the dialogue.

   So there are two readings and they have different scopes:

     gameHasKeyboard   narrow. Only a player focus INSIDE a
                       registered control region clears it, and only
                       a direct contact on the pad sets it. This is
                       the pad's routing bit, and it is `driving`
                       moved here unchanged.
     playerMoves       document-wide, and a COUNTER rather than a
                       comparison, so a move that lands back on the
                       element it started from still counts. It
                       answers "who", which activeElement never could.

   One rule, two questions, no new participants.
   ============================================================ */

const isEl = (x) => !!x && typeof x === 'object' && x.nodeType === 1;
const doc = () => (typeof document !== 'undefined' ? document : null);

/** <body> and <html> are where focus SITS when it has been DROPPED —
    the node went, or the target was display:none. Round 5 measured
    what happens when a bare <body> counts as "somebody moved it":
    every hand-back goes unsigned and defect 3 returns. It is not a
    player move and it never was. */
function isRealTarget(el) {
  const d = doc();
  if (!isEl(el) || !d) return false;
  return el !== d.body && el !== d.documentElement;
}

/* ------------------------------------------------------------
   THE GUARD. It wraps the DISPATCH, so syntax cannot hide from it.
   ------------------------------------------------------------ */
const violations = [];
const rawOf = new Map();          // proto -> { focus, blur }
let guardOn = false;
let warned = false;

function record(kind, el, extra) {
  if (violations.length > 64) return;             // bounded; a leak is not a report
  let where = '';
  try { where = String(new Error().stack || '').split('\n').slice(2, 7).join('\n'); } catch (e) {}
  violations.push({
    kind,
    el: describe(el),
    site: extra || null,
    stack: where,
    at: typeof performance !== 'undefined' ? +performance.now().toFixed(1) : 0,
  });
  if (!warned) {
    warned = true;
    try {
      console.warn('[kbowner] an undeclared focus/blur reached the DOM — '
        + 'every focus move in src must go through kb.focus(site, el). '
        + 'See WALLY.debug.kb().violations', violations[0]);
    } catch (e) {}
  }
}

function describe(el) {
  if (!isEl(el)) return String(el);
  const label = el.getAttribute?.('aria-label');
  return (el.tagName || '?') + (label ? `[${label}]` : (el.className ? '.' + String(el.className).split(/\s+/)[0] : ''));
}

function installGuard() {
  if (guardOn || typeof globalThis === 'undefined') return false;
  const protos = [globalThis.HTMLElement, globalThis.SVGElement, globalThis.MathMLElement]
    .filter(Boolean).map((C) => C.prototype);
  let any = false;
  for (const P of protos) {
    const store = { focus: null, blur: null };
    for (const name of ['focus', 'blur']) {
      const d = Object.getOwnPropertyDescriptor(P, name);
      if (!d || typeof d.value !== 'function' || d.value.__kbGuard) continue;
      const raw = d.value;
      store[name] = raw;
      /* NOT an arrow, and not rest-spread into apply for the hot
         path: `this` is the element and the argument is the options
         bag. */
      const wrapped = function kbGuarded(...args) {
        if (name === 'blur') {
          /* blur() DESTROYS A SCREEN-READER PLAYER'S PLACE IN THE
             DOCUMENT. It was rejected in round 2 in about twenty
             lines and it has stayed rejected. Recording it here is
             how "we never blur" stops being a promise: the suite
             drives every UI path and asserts this list is empty. */
          record('blur', this);
        } else if (!authorising) {
          record('focus', this);
        }
        return raw.apply(this, args);
      };
      wrapped.__kbGuard = raw;
      Object.defineProperty(P, name, { ...d, value: wrapped });
      any = true;
    }
    rawOf.set(P, store);
  }
  guardOn = any;
  return any;
}

/** The unwrapped focus, so this module's own call is not a violation
    even if the guard is on. Falls back to the (wrapped) method when
    the guard never installed. */
function rawFocus(el, opts) {
  let p = Object.getPrototypeOf(el);
  while (p) {
    const store = rawOf.get(p);
    if (store && store.focus) return store.focus.call(el, opts);
    p = Object.getPrototypeOf(p);
  }
  return el.focus(opts);
}

/* ------------------------------------------------------------
   THE ARRIVAL LISTENER — the one place that decides whose focus
   this was. Capture phase, on document, installed at module load,
   which is BEFORE any UI layer exists: it therefore sees every
   arrival including the ones during boot.
   ------------------------------------------------------------ */
function onFocusIn(e) {
  const target = e.target;
  /* AUTHORISED means this owner is the one moving it, and `adopt` is
     the one authorised intent that still counts as the player: it is
     the UI carrying a choice the player already made out of a node
     that is being removed. */
  const mine = authorising > 0;
  const player = !mine || authIntent === 'adopt';
  const site = mine ? authSite : null;

  if (player && isRealTarget(target)) {
    playerMoves++;
    lastPlayerEl = target;
    /* THE ONE LINE THE WHOLE RULE LIVES ON. The player put the
       keyboard on a control, so the next Space belongs to that
       control and not to the game.

       A `take` or a `restore` landing on the same button does NOT
       reach this line — that is defect 3, and it is now one boolean
       in a call stack rather than a signature with three bounds and
       a fourth one that could not live in the file that needed it. */
    if (regions.some((r) => r.isConnected && r.contains(target))) gameHasKeyboard = false;
  }
  for (const fn of listeners) {
    try { fn({ target, player, site, intent: mine ? authIntent : null }); } catch (err) {}
  }
}

if (typeof document !== 'undefined') {
  installGuard();
  document.addEventListener('focusin', onFocusIn, true);
}

/* ------------------------------------------------------------
   the public owner
   ------------------------------------------------------------ */
export const kb = {
  SITES,

  /** THE ONLY WAY ANYTHING IN src MOVES FOCUS.
      @param site  a key of SITES. Anything else is a bug, loudly.
      @param el    the element to focus. Falsy is a no-op, so callers
                   keep their optional chaining ergonomics without
                   losing the declaration.
      @param opts  passed straight through ({ preventScroll: true }).
      @returns     true if focus() was actually called. */
  focus(site, el, opts) {
    const spec = SITES[site];
    if (!spec) {
      record('unknown-site', el, site);
      if (kb.strict) throw new Error(`[kbowner] undeclared focus site "${site}" — add it to SITES in src/ui/kbowner.js`);
      return false;
    }
    if (!isEl(el)) return false;
    const intent = spec.intent;
    if (!INTENTS.has(intent)) { record('bad-intent', el, site); return false; }
    authorising++;
    authIntent = intent;
    authSite = site;
    try {
      rawFocus(el, opts);
    } catch (err) {
      /* focus() on a detached or display:none node is a silent no-op
         in Chrome, not a throw — but a caller must never be broken by
         this layer, so it is contained anyway. */
    } finally {
      authorising--;
      if (!authorising) { authIntent = null; authSite = null; }
    }
    return true;
  },

  /** Can this element take the keyboard at all? The one member read
      of `focus` left in the layer, kept HERE so the static half of
      the registration assertion can be absolute: the identifier
      `focus` in a member position anywhere in src outside this file
      is a failure, with no exemption list to keep up to date. */
  canFocus(el) { return isEl(el) && typeof el.focus === 'function'; },

  /** THE PAD, AND ONLY THE PAD, registers itself. An unauthorised
      focus landing inside `root` is the player choosing to talk to
      the interface. */
  ownControls(root) {
    if (isEl(root) && !regions.includes(root)) regions.push(root);
    return () => {
      const i = regions.indexOf(root);
      if (i >= 0) regions.splice(i, 1);
    };
  },

  /** Read-only: does the next keystroke belong to the GAME? True
      only while the player is demonstrably driving with their thumbs
      and has not since put the keyboard on a control themselves.
      This is the one question the pad's Space rule asks, and the pad
      may only READ it. */
  get gameHasKeyboard() { return gameHasKeyboard; },

  /** The player picked the game up: a thumb on the stick, on Jump,
      on a shortcut that fired, or on the canvas. The keyboard goes
      back to the GAME without anything being blurred, because where
      focus SITS and who it BELONGS TO are different questions and
      only the second one moves here. */
  playing() { gameHasKeyboard = true; },

  /** A token for "the state of the player's focus right now". */
  mark() {
    const d = doc();
    return { n: playerMoves, at: d ? d.activeElement : null };
  },
  /** Has the PLAYER moved focus since `m`, and where to?
      `to` is null when their destination is not a real element —
      dropped focus is not a move, see isRealTarget. */
  movedSince(m) {
    if (!m) return { moved: false, to: null };
    const moved = playerMoves > m.n;
    const d = doc();
    const a = d ? d.activeElement : null;
    return { moved, to: moved && isRealTarget(a) ? a : null };
  },

  /** Subscribe to arrivals: ({ target, player, site, intent }). */
  onFocus(fn) {
    listeners.push(fn);
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  },

  /** Throw instead of recording. The suite turns this on; shipping
      leaves it off so a stray focus in somebody else's module is a
      failed assertion and not a dead game. */
  strict: false,

  /** THE ASSERTION SURFACE. `violations` empty is the claim; it is
      driven by tools/touchtest.mjs after every UI path in the game
      has been exercised. `sites` lets the static half cross-check
      that the register and the code agree. */
  report() {
    return {
      guard: guardOn,
      violations: violations.map((v) => ({ ...v })),
      sites: Object.keys(SITES),
      regions: regions.length,
      gameHasKeyboard,
      playerMoves,
      lastPlayer: describe(lastPlayerEl),
      strict: kb.strict,
    };
  },
  /** Test support only. */
  _reset() { violations.length = 0; warned = false; playerMoves = 0; gameHasKeyboard = false; lastPlayerEl = null; },
  /** Test support only: prove the guard actually catches an
      undeclared call. See THE REVERT CHECK in tools/touchtest.mjs. */
  _smuggle(el) {
    if (!isEl(el)) return false;
    /* deliberately NOT through kb.focus, and deliberately through a
       shape a grep for `.focus(` cannot see */
    const m = 'fo' + 'cus';
    el?.[m]?.({ preventScroll: true });
    return true;
  },
};

export default kb;
