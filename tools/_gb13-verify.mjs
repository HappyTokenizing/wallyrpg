/* GB13-VERIFY — every finding re-driven against the FROZEN snapshot,
   because the live tree was being rewritten mid-round. */
import { boot, driver, kbState, loadNow } from './_gb13-boot2.mjs';
const say = (id, v, note) => console.log(`${v.padEnd(7)} ${id}  ${note}`);
const b = await boot();
const d = driver(b.page, b.cdp);
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
const other = await b.ctxM.newPage(); await other.goto('about:blank');
await b.page.bringToFront(); await d.wait(300);
console.log('BOOT  ' + loadNow('at boot') + '  · FROZEN SNAPSHOT · focus emulation OFF');
await b.page.evaluate(() => { window.__J = 0; WALLY.ctx.bus.on('phys:jump', () => window.__J++); });
const arm = async () => { await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); }); await d.wait(340); };
const hasFocus = () => b.page.evaluate(() => document.hasFocus());
async function trip(ms = 420) {
  await b.page.bringToFront(); await b.page.waitForTimeout(200);
  const f0 = await hasFocus();
  await other.bringToFront(); await b.page.waitForTimeout(ms);
  const f1 = await hasFocus();
  await b.page.bringToFront(); await b.page.waitForTimeout(ms);
  const f2 = await hasFocus();
  return { real: f0 && !f1 && f2, tri: `${+f0}${+f1}${+f2}` };
}

/* ===== 1. THE TAB-RETURN. 8 runs. ===== */
const runs = [];
for (let i = 0; i < 8; i++) {
  await arm();
  if (!await d.tabTo('Menu')) { runs.push('NOTAB'); continue; }
  await d.thumb('Jump', 70, 300);
  const a = await kbState(b.page);
  if (!a.driving) { runs.push('NOARM'); continue; }
  const t = await trip(400);
  const z = await kbState(b.page);
  runs.push(!t.real ? `VOID${t.tri}` : (a.driving && !z.driving ? 'FLIPPED' : 'held'));
}
const real = runs.filter(r => r === 'FLIPPED' || r === 'held').length;
const flip = runs.filter(r => r === 'FLIPPED').length;
say('V-1', flip ? 'BROKEN' : (real ? 'FINE' : 'VOID'),
  `TAB-RETURN: ${flip} of ${real} real trips took the keyboard off a thumbs player [${runs.join(',')}]  (${loadNow()})`);

/* the consequence + violations */
await arm(); await d.tabTo('Menu'); await d.thumb('Jump', 70, 300);
const t = await trip(400);
const mid = await kbState(b.page);
const p0 = await b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
await d.key('Space', 30); await d.wait(450);
const p1 = await b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
const vio = await b.page.evaluate(() => WALLY.debug.kb().violations.length);
say('V-1b', !t.real ? 'VOID' : (p1.length > p0.length ? 'BROKEN' : 'FINE'),
  `and the consequence: padTakesSpace=${mid.padTakesSpace} after the trip, one Space -> panels `
  + `${JSON.stringify(p0)} -> ${JSON.stringify(p1)}; violations recorded by the guard = ${vio} (neither half sees it)`);

/* ===== 2. THE SHEET SWAP burns the banked return address ===== */
const stampF = () => b.page.evaluate(() => {
  document.querySelectorAll('[data-v]').forEach(e => e.removeAttribute('data-v'));
  const a = document.activeElement; if (!a || a === document.body) return null;
  a.setAttribute('data-v', '1'); return a.getAttribute('aria-label') || a.className; });
const home = () => b.page.evaluate(() => {
  const m = document.querySelector('[data-v]'), a = document.activeElement;
  return { home: !!m && a === m, alive: !!m && m.isConnected, onBody: !a || a === document.body }; });
