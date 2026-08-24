/* _gb12-h.mjs — the primary-button gate on all seven controls, with a
   navigation guard, because the previous round's run of this died with
   `WALLY is not defined` and never said whether the page had navigated. */
import { boot, driver, load, cpus } from './_gb12-lib.mjs';
console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot(); const d = driver(B.page, B.cdp);
let navs = 0; B.page.on('framenavigated', (f) => { if (f === B.page.mainFrame()) navs++; });
const alive = () => B.page.evaluate(() => typeof window.WALLY !== 'undefined').catch(() => false);
const snap = () => B.page.evaluate(() => ({
  panels: WALLY.ctx.ui.panels.length, jump: WALLY.debug.touchState().jump.held,
  axes: +(Math.abs(WALLY.debug.touchState().x) + Math.abs(WALLY.debug.touchState().z)).toFixed(3),
  act: JSON.stringify(WALLY.debug.interact() || null), j: window.__J })).catch(() => null);
await B.page.evaluate(() => { window.__J = 0; WALLY.ctx.bus.on('phys:jump', () => { window.__J++; }); });
const chg = (a, b) => !a || !b || a.panels !== b.panels || a.jump !== b.jump || a.axes !== b.axes || a.act !== b.act || a.j !== b.j;

const controls = [];
for (const l of ['Phone', 'Places', 'Desk', 'Menu', 'Enter or talk', 'Jump']) {
  const p = await d.padAt(l); if (p) controls.push({ name: l, ...p });
}
const st = await d.stickAt(); if (st) controls.push({ name: 'stick', x: st.x, y: st.y });
console.log(`  controls found: ${controls.length} — ${controls.map(c => c.name).join(', ')}`);
const BTN = [['left', 1], ['middle', 4], ['right', 2], ['back', 8], ['forward', 16]];
const grid = {}; let died = null;
for (const c of controls) {
  grid[c.name] = {};
  for (const [b, mask] of BTN) {
    if (!await alive()) { died = died || `${c.name}/${b} (before dispatch)`; grid[c.name][b] = '?'; continue; }
    await d.reset(); await d.wait(120);
    const before = await snap();
    await d.mouse('mousePressed', c.x, c.y, b, mask, 1); await d.wait(70);
    if (c.name === 'stick') { await d.mouse('mouseMoved', c.x + 40, c.y - 40, b, mask, 0); await d.wait(70); }
    const mid = await snap();
    await d.mouse('mouseReleased', c.x, c.y, b, mask, 1); await d.wait(260);
    const after = await snap();
    if (!await alive()) { died = died || `${c.name}/${b} (after dispatch)`; grid[c.name][b] = '?'; continue; }
    grid[c.name][b] = (chg(before, mid) || chg(before, after)) ? 'FIRED' : '-';
  }
}
console.log('  control        ' + BTN.map(([b]) => b.padEnd(8)).join(''));
for (const c of controls) console.log(`  ${c.name.padEnd(14)} ` + BTN.map(([b]) => String(grid[c.name][b]).padEnd(8)).join(''));
const leak = []; for (const c of controls) for (const [b] of BTN) if (b !== 'left' && grid[c.name][b] === 'FIRED') leak.push(`${c.name}/${b}`);
const leftWorks = controls.filter(c => grid[c.name].left === 'FIRED').length;
console.log(`\n  secondary buttons that fired a verb: ${leak.length ? leak.join(', ') : 'none'}`);
console.log(`  BRANCH CHECK — the same dispatch on PRIMARY fired: ${leftWorks}/${controls.length}`);
console.log(`  main-frame navigations during the run: ${navs}${died ? `   page context lost at ${died}` : ''}`);
console.log('errs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
