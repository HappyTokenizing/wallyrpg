/* GB13-E — ATTACK THE REGISTRATION ASSERTION ITSELF.
   The claim is: RUNTIME wraps the dispatch so syntax cannot hide;
   STATIC scans src/ so an unexecuted path cannot hide; "together they
   are the enumeration." Six shapes, driven. */
import { boot, driver, loadNow, kbState } from './_gb13-lib.mjs';
const say = (id, v, note) => console.log(`${v.padEnd(7)} ${id}  ${note}`);
const b = await boot();
const d = driver(b.page, b.cdp);
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
await b.page.bringToFront(); await d.wait(250);
console.log('BOOT  ' + loadNow('at boot'));

const reset = () => b.page.evaluate(() => { WALLY.debug.kbReset(); return WALLY.debug.kb().violations.length; });
const vio = () => b.page.evaluate(() => WALLY.debug.kb().violations.map(v => v.kind + ':' + v.el));

/* --- E-1: an UNREGISTERED SITE ID, the thing the task asked for --- */
await reset();
const e1 = await b.page.evaluate(() => {
  const before = WALLY.debug.kb().violations.length;
  const ret = WALLY.debug.kbFocus('gb13.brand.new.site', '.w-abtn');
  const a = document.activeElement;
  return { before, after: WALLY.debug.kb().violations.length, ret,
    kinds: WALLY.debug.kb().violations.map(v => v.kind),
    moved: !!(a && a !== document.body) };
});
say('E-1', (e1.after > e1.before && e1.ret === false && !e1.moved) ? 'FINE' : 'BROKEN',
  `a brand-new unregistered site id: recorded=${e1.after - e1.before} kinds=${JSON.stringify(e1.kinds)} `
  + `returned=${e1.ret} focus moved=${e1.moved} — refused AND recorded  (${loadNow()})`);

/* --- E-1b: ...but it only RECORDS. kb.strict would THROW, and
   NOTHING in the tree ever sets kb.strict — not the suite, not ui.js.
   The register is not reachable from WALLY.debug either. --- */
const e1b = await b.page.evaluate(() => WALLY.debug.kb().strict);
say('E-1b', e1b === false ? 'NOTE' : 'FINE',
  `kb.strict = ${e1b}, and there is no hook that sets it: grep finds no assignment in src/ or tools/. `
  + `The "throws in strict mode" half of the register is unreachable code — the assertion is record-only in practice`);

/* --- E-2: the smuggle (runtime-catchable, static-blind) --- */
await reset();
const e2 = await b.page.evaluate(() => WALLY.debug.kbSmuggle('.w-abtn'));
say('E-2', e2.after > e2.before ? 'FINE' : 'BROKEN',
  `computed access through a runtime-built string: ${e2.before} -> ${e2.after} violations — the runtime half holds`);

/* --- E-3: Reflect.apply, and a destructured alias --- */
await reset();
const e3 = await b.page.evaluate(() => {
  const el = document.querySelector('.w-abtn');
  const b0 = WALLY.debug.kb().violations.length;
  Reflect.apply(HTMLElement.prototype.focus, el, [{ preventScroll: true }]);
  const b1 = WALLY.debug.kb().violations.length;
  const { focus } = HTMLElement.prototype; focus.call(el, { preventScroll: true });
  const b2 = WALLY.debug.kb().violations.length;
  return { reflect: b1 - b0, destructured: b2 - b1 };
});
say('E-3', (e3.reflect > 0 && e3.destructured > 0) ? 'FINE' : 'BROKEN',
  `Reflect.apply recorded=${e3.reflect}, destructured alias recorded=${e3.destructured} — both caught, as claimed`);

/* --- E-4: THE HATCH THE GUARD PUBLISHES ON ITSELF.
   installGuard() writes `wrapped.__kbGuard = raw`. Any file in the
   page can take the unwrapped method straight off the prototype. --- */
