/* _gb11-g.mjs — ROUND TEN part G. The standing set, re-run
   independently of tools/touchtest.mjs, plus the two neighbourhood
   cases that suite has no assertion for:
     · a Tab that lands OUTSIDE the closing panel, on a live element —
       the hand-back overwrites it, and the whole published rationale
       for restoring over the player ("the node is going away anyway")
       does not hold there
     · a focus moved by a THIRD PARTY: neither the player nor the
       hand-back                                                     */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot();
const d = driver(B.page, B.cdp);
let fails = 0, n = 0;
const ok = (c, name, detail = '') => { n++; if (!c) fails++;
  console.log(`${c ? 'FINE   ' : 'BROKEN '} ${name}${detail ? '\n           ' + detail : ''}`); return c; };

const stale = async () => { await d.reset(); const t = await d.tabTo('Menu'); await d.thumb('Jump', 110, 240); return t; };
const openPause = async () => { await d.thumb('Menu', 70, 340); return (await d.panels()).includes('pause'); };
const spaceOpensPanel = async () => { const b = (await d.panels()).length; await d.key('Space', 25); await d.wait(420);
  return (await d.panels()).length > b; };

console.log('\n──── THE HAND-BACK NEIGHBOURHOOD ────');

/* 1a. a Tab that lands OUTSIDE the closing panel BEFORE the close.
       Shift-Tab out of the panel, then close with the KEYBOARD — a
       finger tap would re-focus a button inside the panel and the
       "outside" case would never be entered at all. */
{
  const rows = [];
  for (let i = 0; i < 5; i++) {
    await stale(); await openPause(); await d.wait(350);
    await d.key('Tab', 20, d.SHIFT); await d.wait(350);
    const mid = await d.focusNow();
    await d.key('Escape', 25); await d.wait(750);
    const f = await d.focusNow(); const kb = await d.padKb();
    rows.push({ mid: `${mid.where}/${mid.label}`, end: `${f.where}/${f.label}`,
      kept: `${f.where}/${f.label}` === `${mid.where}/${mid.label}`, deaf: kb.driving, out: mid.where === 'other' });
  }
  const kept = rows.filter(r => r.kept).length;
  ok(rows.every(r => r.out), 'BRANCH CHECK: Shift-Tab really did leave the panel', rows.map(r => r.mid).join(' | '));
  ok(kept === 5, `a ring the player put OUTSIDE the panel survives the close (${kept}/5 kept)`,
    rows.map(r => r.mid + ' -> ' + r.end).join(' | '));
}

/* 1b. a Tab that lands outside the panel DURING the hand-back window,
       on a LIVE pad button — the window widened so a real dispatched
       Tab lands inside it every time instead of racing. The published
       rationale for restoring over the player is that the focus it
       replaces is inside a node that is going away. On this path it is
       not: it is a pad button with a future. */
{
  await B.page.evaluate(() => WALLY.debug.padHandBackStall(12));
  const rows = [];
  for (let i = 0; i < 5; i++) {
    await stale(); await openPause(); await d.wait(320);
    const rb = await d.btnIn('resume');
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
    await d.wait(70);                                  // pad is back, hand-back still stalled
    await d.keyDown('Tab'); await d.keyUp('Tab');
    await d.wait(60);
    const mid = await d.focusNow();
    await d.wait(900);
    const f = await d.focusNow(); const kb = await d.padKb(); const r = await d.restore();
    rows.push({ mid: `${mid.where}/${mid.label}`, end: `${f.where}/${f.label}`, deaf: kb.driving,
      live: mid.where === 'pad', kept: `${f.where}/${f.label}` === `${mid.where}/${mid.label}`, mv: r?.moved, sg: r?.signed });
  }
  await B.page.evaluate(() => WALLY.debug.padHandBackStall(0));
  console.log(`  rows: ${rows.map(r => `${r.mid} -> ${r.end} mv=${r.mv} sg=${r.sg} deaf=${r.deaf}`).join(' | ')}`);
  ok(rows.every(r => r.live), 'BRANCH CHECK: the mid-window Tab really landed on a LIVE pad button', rows.map(r => r.mid).join(' | '));
  ok(rows.filter(r => r.kept).length === 5, 'a ring on a LIVE pad button is not overwritten by the hand-back',
    `kept ${rows.filter(r => r.kept).length}/5`);
  ok(rows.every(r => r.deaf === false), '...and that Tab keeps its meaning', `deaf ${rows.filter(r => r.deaf).length}/5`);
}

