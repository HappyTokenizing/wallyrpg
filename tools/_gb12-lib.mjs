/* _gb12-lib.mjs — ROUND TEN gesture breaker, my own rig.
   Reuses the boot/driver from _gb11-lib.mjs (read and verified: real
   CDP Input.dispatch{Touch,Mouse,Key}Event at 390x844, hasTouch,
   isMobile, no element.click anywhere in it) and adds ONE clock over
   focus, keys and touches so an ordering claim is a record. */
export { boot, driver, load, cpus } from './_gb11-lib.mjs';

/** One ledger, one clock: focusin/focusout, keydown/keyup, touchend,
    and marks the driver can drop into it. */
export async function clock(page) {
  await page.evaluate(() => {
    window.__C = []; window.__C0 = performance.now();
    window.__mark = (m) => window.__C.push({ t: +(performance.now() - window.__C0).toFixed(2), mark: m });
    if (window.__clockOn) return; window.__clockOn = true;
    const name = (a) => a?.getAttribute?.('aria-label')
      || (a?.textContent || '').trim().slice(0, 14) || a?.className || a?.tagName || '?';
    const where = (a) => {
      if (!a || a === document.body) return 'body';
      const sheet = a.closest?.('.w-sheet,.w-pause,.w-phone,.w-dlg,[class*="sheet"]');
      if (a.closest?.('.w-touch')) return 'pad';
      if (sheet) return sheet.classList.contains('out') ? 'DYING' : 'panel';
      return 'other';
    };
    const at = () => +(performance.now() - window.__C0).toFixed(2);
    document.addEventListener('focusin', (e) => window.__C.push(
      { t: at(), ev: 'focusin', el: name(e.target), where: where(e.target), trusted: e.isTrusted }), true);
    document.addEventListener('focusout', (e) => window.__C.push(
      { t: at(), ev: 'focusout', el: name(e.target) }), true);
    for (const k of ['keydown', 'keyup']) document.addEventListener(k, (e) => window.__C.push(
      { t: at(), ev: k, key: e.key, shift: e.shiftKey, repeat: e.repeat, trusted: e.isTrusted }), true);
    for (const k of ['touchstart', 'touchend']) document.addEventListener(k, (e) => window.__C.push(
      { t: at(), ev: k, el: name(e.target), trusted: e.isTrusted }), true);
    document.addEventListener('click', (e) => window.__C.push(
      { t: at(), ev: 'click', el: name(e.target), detail: e.detail, trusted: e.isTrusted }), true);
  });
}
export const readClock = (page) => page.evaluate(() => {
  const c = window.__C.slice(); window.__C = []; window.__C0 = performance.now(); return c; });
export const mark = (page, m) => page.evaluate((s) => window.__mark(s), m);
export const fmt = (c) => c.map(e => e.mark ? `${e.t} · ${e.mark}`
  : e.ev === 'focusin' ? `${e.t} focusin ${e.el} [${e.where}] trusted=${e.trusted}`
  : e.ev === 'focusout' ? `${e.t} focusout ${e.el}`
  : e.ev === 'click' ? `${e.t} click ${e.el} detail=${e.detail}`
  : (e.ev === 'keydown' || e.ev === 'keyup') ? `${e.t} ${e.ev} ${e.key}${e.shift ? '+shift' : ''}${e.repeat ? ' REPEAT' : ''}`
  : `${e.t} ${e.ev} ${e.el || ''}`).join('\n           ');