await reset();
const e4 = await b.page.evaluate(() => {
  const el = document.querySelector('.w-abtn');
  const b0 = WALLY.debug.kb().violations.length;
  const raw = HTMLElement.prototype.focus.__kbGuard;     // published by the guard
  raw.call(el, { preventScroll: true });
  const a = document.activeElement;
  return { has: typeof raw === 'function', delta: WALLY.debug.kb().violations.length - b0,
    landed: a === el, pm: WALLY.debug.kb().playerMoves, ghk: WALLY.debug.kb().gameHasKeyboard };
});
say('E-4', e4.has && e4.delta === 0 && e4.landed ? 'BROKEN' : 'FINE',
  `HTMLElement.prototype.focus.__kbGuard is a PUBLIC property the guard writes on itself: present=${e4.has}, `
  + `focus landed=${e4.landed}, recorded=${e4.delta}. An undeclared focus through the guard's own hatch is `
  + `invisible to the runtime half, and `+"`__kbGuard`"+` contains no `+"`.focus`"+` token so the static half cannot see it either`);

/* --- E-5: A FOCUS WITH NO DISPATCH AT ALL. autofocus on an inserted
   element. The runtime half wraps focus(); nothing calls it. The
   static half greps `.focus`; `.autofocus` does not match that. --- */
await reset();
await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); });
await d.wait(250);
await d.thumb('Jump', 70, 300);                     // player is on his thumbs
const pre5 = await kbState(b.page);
const e5 = await b.page.evaluate(() => {
  const root = WALLY.ctx.ui.touch.controlsRoot;
  const b0 = WALLY.debug.kb();
  const el = document.createElement('button');
  el.autofocus = true; el.className = 'gb13-af'; el.textContent = 'x';
  root.appendChild(el);
  return { before: b0.violations.length, pmBefore: b0.playerMoves, ghkBefore: b0.gameHasKeyboard };
});
await d.wait(200);
const post5 = await b.page.evaluate(() => {
  const k = WALLY.debug.kb();
  const a = document.activeElement;
  document.querySelector('.gb13-af')?.remove();
  return { violations: k.violations.length, pm: k.playerMoves, ghk: k.gameHasKeyboard,
    onIt: a?.className === 'gb13-af' };
});
say('E-5', post5.onIt && post5.violations === e5.before ? 'BROKEN' : (post5.onIt ? 'SUSPECT' : 'FINE'),
  `autofocus on a node inserted into the PAD ROOT: focus landed=${post5.onIt}, violations ${e5.before}->${post5.violations}, `
  + `playerMoves ${e5.pmBefore}->${post5.pm}, gameHasKeyboard ${e5.ghkBefore}->${post5.ghk} `
  + `— counted as THE PLAYER, seen by NEITHER half  (${loadNow()})`);

/* --- E-6: and the same shape as a plain removal, for contrast --- */
await reset();
const e6 = await b.page.evaluate(() => {
  const root = WALLY.ctx.ui.touch.controlsRoot;
  const el = document.createElement('button'); el.className = 'gb13-rm'; root.appendChild(el);
  WALLY.debug.kbFocus('panel.take', '.gb13-rm');
  const pm0 = WALLY.debug.kb().playerMoves;
  el.remove();
  const a = document.activeElement;
  return { pm0, pm1: WALLY.debug.kb().playerMoves, onBody: a === document.body,
    ghk: WALLY.debug.kb().gameHasKeyboard };
});
say('E-6', e6.onBody && e6.pm1 === e6.pm0 ? 'FINE' : 'SUSPECT',
  `the focused node REMOVED: focus dropped to <body>=${e6.onBody}, playerMoves ${e6.pm0}->${e6.pm1} `
  + `— isRealTarget filters <body>, so a dropped focus is correctly not a player move`);

console.log('\nviolations at end: ' + JSON.stringify(await vio()));
console.log('ERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await b.close();
