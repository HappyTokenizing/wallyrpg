/* GB13-A2 — DIAGNOSE the blind probe first. Did the page ever lose
   focus at all? Playwright enables focus emulation by default, which
   makes document.hasFocus() permanently true and suppresses exactly
   the browser-authored refocus this probe is hunting. */
import { boot, driver, loadNow, kbState } from './_gb13-lib.mjs';
const b = await boot();
const d = driver(b.page, b.cdp);
const peek = () => b.page.evaluate(() => ({
  hasFocus: document.hasFocus(), vis: document.visibilityState,
  active: document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.tagName }));
console.log('BOOT ' + loadNow());
await b.page.evaluate(() => { WALLY.debug.kbReset(); WALLY.ctx.ui.closeAll(); });
await d.wait(250);
await d.tabTo('Menu');
console.log('with focus emulation ON (playwright default):', JSON.stringify(await peek()));

const other = await b.ctxM.newPage(); await other.goto('about:blank');
await other.bringToFront(); await b.page.waitForTimeout(300);
console.log('  other tab fronted            :', JSON.stringify(await peek()));
await b.page.bringToFront(); await b.page.waitForTimeout(300);
console.log('  back                         :', JSON.stringify(await peek()));

/* turn focus emulation OFF and repeat */
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
console.log('\nfocus emulation OFF:', JSON.stringify(await peek()));
await b.page.evaluate(() => { window.__FI = []; 
  document.addEventListener('focusin', e => window.__FI.push('in:' + (e.target.getAttribute?.('aria-label')||e.target.tagName)), true);
  document.addEventListener('focusout', e => window.__FI.push('out:' + (e.target.getAttribute?.('aria-label')||e.target.tagName)), true);
  window.addEventListener('blur', () => window.__FI.push('WINDOW blur'));
  window.addEventListener('focus', () => window.__FI.push('WINDOW focus'));
});
await other.bringToFront(); await b.page.waitForTimeout(400);
console.log('  other tab fronted            :', JSON.stringify(await peek()));
await b.page.bringToFront(); await b.page.waitForTimeout(400);
console.log('  back                         :', JSON.stringify(await peek()));
console.log('  events seen                  :', JSON.stringify(await b.page.evaluate(() => window.__FI)));
console.log('  kb                           :', JSON.stringify(await kbState(b.page)));
await other.close();
console.log('END ' + loadNow());
await b.close();
