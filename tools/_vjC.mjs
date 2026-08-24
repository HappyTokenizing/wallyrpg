/* _vjC.mjs — why did MY forward-Tab rig end on <body> when KB-13 says
   panel.adopt? Dump the focus ledger and the restore record. */
import { boot, driver, load, cpus, installLedger, ledger } from './_gb11-lib.mjs';
const b = await boot(); const d = driver(b.page, b.cdp);
await installLedger(b.page);
console.log('load', load(), '·', cpus(), 'cpus');

async function run(shift, stall, tabDelay, arm) {
  await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.padHandBackStall(0);
    WALLY.debug.kbWho('owner'); WALLY.debug.kbKeep('survivor'); });
  await d.wait(350);
  /* ARM IT THE WAY THE SUITE DOES: a Tab traversal first, then reset,
     then a thumb jump so the routing bit is genuinely the game's */
  const t0 = await d.tabTo('Menu');
  await b.page.evaluate(() => WALLY.debug.kbReset());
  const jc = await d.padAt('Jump');
  await d.touch('touchStart', jc.x, jc.y); await d.wait(110); await d.touch('touchEnd', jc.x, jc.y);
  await d.wait(300);
  await d.thumb('Menu');                         // pause sheet on a real thumb
  await d.wait(320);
  const openRec = await b.page.evaluate(() => WALLY.debug.focusRestore());
  await b.page.evaluate((s) => WALLY.debug.padHandBackStall(s), stall);
  await ledger(b.page);                          // clear
  const res = await d.btnIn('resume');
  if (!res) return console.log(arm, 'NO RESUME BUTTON');
  await d.touch('touchStart', res.x, res.y); await d.wait(50); await d.touch('touchEnd', res.x, res.y);
  await d.wait(tabDelay);
  await d.key('Tab', 10, shift ? d.SHIFT : 0);
  await d.wait(1000);
  await b.page.evaluate(() => WALLY.debug.padHandBackStall(0));
  const rec = await b.page.evaluate(() => WALLY.debug.focusRestore());
  const pad = await b.page.evaluate(() => WALLY.debug.padKeyboard());
  console.log(`\n--- ${arm}  stall=${stall} tabDelay=${tabDelay}ms  (tabbedFirst=${!!t0}) ---`);
  console.log('  openRec.site  ', openRec && openRec.site, '| kind', openRec && openRec.kind);
  console.log('  closeRec      ', JSON.stringify(rec));
  console.log('  focus         ', JSON.stringify(await d.focusNow()));
  console.log('  padKeyboard   ', JSON.stringify(pad));
  console.log('  ledger        ', JSON.stringify(await ledger(b.page)));
}

await run(false, 25, 20, 'FORWARD Tab (suite params: stall 25, +20ms)');
await run(true, 25, 20, 'SHIFT-Tab (suite params: stall 25, +20ms)');
await run(false, 9, 30, 'FORWARD Tab (my params: stall 9, +30ms)');
console.log('\nload at end', load());
await b.close();
