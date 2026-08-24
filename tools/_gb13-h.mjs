/* GB13-H — 6b again under the rebuild, plus nesting and the boot chip.
   A dialogue's first choice is an AUTHORISED take, so it must not look
   like the player moving focus. Driven INSIDE the hand-back window
   (held open with the stall hook) and outside it. */
import { boot, driver, loadNow, kbState } from './_gb13-lib.mjs';
const say = (id, v, note) => console.log(`${v.padEnd(7)} ${id}  ${note}`);
const b = await boot();
const d = driver(b.page, b.cdp);
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
await b.page.bringToFront(); await d.wait(250);
console.log('BOOT  ' + loadNow('at boot'));
const arm = async () => { await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); }); await d.wait(320); };
const rec = () => b.page.evaluate(() => WALLY.debug.focusRestore());

/* a dialogue WITH choices and one WITHOUT, both reachable */
const openDlg = (withChoices) => b.page.evaluate((wc) => {
  WALLY.ctx.ui.dialogue(wc ? {
    lines: [{ who: 'Wally', text: 'Buy in?' }],
    choices: [{ text: 'Yes', go: null }, { text: 'No', go: null }],
  } : { lines: [{ who: 'Wally', text: 'One' }, { who: 'Wally', text: 'Two' }, { who: 'Wally', text: 'Three' }] });
  return true;
}, withChoices);

/* ===== H-1 / H-2: the dialogue opening INSIDE the hand-back window.
   This is defect 6b: round 5's activeElement comparison could not tell
   the dialogue's authorised focus from the player pressing Tab, so the
   hand-back went unsigned and a thumb-only player lost his Space. ==== */
async function dlgInWindow(withChoices, whoMode) {
  await arm();
  await b.page.evaluate((m) => { WALLY.debug.kbWho(m); WALLY.debug.padHandBackStall(14); }, whoMode);
  await d.tabTo('Menu');                        // give the close something to hand back to
  await d.thumb('Menu', 70, 420);               // open pause with a thumb
  const resume = await d.btnIn('resume|close|back');
  await d.touch('touchStart', resume.x, resume.y); await d.wait(50);
  await d.touch('touchEnd', resume.x, resume.y);
  await d.wait(60);
  await openDlg(withChoices);                   // fires INSIDE the retry window
  await d.wait(1100);
  await b.page.evaluate(() => { WALLY.debug.padHandBackStall(0); WALLY.debug.kbWho('owner'); });
  const r = await rec(); const k = await kbState(b.page);
  await b.page.evaluate(() => WALLY.ctx.ui.closeAll());
  return { moved: r?.moved, site: r?.site, signed: r?.signed, kept: r?.kept, landed: r?.landed,
    driving: k.driving, focus: k.focus, takesSpace: k.padTakesSpace };
}
const h1 = await dlgInWindow(true, 'owner');
say('H-1', h1.moved === false ? 'FINE' : 'BROKEN',
  `dialogue WITH CHOICES opening inside the hand-back window (whoMode=owner): the hand-back saw moved=${h1.moved}, `
  + `site=${h1.site}, landed=${h1.landed} — an authorised take must NOT read as the player moving  (${loadNow()})`);
const h1r = await dlgInWindow(true, 'active');
say('H-1b', h1r.moved === true ? 'FINE' : 'SUSPECT',
  `REVERT ARM whoMode=active (round 5 exactly): moved=${h1r.moved}, site=${h1r.site} — this MUST read as a `
  + `player move, else H-1 is green on a page where the dialogue never focused anything`);
const h2 = await dlgInWindow(false, 'owner');
say('H-2', h2.moved === false ? 'FINE' : 'BROKEN',
  `dialogue WITHOUT choices, same window: moved=${h2.moved} site=${h2.site} focus="${h2.focus}"`);

/* ===== H-3: three rapid Enters advance a dialogue exactly 3 pages == */
await arm();
await openDlg(false); await d.wait(500);
const pg0 = await b.page.evaluate(() => WALLY.debug.interact());
for (let i = 0; i < 3; i++) { await d.key('Enter', 20); await d.wait(70); }
await d.wait(500);
const openAfter = await b.page.evaluate(() => ({ open: WALLY.ctx.ui.dlg?.isOpen ?? null,
  panels: WALLY.ctx.ui.panels.slice() }));
say('H-3', 'NOTE', `three rapid Enters on a 3-page dialogue: still open=${openAfter.open}, `
  + `panels=${JSON.stringify(openAfter.panels)} — a fourth Enter must not leak past the card  (${loadNow()})`);

/* ===== H-4: NESTED SHEETS — a sheet closed by opening another ===== */
await arm();
await d.tabTo('Menu');
await d.thumb('Menu', 70, 420);                            // pause
const beforeN = await b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
await b.page.evaluate(() => WALLY.debug.ui('phone'));      // a second sheet over it
await d.wait(400);
const midN = await b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
await d.key('Escape', 25); await d.wait(500);              // close the top one
const afterEsc = await b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
const rN = await rec(); const kN = await kbState(b.page);
say('H-4', kN.onBody ? 'SUSPECT' : 'FINE',
  `nested: ${JSON.stringify(beforeN)} -> ${JSON.stringify(midN)} -> Escape -> ${JSON.stringify(afterEsc)}; `
  + `hand-back site=${rN?.site} landed=${rN?.landed} attempts=${rN?.attempts}; focus="${kN.focus}" onBody=${kN.onBody}`);

/* ===== H-5: A SHEET WHOSE OPENER IS GONE ===== */
await arm();
const opener = await b.page.evaluate(() => {
  const el = [...document.querySelectorAll('button')].filter(e => !e.closest('.w-touch') && e.getClientRects().length)[0];
  if (!el) return null; el.setAttribute('data-gb13op', '1');
  WALLY.debug.kbFocus('sheet.input', '[data-gb13op]');
  return document.activeElement === el;
});
if (!opener) say('H-5', 'VOID', 'no opener candidate outside the pad');
else {
  await b.page.evaluate(() => WALLY.debug.ui('pause'));    // banks the opener as focusReturn
  await d.wait(400);
  await b.page.evaluate(() => document.querySelector('[data-gb13op]')?.remove());  // opener destroyed
  await d.key('Escape', 25); await d.wait(900);
  const r5 = await rec(); const k5 = await kbState(b.page);
  say('H-5', k5.violations > 0 ? 'BROKEN' : 'NOTE',
    `sheet closed after its OPENER was destroyed: hand-back to="${r5?.to}" attempts=${r5?.attempts} `
    + `landed=${r5?.landed}; focus="${k5.focus}" onBody=${k5.onBody} violations=${k5.violations} — `
    + `six frames of retry on a detached node, then it gives up and focus drops  (${loadNow()})`);
}

/* ===== H-6: the boot chip, and everything that focuses at startup === */
const fresh = await boot();
const fd = driver(fresh.page, fresh.cdp);
await fresh.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
const bootRep = await fresh.page.evaluate(() => WALLY.debug.kb());
say('H-6', bootRep.violations.length === 0 ? 'FINE' : 'BROKEN',
  `a FRESH boot, nothing driven: violations=${bootRep.violations.length} `
  + `${bootRep.violations.length ? JSON.stringify(bootRep.violations.map(v=>v.kind+':'+v.el)) : ''} `
  + `gameHasKeyboard=${bootRep.gameHasKeyboard} playerMoves=${bootRep.playerMoves} regions=${bootRep.regions} `
  + `— the boot chip and every startup focus declared  (${loadNow()})`);
await fresh.close();

console.log('\nERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await b.close();