/* 2. a focus moved by a THIRD PARTY. Not the player, not the
      hand-back: a script focus() on a live element outside the pad,
      landing inside the hand-back's window (widened so it lands there
      every time rather than winning a race). */
{
  await B.page.evaluate(() => WALLY.debug.padHandBackStall(8));
  const rows = [];
  for (let i = 0; i < 5; i++) {
    await stale(); await openPause(); await d.wait(320);
    const rb = await d.btnIn('resume');
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
    await d.wait(40);
    const took = await B.page.evaluate(() => {           // the third party
      const t = [...document.querySelectorAll('button,[tabindex]')]
        .find(e => !e.closest('.w-touch') && !e.closest('.w-sheet,.w-pause,.w-phone') && e.getClientRects().length);
      if (!t) return null; t.focus({ preventScroll: true });
      return document.activeElement === t ? (t.getAttribute('aria-label') || (t.textContent || '').trim().slice(0, 16)) : null;
    });
    await d.wait(900);
    const f = await d.focusNow(); const kb = await d.padKb(); const r = await d.restore();
    rows.push({ took, end: `${f.where}/${f.label}`, deaf: kb.driving, mv: r?.moved, sg: r?.signed, land: r?.landed });
  }
  await B.page.evaluate(() => WALLY.debug.padHandBackStall(0));
  console.log(`  third-party focus rows: ${rows.map(r => `took=${r.took} end=${r.end} mv=${r.mv} sg=${r.sg}`).join(' | ')}`);
  ok(rows.every(r => r.land), 'a third-party focus never makes the hand-back give up entirely', `landed ${rows.filter(r => r.land).length}/5`);
  ok(rows.every(r => r.mv === true), 'the hand-back SEES a third-party focus as a move', `moved ${rows.filter(r => r.mv).length}/5`);
  ok(rows.every(r => r.sg === false), 'and withholds the signature for it', `signed ${rows.filter(r => r.sg).length}/5 (0 expected)`);
}

console.log('\n──── THE STANDING SET: WHO OWNS THE NEXT KEY ────');

/* tabbed-once-then-thumbs must jump */
{ await stale(); const kb = await d.padKb(); const fired = await spaceOpensPanel();
  ok(kb.driving === true && !fired, 'tabbed once, then thumbs: Space reaches the game, not the button', JSON.stringify(kb)); }

/* never-tabbed-then-thumbs must jump */
{ await d.reset(); await d.thumb('Jump', 110, 260); const kb = await d.padKb(); const fired = await spaceOpensPanel();
  ok(kb.driving === true && !fired, 'never tabbed, then thumbs: Space reaches the game', JSON.stringify(kb)); }

/* tabbed-then-Space with NO touch must fire the button */
{ await d.reset(); const t = await d.tabTo('Menu'); await d.wait(150);
  const kb = await d.padKb(); const fired = await spaceOpensPanel();
  ok(t && kb.padTakesSpace === true && fired, 'tabbed, no touch at all: Space FIRES the focused pad button', `${JSON.stringify(kb)} fired=${fired}`); }

/* tab-touch-tab-Space must fire the button */
{ await d.reset(); await d.tabTo('Menu'); await d.thumb('Jump', 110, 240);
  await d.key('Tab', 20); await d.wait(200);
  const kb = await d.padKb(); const f = await d.focusNow(); const fired = await spaceOpensPanel();
  ok(kb.padTakesSpace === true && fired, 'tab, touch, tab, Space: the second Tab hands the keyboard back and the button fires',
    `${JSON.stringify(kb)} ring=${f.where}/${f.label} fired=${fired}`); }

