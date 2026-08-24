/* GB13-B — THE ENUMERATION, BROKEN.
   kbowner's second clause: "a focus arrival that no call site DECLARED
   is, by definition, the player's." The browser authors one on tab
   return. It is not the player's, nothing dispatched focus(), and so
   NEITHER half of the registration assertion can see it — the runtime
   guard wraps HTMLElement.prototype.focus and no focus() is called;
   the static scanner reads src/ and this focus move is not in src/.
   Focus emulation OFF, because Playwright pins document.hasFocus()
   true by default and that is why ten rounds of rigs never saw it. */
import { boot, driver, loadNow, kbState } from './_gb13-lib.mjs';

const say = (id, v, note) => console.log(`${v.padEnd(7)} ${id}  ${note}`);
const b = await boot();
const d = driver(b.page, b.cdp);
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
console.log('BOOT  ' + loadNow('at boot') + '  · focus emulation OFF (real browser behaviour)');

const other = await b.ctxM.newPage(); await other.goto('about:blank');
const trip = async (ms = 400) => {
  await other.bringToFront(); await b.page.waitForTimeout(ms);
  await b.page.bringToFront(); await b.page.waitForTimeout(ms);
};
const arm = async () => { await b.page.evaluate(() => { WALLY.debug.kbReset(); WALLY.ctx.ui.closeAll(); }); await d.wait(300); };
const panelTop = () => b.page.evaluate(() => {
  const p = WALLY.ctx.ui.panels; return p.length ? (p[p.length-1].className || p[p.length-1].tagName) : null; });

/* ============ B-1: the tabbed-once-then-thumbs player ============ */
await arm();
if (!await d.tabTo('Menu')) { console.log('SETUP FAILED'); await b.close(); process.exit(2); }
await d.thumb('Jump', 70, 320);
const pre = await kbState(b.page);
say('B-pre', pre.driving && !pre.padTakesSpace ? 'OK' : 'SETUP',
  `driving=${pre.driving} focus="${pre.focus}" padTakesSpace=${pre.padTakesSpace} playerMoves=${pre.playerMoves}`);

await trip();
const post = await kbState(b.page);
say('B-1', post.driving === pre.driving ? 'FINE' : 'BROKEN',
  `trip to another tab and BACK — nothing touched, no gesture: driving ${pre.driving} -> ${post.driving}, `
  + `padTakesSpace ${pre.padTakesSpace} -> ${post.padTakesSpace}, playerMoves ${pre.playerMoves} -> ${post.playerMoves} `
  + `(the arrival the browser authored), focus "${post.focus}"  (${loadNow()})`);

/* the consequence a player would feel, driven not inferred */
await b.page.evaluate(() => WALLY.ctx.ui.closeAll()); await d.wait(250);
await d.key('Space', 30); await d.wait(360);
const t1 = await panelTop();
say('B-2', t1 ? 'BROKEN' : 'FINE',
  `his next Space, on his thumbs, after coming back: panel = ${t1 ? '"'+t1+'"' : 'none (it jumped)'}  (${loadNow()})`);

/* ============ B-3: CONTROL — same trip, focus NOT on the pad ====== */
await arm();
await d.thumb('Jump', 70, 320);
await b.page.evaluate(() => WALLY.debug.kbFocus('sheet.input', 'canvas') );  // no-op if not focusable
const c1 = await kbState(b.page);
await trip();
const c2 = await kbState(b.page);
say('B-3', c1.driving === c2.driving ? 'FINE' : 'BROKEN',
  `CONTROL focus="${c1.focus}" (outside the pad region): driving ${c1.driving} -> ${c2.driving}, `
  + `playerMoves ${c1.playerMoves} -> ${c2.playerMoves}  — isolates the region test from the trip itself`);

/* ============ B-4: does it repeat? one trip, or every trip ======== */
await arm();
await d.tabTo('Menu'); await d.thumb('Jump', 70, 320);
const runs = [];
for (let i = 0; i < 3; i++) {
  await b.page.evaluate(() => WALLY.debug.padKeyboard());
  await d.thumb('Jump', 70, 260);                 // pick the game up again
  const a = await kbState(b.page);
  await trip(300);
  const z = await kbState(b.page);
  runs.push(`${a.driving}->${z.driving}`);
}
say('B-4', runs.every(r => r === 'true->true') ? 'FINE' : 'BROKEN',
  `re-armed with a thumb and repeated 3x: ${runs.join('  ')}  (${loadNow()})`);

/* ============ B-5: neither half of the assertion sees it ========= */
const rep = await b.page.evaluate(() => WALLY.debug.kb());
say('B-5', 'NOTE',
  `guard=${rep.guard} violations=${rep.violations.length}. The runtime half wraps the DISPATCH and nothing `
  + `dispatched focus(); the static half scans src/ and this mover is Chrome. The enumeration is complete `
  + `over src and src is not where this came from.`);

console.log('\nERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await other.close(); await b.close();