async function seq(second) {
  await arm(); if (!await d.tabTo('Menu')) return null;
  const mine = await stampF();
  await d.thumb('Menu', 70, 460);
  const p1 = await b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
  if (second) { await b.page.evaluate((s) => WALLY.debug.ui(s), second); await d.wait(520); }
  const p2 = await b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
  await d.key('Escape', 25); await d.wait(1000);
  return { mine, p1, p2, ...(await home()), rec: await b.page.evaluate(() => WALLY.debug.focusRestore()) };
}
const ctl = await seq(null);
say('V-2ctl', ctl?.home ? 'FINE' : 'BROKEN',
  `CONTROL one sheet ${JSON.stringify(ctl?.p1)}: Escape -> home=${ctl?.home} onBody=${ctl?.onBody} `
  + `site=${ctl?.rec?.site} attempts=${ctl?.rec?.attempts}`);
for (const s of ['phone', 'map']) {
  const r = await seq(s);
  say('V-2:' + s, r?.onBody ? 'BROKEN' : (r?.home ? 'FINE' : 'SUSPECT'),
    `${JSON.stringify(r?.p1)} then "${s}" REPLACED it ${JSON.stringify(r?.p2)}: Escape -> home=${r?.home} `
    + `(chosen node still alive=${r?.alive}) onBody=${r?.onBody} lastSite=${r?.rec?.site}  (${loadNow()})`);
}

/* ===== 3. THE DOUBLE ACTION ===== */
await arm();
await d.tabTo('Menu');
const s3 = await kbState(b.page);
await b.page.evaluate(() => { window.__J = 0; });
await d.key('Space', 40); await d.wait(450);
const j3 = await b.page.evaluate(() => window.__J);
const p3 = await b.page.evaluate(() => WALLY.ctx.ui.panels.slice());
say('V-3', j3 > 0 ? 'BROKEN' : 'FINE',
  `DOUBLE ACTION: player tabbed to "${s3.focus}" himself (padTakesSpace=${s3.padTakesSpace} — the keyboard `
  + `belongs to the CONTROL by the invariant's own first clause): one Space -> panels ${JSON.stringify(p3)} `
  + `AND phys:jump fired ${j3}x. wally.js binds keydown on window with no focus guard  (${loadNow()})`);

/* ===== 4. the guard's published hatch ===== */
const h = await b.page.evaluate(() => {
  WALLY.debug.kbReset();
  const el = document.querySelector('.w-abtn');
  const raw = HTMLElement.prototype.focus.__kbGuard;
  const b0 = WALLY.debug.kb().violations.length;
  raw.call(el, { preventScroll: true });
  return { present: typeof raw === 'function', delta: WALLY.debug.kb().violations.length - b0,
    landed: document.activeElement === el };
});
say('V-4', h.present && h.landed && h.delta === 0 ? 'SUSPECT' : 'FINE',
  `THE HATCH: HTMLElement.prototype.focus.__kbGuard is written as a PUBLIC property by installGuard(); `
  + `present=${h.present} focus landed=${h.landed} recorded=${h.delta}. Not player-reachable — a code-hygiene `
  + `hole, not a live defect — but it falsifies "cannot be defeated by ... a file this agent does not own"`);

/* ===== 5. the register still holds where it claims to ===== */
const reg = await b.page.evaluate(() => {
  WALLY.debug.kbReset();
  const el = document.querySelector('.w-abtn');
  const r = { unknownSite: WALLY.debug.kbFocus('gb13.not.a.site', el), smuggle: WALLY.debug.kbSmuggle('.w-abtn') };
  const rep = WALLY.debug.kb();
  return { ...r, kinds: rep.violations.map(v => v.kind), strict: rep.strict, sites: rep.sites.length };
});
say('V-5', reg.unknownSite === false && reg.kinds.includes('unknown-site') && reg.kinds.includes('focus') ? 'FINE' : 'BROKEN',
  `REGISTER: a brand-new unregistered site id is refused (${reg.unknownSite}) and recorded; a smuggled `
  + `computed-access focus is recorded. kinds=${JSON.stringify(reg.kinds)} sites=${reg.sites} strict=${reg.strict}`);

console.log('\nERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await other.close(); await b.close();