/* a screen-reader cursor move: a bare focus() with NO DOM input event */
{ await d.reset(); await d.tabTo('Menu'); await d.thumb('Jump', 110, 240);
  const moved = await B.page.evaluate(() => { const b = [...document.querySelectorAll('.w-abtn')]
      .find(e => e.getAttribute('aria-label') === 'Phone');
    document.activeElement?.blur?.(); b.focus({ preventScroll: true }); return document.activeElement === b; });
  await d.wait(200);
  const kb = await d.padKb(); const fired = await spaceOpensPanel();
  ok(moved && kb.driving === false && fired, 'a screen-reader cursor move (focus with no input event) is obeyed',
    `${JSON.stringify(kb)} fired=${fired}`); }

console.log('\n──── SHEETS: OPENED ONE WAY, CLOSED THE OTHER ────');

/* opened by touch, closed by keyboard */
{ await stale(); const opened = await openPause(); await d.wait(250);
  await d.key('Escape', 25); await d.wait(600);
  const p = await d.panels(); const f = await d.focusNow();
  ok(opened && p.length === 0, 'a sheet opened by thumb closes on Escape', `panels=${JSON.stringify(p)} ring=${f.where}/${f.label}`); }

/* opened by keyboard, closed by touch */
{ await d.reset(); await d.tabTo('Menu'); await d.wait(120);
  await d.key('Space', 25); await d.wait(500);
  const opened = (await d.panels()).includes('pause');
  const rb = await d.btnIn('resume');
  await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
  await d.wait(700);
  const p = await d.panels(); const f = await d.focusNow();
  ok(opened && p.length === 0, 'a sheet opened by keyboard closes on a thumb', `opened=${opened} panels=${JSON.stringify(p)} ring=${f.where}/${f.label}`); }

/* nested sheets: the ✕ closes the box it is drawn on, and the ring
   comes back to the panel underneath, not to the pad */
{ await stale(); await openPause(); await d.wait(250);
  const settings = await d.btnIn('settings');
  if (settings) {
    await d.touch('touchStart', settings.x, settings.y); await d.wait(45); await d.touch('touchEnd', settings.x, settings.y);
    await d.wait(600);
    const two = await d.panels();
    await d.key('Escape', 25); await d.wait(600);
    const one = await d.panels(); const f = await d.focusNow();
    ok(two.length === 2 && one.length === 1, 'nested sheets: Escape closes the top one only',
      `stack ${JSON.stringify(two)} -> ${JSON.stringify(one)} ring=${f.where}/${f.label}`);
    ok(f.where === 'panel', '...and the ring lands on the panel underneath, not the pad', `ring=${f.where}/${f.label}`);
    await d.reset();
  } else { console.log('  (no Settings row found; nested-sheet arm skipped)'); }
}

/* a sheet whose opener no longer exists */
{ await d.reset(); await d.tabTo('Menu'); await d.wait(120);
  await d.key('Space', 25); await d.wait(500);
  const opened = (await d.panels()).includes('pause');
  const killed = await B.page.evaluate(() => {          // the opener is removed while the sheet is up
    const b = [...document.querySelectorAll('.w-abtn')].find(e => e.getAttribute('aria-label') === 'Menu');
    if (!b) return false; b.remove(); return !b.isConnected; });
  await d.key('Escape', 25); await d.wait(700);
  const p = await d.panels(); const f = await d.focusNow();
  ok(opened && killed && p.length === 0, 'a sheet whose opener was removed still closes', `panels=${JSON.stringify(p)}`);
  ok(f.where !== 'DYING', '...and does not leave the ring inside a removed node', `ring=${f.where}/${f.label}`);
  await B.page.evaluate(() => WALLY.ctx.ui.rebuildTop?.());
  await B.page.reload({ waitUntil: 'load' });
  await B.page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 90000 });
  await B.page.waitForTimeout(3000);
  await B.page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.ctx.ui.closeAll(); });
  await d.wait(400);
}

console.log(`\n${fails} BROKEN of ${n}`);
console.log('errs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
