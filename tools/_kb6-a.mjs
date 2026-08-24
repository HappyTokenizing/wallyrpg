/* _kb6-a.mjs — ROUND SIX recon: does the owner exist, is the register
   complete, and where do the two Tab directions actually LAND.
   Real CDP input at 390x844, hasTouch, isMobile. No element.click().  */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';

const L0 = load();
const b = await boot();
const d = driver(b.page, b.cdp);
console.log(`load at boot ${L0} · ${cpus()} cpus`);

const kb = () => b.page.evaluate(() => WALLY.debug.kb());
const say = (k, v) => console.log(`  ${k.padEnd(26)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);

console.log('\n--- 1. the owner is installed and the ledger is clean after boot ---');
let r = await kb();
say('guard wrapping dispatch', r.guard);
say('regions registered', r.regions);
say('sites in the register', r.sites.length + ' ' + r.sites.join(','));
say('violations after boot', r.violations.length);
if (r.violations.length) console.log(JSON.stringify(r.violations, null, 1));
say('gameHasKeyboard at boot', r.gameHasKeyboard);
say('pageerrors', b.errs);

console.log('\n--- 2. DOM order: what is before the panel layer ---');
console.log(JSON.stringify(await b.page.evaluate(() => {
  const all = [...document.querySelectorAll('button,[href],input,select,textarea,[tabindex]')];
  return all.slice(0, 14).map(e => ({
    t: e.tagName, lab: e.getAttribute('aria-label') || (e.textContent || '').trim().slice(0, 10),
    pad: !!e.closest('.w-touch'), vis: e.getClientRects().length > 0,
  }));
}), null, 0));

console.log('\n--- 3. drive every UI path; the ledger must stay empty ---');
await d.thumb('Menu');                       // pause sheet, thumb-opened
say('panels', await d.panels());
const resume = await d.btnIn('resume');
if (resume) { await d.touch('touchStart', resume.x, resume.y); await d.wait(60); await d.touch('touchEnd', resume.x, resume.y); }
await d.wait(500);
await b.page.evaluate(() => WALLY.ctx.ui.openPhone?.('places'));
await d.wait(500);
await b.page.evaluate(() => WALLY.ctx.ui.closeAll());
await d.wait(400);
await b.page.evaluate(() => WALLY.ctx.ui.openQuickBuy?.());
await d.wait(400);
say('quickbuy focus', await d.focusNow());
await b.page.evaluate(() => {
  const c = [...document.querySelectorAll('.w-srch .clr')][0];
  return !!c;
});
await b.page.evaluate(() => WALLY.ctx.ui.closeAll());
await d.wait(400);
await b.page.evaluate(() => WALLY.ctx.ui.dialogue?.open?.({
  speaker: 'Wally', text: 'Round six.', choices: [{ label: 'Yes', value: 1 }, { label: 'No', value: 2 }],
}));
await d.wait(700);
say('dialogue focus', await d.focusNow());
await b.page.evaluate(() => WALLY.ctx.ui.dialogue?.close?.(null));
await d.wait(400);
r = await kb();
say('violations after paths', r.violations.length);
if (r.violations.length) console.log(JSON.stringify(r.violations.slice(0, 3), null, 1));
say('playerMoves', r.playerMoves);

console.log('\n--- 4. the registration assertion catches a smuggled focus ---');
say('smuggle', await b.page.evaluate(() => WALLY.debug.kbSmuggle('.w-abtn')));
await b.page.evaluate(() => WALLY.debug.kbReset());

console.log('\n--- 5. both Tab directions from a closing panel ---');
await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); });
await d.wait(300);
for (const dir of ['forward', 'back']) {
  await b.page.evaluate(() => { WALLY.debug.padHandBackStall(0); WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); });
  await d.wait(300);
  const t = await d.tabTo('Menu');
  await d.thumb('Jump');
  await d.thumb('Menu');                     // pause sheet on a thumb
  await d.wait(350);
  await b.page.evaluate(() => WALLY.debug.padHandBackStall(9));
  const res = await d.btnIn('resume');
  if (res) { await d.touch('touchStart', res.x, res.y); await d.wait(50); await d.touch('touchEnd', res.x, res.y); }
  await d.wait(30);
  await d.key('Tab', 10, dir === 'back' ? d.SHIFT : 0);
  await d.wait(60);
  const during = await d.focusNow();
  await d.wait(700);
  console.log(`  ${dir.padEnd(8)} tabbedTo=${t ? t.label : 'none'}  landed=${JSON.stringify(during)}`);
  console.log(`           after=${JSON.stringify(await d.focusNow())}  restore=${JSON.stringify(await d.restore())}`);
  console.log(`           padKb=${JSON.stringify(await d.padKb())}`);
  await b.page.evaluate(() => WALLY.debug.padHandBackStall(0));
}

console.log(`\nload at end ${load()}   pageerrors ${JSON.stringify(b.errs)}`);
await b.close();
