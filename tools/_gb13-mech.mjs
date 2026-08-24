/* GB13-MECH — pin the mechanism of the sheet-swap defect instead of
   asserting it: read the hand-back record AT THE SWAP, not just at the
   end, and watch focusReturn get spent. */
import { boot, driver, kbState, loadNow } from './_gb13-boot2.mjs';
const b = await boot(); const d = driver(b.page, b.cdp);
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
await b.page.bringToFront(); await d.wait(250);
console.log('BOOT ' + loadNow() + ' · FROZEN SNAPSHOT');
await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); }); await d.wait(340);
const rec = () => b.page.evaluate(() => { const r = WALLY.debug.focusRestore();
  return r && { kind: r.kind, to: r.to, from: r.from, site: r.site, landed: r.landed, attempts: r.attempts, moved: r.moved }; });
await d.tabTo('Menu');
console.log('1 tabbed to Menu            :', JSON.stringify(await d.focusNow()));
await d.thumb('Menu', 70, 460);
console.log('2 thumb Menu -> pause open  : rec=' + JSON.stringify(await rec()));
await b.page.evaluate(() => WALLY.debug.ui('phone'));
await d.wait(120);
console.log('3 phone REPLACES pause +120ms: rec=' + JSON.stringify(await rec()) + ' focus=' + JSON.stringify(await d.focusNow()));
await d.wait(500);
console.log('4 ... +620ms                 : rec=' + JSON.stringify(await rec()) + ' focus=' + JSON.stringify(await d.focusNow()));
await d.key('Escape', 25); await d.wait(1000);
console.log('5 Escape closes phone        : rec=' + JSON.stringify(await rec()) + ' focus=' + JSON.stringify(await d.focusNow()));
console.log('   menu button still alive   :', await b.page.evaluate(() =>
  !![...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu' && e.isConnected)));
console.log('   kb                        :', JSON.stringify(await kbState(b.page)));
console.log('ERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END ' + loadNow());
await b.close();
