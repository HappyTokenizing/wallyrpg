/* GB13-G — the sweep again, with NODE IDENTITY instead of labels.
   Round eleven's own F-2 compared rec.movedTo (a className) against
   focusNow().label (a text slice) and called five identical nodes a
   lost destination. Here the player's Tab destination is STAMPED on
   the node itself the instant it lands, and the question asked at the
   end is "is activeElement that same node". */
import { boot, driver, loadNow, kbState } from './_gb13-lib.mjs';
const say = (id, v, note) => console.log(`${v.padEnd(7)} ${id}  ${note}`);
const b = await boot();
const d = driver(b.page, b.cdp);
await b.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
await b.page.bringToFront(); await d.wait(250);
console.log('BOOT  ' + loadNow('at boot'));

const arm = async () => { await b.page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.debug.kbReset(); }); await d.wait(320); };
const stamp = () => b.page.evaluate(() => {
  document.querySelectorAll('[data-gb13dest]').forEach(e => e.removeAttribute('data-gb13dest'));
  const a = document.activeElement;
  if (!a || a === document.body) return { dest: null, where: 'body' };
  a.setAttribute('data-gb13dest', '1');
  const sheet = a.closest?.('.w-sheet,.w-pause,.w-phone');
  return { dest: a.getAttribute('aria-label') || (a.textContent||'').trim().slice(0,20) || a.className,
    where: a.closest?.('.w-touch') ? 'pad' : (sheet ? (sheet.classList.contains('out') ? 'DYING' : 'panel') : 'other') };
});
const verdict = () => b.page.evaluate(() => {
  const a = document.activeElement;
  const marked = document.querySelector('[data-gb13dest]');
  return {
    sameNode: !!marked && a === marked,
    destStillConnected: !!marked && marked.isConnected,
    onBody: !a || a === document.body,
    endedOn: a && a !== document.body
      ? (a.getAttribute?.('aria-label') || (a.textContent||'').trim().slice(0,20) || a.className) : null,
  };
});

async function one(dir, stall, off) {
  await arm();
  await b.page.evaluate((n) => WALLY.debug.padHandBackStall(n), stall);
  await d.thumb('Menu', 70, 420);
  const resume = await d.btnIn('resume|close|back');
  if (!resume) return { off, skip: 'NOBTN' };
  await d.touch('touchStart', resume.x, resume.y); await d.wait(50);
  await d.touch('touchEnd', resume.x, resume.y);
  await d.wait(off);
  await d.key('Tab', 8, dir === 'shift' ? d.SHIFT : 0);
  await d.wait(30);
  const s = await stamp();                       // where the PLAYER's keystroke put them
  await d.wait(1100);                            // window closes, fade completes
  await b.page.evaluate(() => WALLY.debug.padHandBackStall(0));
  const r = await b.page.evaluate(() => WALLY.debug.focusRestore());
  const v = await verdict();
  const k = await kbState(b.page);
  return { off, dir, dest: s.dest, destWhere: s.where, ...v,
    moved: r?.moved, kept: r?.kept, site: r?.site, landed: r?.landed, takesSpace: k.padTakesSpace };
}

const OFF = [0, 40, 90, 150, 220];
const rows = [];
for (const dir of ['fwd', 'shift']) for (const off of OFF) rows.push(await one(dir, 14, off));

const f = (r) => r.skip ? `${r.dir} off${r.off} ${r.skip}`
  : `${r.dir.padEnd(5)} off${String(r.off).padStart(3)} tabbed->"${r.dest}"[${r.destWhere}] `
  + `moved=${r.moved} kept=${r.kept} site=${r.site} | ended="${r.endedOn}" sameNode=${r.sameNode} `
  + `destAlive=${r.destStillConnected} body=${r.onBody} takesSpace=${r.takesSpace}`;
rows.forEach(r => console.log('    ' + f(r)));

/* THE FAILURE: the player's keystroke landed somewhere LIVE that
   outlived the close, and the hand-back moved them off it anyway. */
const stolen = rows.filter(r => !r.skip && r.destWhere !== 'DYING' && r.destWhere !== 'body'
  && r.destStillConnected && !r.sameNode);
const toBody = rows.filter(r => !r.skip && r.onBody);
say('G-1', stolen.length ? 'BROKEN' : 'FINE',
  `${rows.filter(r=>!r.skip).length} sweeps, both directions, offsets ${OFF.join('/')}ms inside a 14-frame window: `
  + `${stolen.length} had a LIVE surviving destination taken away, ${toBody.length} ended on <body>  (${loadNow()})`);
stolen.forEach(r => console.log('      STOLEN: ' + f(r)));

/* G-2: the guard KB-13 claims — a Tab with no survivor must NOT yield */
const dying = rows.filter(r => !r.skip && r.destWhere === 'DYING');
say('G-2', dying.every(r => r.kept === false) ? 'FINE' : 'BROKEN',
  `${dying.length} sweeps landed INSIDE the dying panel; kept(yield) fired on `
  + `${dying.filter(r=>r.kept).length} of them — must be zero, else G-1 is a hand-back that has stopped working`);

console.log('\nERRORS: ' + (b.errs.length ? b.errs.join(' | ') : 'none'));
console.log('END   ' + loadNow('at end'));
await b.close();
