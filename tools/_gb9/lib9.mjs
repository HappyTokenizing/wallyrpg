/* gesture-breaker round SEVEN — additions on top of _gb7/lib.mjs.
   Round seven's subject is the `driving` intent flag that closed the
   keyboard-borne Space theft (PAD-35/36/37). */
export * from '../_gb7/lib.mjs';
import { boot } from '../_gb7/lib.mjs';

/** Peak |vy| over a window, sampled per animation frame in the page.
    Handler counts lie about jumps; the ground truth is the controller. */
export async function peakVy(page, ms = 900) {
  await page.evaluate(() => {
    window.__vy = { peak: 0, min: 0, n: 0 };
    const c = () => WALLY.ctx.wally?.controller;
    const tick = () => {
      const k = c(); const v = k && (k.velocity || k.vel);
      if (v) {
        window.__vy.n++;
        if (v.y > window.__vy.peak) window.__vy.peak = v.y;
        if (v.y < window.__vy.min) window.__vy.min = v.y;
      }
      window.__vy.raf = requestAnimationFrame(tick);
    };
    tick();
  });
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    cancelAnimationFrame(window.__vy.raf);
    return { peak: +window.__vy.peak.toFixed(3), min: +window.__vy.min.toFixed(3), n: window.__vy.n };
  });
}

/** What the pad thinks right now, plus where focus is.
    The routing flag lives on WALLY.debug.padKeyboard(), NOT touchState. */
export const who = (page) => page.evaluate(() => {
  const a = document.activeElement;
  const k = WALLY.debug.padKeyboard ? WALLY.debug.padKeyboard() : {};
  const i = WALLY.debug.idle ? WALLY.debug.idle() : {};
  return {
    focus: a && a !== document.body
      ? (a.getAttribute?.('aria-label') || a.className || a.tagName) : null,
    isBody: a === document.body,
    inPad: !!(a && a.closest?.('.w-touch')),
    driving: k.driving ?? null,
    padFocused: k.padFocused ?? null,
    padTakesSpace: k.padTakesSpace ?? null,
    hidden: i.hidden ?? null,
    live: i.live ?? null,
    idleT: i.t ?? null,
    why: i.why ?? null,
    panels: WALLY.ctx.ui.panels.slice(),
  };
});

/** Shut every sheet, whatever is open, and confirm it. Escape is the
    route a player has; JS back() left panels up in round-seven probe 1
    and every later assertion cascaded off it. */
export async function closeAll(page) {
  await page.evaluate(() => WALLY.ctx.ui.closeAll());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.activeElement?.blur?.());
  return page.evaluate(() => WALLY.ctx.ui.panels.slice());
}

/** Only the pad's own buttons, in the order Tab visited them. */
export const PAD_LABELS = ['Phone', 'Places', 'Desk', 'Menu', 'Jump', 'Enter or talk'];
export const padOnly = (seq) => seq.filter((s) => PAD_LABELS.includes(s));

/** Focus a pad button the way a real Tab would: keyboard only, no JS focus(). */
export async function tabTo(page, label, max = 40) {
  await page.evaluate(() => document.activeElement?.blur?.());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const cur = await page.evaluate(() =>
      document.activeElement?.getAttribute?.('aria-label') || null);
    if (cur === label) return i + 1;
  }
  return -1;
}

/** The full sequential order, walked with real Tab presses. */
export async function tabOrder(page, n = 14, key = 'Tab') {
  const seq = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(key);
    seq.push(await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return '<body>';
      return a.getAttribute?.('aria-label')
        || (a.tagName + '.' + String(a.className || '')).slice(0, 40);
    }));
  }
  return seq;
}

export { boot };
