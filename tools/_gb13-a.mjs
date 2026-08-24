/* GB13-A — ATTACK THE ENUMERATION. A focus move NOBODY AUTHORED.
   The register enumerates every focus() call in src. It cannot
   enumerate a focus move the BROWSER performs: returning to the tab,
   Chrome re-focuses the element that had the keyboard and dispatches
   focusin with no focus() on the stack. kbowner's rule says an
   arrival it did not authorise IS THE PLAYER. It was not. */
import { boot, driver, loadNow, kbState, tabAway } from './_gb13-lib.mjs';
import { clock, readClock, fmt, mark } from './_gb13-lib.mjs';

const R = [];
const say = (id, v, note) => { R.push(`${v.padEnd(7)} ${id}  ${note}`); console.log(`${v.padEnd(7)} ${id}  ${note}`); };

const b = await boot();
const d = driver(b.page, b.cdp);
await clock(b.page);
console.log('BOOT  ' + loadNow('at boot'));

async function arm() {
  await b.page.evaluate(() => { WALLY.debug.kbReset(); WALLY.ctx.ui.closeAll(); });
  await d.wait(300);
}

/* ---- the setup: the documented "tabbed once, then thumbs" player.
   Tab to a pad button (the player's own choice -> the pad owns Space),
   then pick the game up with a thumb (-> the game owns Space again).
   Focus is deliberately LEFT on the button; this design never blurs. */
await arm();
const menu = await d.tabTo('Menu');
if (!menu) { console.log('SETUP FAILED: could not Tab to Menu'); await b.close(); process.exit(2); }
const afterTab = await kbState(b.page);
await d.thumb('Jump', 70, 320);
const afterThumb = await kbState(b.page);
say('A-pre', afterThumb.driving && afterThumb.padFocused && !afterThumb.padTakesSpace ? 'OK' : 'SETUP',
  `tabbed-once-then-thumbs: driving=${afterThumb.driving} focus="${afterThumb.focus}" padTakesSpace=${afterThumb.padTakesSpace} (${loadNow()})`);

await readClock(b.page);
await mark(b.page, 'TAB AWAY');
await tabAway(b.page, b.ctxM);
await mark(b.page, 'BACK');
const c = await readClock(b.page);
const afterReturn = await kbState(b.page);

console.log('\n  clock:  ' + fmt(c) + '\n');
say('A-1', afterReturn.driving === afterThumb.driving ? 'FINE' : 'BROKEN',
  `after a trip to another tab and back: driving ${afterThumb.driving} -> ${afterReturn.driving}, `
  + `padTakesSpace ${afterThumb.padTakesSpace} -> ${afterReturn.padTakesSpace}, `
  + `playerMoves ${afterThumb.playerMoves} -> ${afterReturn.playerMoves}, focus "${afterReturn.focus}"`);

/* THE CONSEQUENCE, DRIVEN RATHER THAN INFERRED: the player's next
   Space. He is on his thumbs. It must jump and must not open Menu. */
const before = await b.page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.length, jump: WALLY.ctx.ui.touch?.jump }));
await d.key('Space', 30);
await d.wait(320);
const after = await b.page.evaluate(() => ({ panels: WALLY.ctx.ui.panels.length,
  top: WALLY.ctx.ui.panels[WALLY.ctx.ui.panels.length-1]?.className || null }));
say('A-2', after.top ? 'BROKEN' : 'FINE',
  `Space after the tab-return, thumbs player: panel opened = ${after.top ? '"'+after.top+'"' : 'none'} (${loadNow()})`);

/* CONTROL: the same trip with the keyboard on NOTHING (a pure thumbs
   player who never tabbed). If this moves too, the finding is not
   about the pad region at all. */
await arm();
await d.thumb('Jump', 70, 320);
const c2a = await kbState(b.page);
await tabAway(b.page, b.ctxM);
const c2b = await kbState(b.page);
say('A-3', c2a.driving === c2b.driving ? 'FINE' : 'BROKEN',
  `CONTROL never-tabbed-then-thumbs, same trip: driving ${c2a.driving} -> ${c2b.driving}, focus "${c2b.focus}" (${loadNow()})`);

const rep = await b.page.evaluate(() => WALLY.debug.kb());
say('A-4', rep.violations.length === 0 ? 'FINE' : 'NOTE',
  `guard=${rep.guard} violations=${rep.violations.length} — the browser's own focus move is NOT a violation: `
  + `no focus() was dispatched, so neither half of the registration assertion can see it`);

console.log('\nERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await b.close();
