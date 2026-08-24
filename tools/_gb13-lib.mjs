/* _gb13-lib.mjs — ROUND ELEVEN gesture breaker, my own rig.
   Reuses the round-nine boot/driver (read and verified: real CDP
   Input.dispatch{Touch,Mouse,Key}Event at 390x844, hasTouch, isMobile,
   no element.click() anywhere in it) and the round-ten clock.
   ADDS: a real second tab, so the BROWSER can move focus without any
   script calling focus() — the one focus mover neither half of the
   registration assertion can see. */
export { boot, driver, load, cpus, installLedger, ledger, ROOT } from './_gb11-lib.mjs';
export { clock, readClock, mark, fmt } from './_gb12-lib.mjs';
import { execSync } from 'node:child_process';

/** Load measured AT THE MOMENT OF USE, never at import. */
export function loadNow(tag = '') {
  const up = execSync('uptime').toString();
  const la = up.split('load averages:')[1].trim();
  const n = execSync('sysctl -n hw.ncpu').toString().trim();
  return `load ${la} / ${n} cpu${tag ? ' · ' + tag : ''}`;
}

/** The owner's answer + the pad's answer, together, so a disagreement
    is visible rather than inferred. */
export const kbState = (page) => page.evaluate(() => {
  const k = WALLY.debug.kb();
  const p = WALLY.debug.padKeyboard();
  const a = document.activeElement;
  return {
    gameHasKeyboard: k.gameHasKeyboard, playerMoves: k.playerMoves,
    violations: k.violations.length, lastPlayer: k.lastPlayer,
    driving: p.driving, padFocused: p.padFocused, padTakesSpace: p.padTakesSpace,
    focus: p.focus, owner: p.owner,
    onBody: !a || a === document.body,
  };
});

/** A REAL browser focus loss and return: a second tab fronted, then
    this one fronted again. Chrome restores focus to the element that
    had it, dispatching focusin with NO focus() call on the stack. */
export async function tabAway(page, ctxM, ms = 350) {
  const other = await ctxM.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await other.waitForTimeout(ms);
  await page.bringToFront();
  await page.waitForTimeout(ms);
  await other.close();
  await page.waitForTimeout(150);
}
