/* _gb11-a.mjs — ROUND TEN part A. The Tab, swept across the hand-back
   window at real timing: on the closing lift, +0, +8, +16, +30, +80,
   +150 ms. One page, one load, offsets round-robined so machine drift
   cannot land on one of them. Every gesture is a real dispatched
   touch and a real dispatched key.

   Two questions per gesture, not one:
     MEANING  does the pad still refuse the key afterwards (DEAF)?
     FOCUS    where did the ring end, and is that where the Tab put it? */
import { boot, driver, load, cpus, installLedger, ledger } from './_gb11-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot();
const d = driver(B.page, B.cdp);
await installLedger(B.page);

const OFFS = ['lift', 0, 8, 16, 30, 80, 150];
const N = 8;

/* the state the whole round is about: one Tab ever, then thumbs. */
const stale = async () => {
  await d.reset();
  const t = await d.tabTo('Menu');
  await d.thumb('Jump', 110, 240);
  return t;
};

async function gesture(off) {
  await stale();
  await d.thumb('Menu', 70, 320);                 // pause sheet, opened by thumb
  const rb = await d.btnIn('resume');
  if (!rb) return { bad: 'no resume' };
  await ledger(B.page);
  /* the finger closes it */
  if (off === 'lift') {
    const p = d.touch('touchStart', rb.x, rb.y);
    await p; await d.wait(45);
    const q = d.touch('touchEnd', rb.x, rb.y);    // NOT awaited: the Tab races the lift
    await d.keyDown('Tab'); await d.keyUp('Tab');
    await q;
  } else {
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45);
    await d.touch('touchEnd', rb.x, rb.y);
    if (off > 0) await d.wait(off);
    await d.keyDown('Tab'); await d.keyUp('Tab');
  }
  await d.wait(700);
  const L = await ledger(B.page);
  const kb = await d.padKb();
  const f = await d.focusNow();
  const r = await d.restore();
  /* ...and the meaning, end to end: press the key and see who ate it */
  const before = (await d.panels()).length;
  await d.key('Space', 25);
  await d.wait(450);
  const after = await d.panels();
  return { deaf: kb.driving === true, kb, f, r,
    L: L.filter(x => !x.out).map(x => `${x.t}:${x.where}/${x.el}`),
    fired: after.length > before, after };
}

const acc = {}; for (const o of OFFS) acc[o] = { deaf: 0, n: 0, rows: [], ends: {}, moved: 0, signed: 0, body: 0, fired: 0 };
for (let i = 0; i < N; i++) {
  for (const o of OFFS) {
    const g = await gesture(o);
    if (g.bad) { console.log('BAD', o, g.bad); continue; }
    const a = acc[o]; a.n++;
    if (g.deaf) a.deaf++;
    if (g.r?.moved) a.moved++;
    if (g.r?.signed) a.signed++;
    if (g.f.where === 'body') a.body++;
    if (g.fired) a.fired++;
    const end = `${g.f.where}:${g.f.label}`;
    a.ends[end] = (a.ends[end] || 0) + 1;
    a.rows.push(`${g.deaf ? 'DEAF' : 'ok'}/${g.r?.moved ? 'mv' : '--'}/${g.r?.signed ? 'sg' : '--'}/a${g.r?.attempts}`);
    if (i === 0) console.log(`  [${o}] ledger ${JSON.stringify(g.L)}  restore ${JSON.stringify(g.r)}  end ${end} fired=${g.fired}`);
  }
}

console.log('\n== the sweep: Tab at each offset across the hand-back window ==');
console.log('offset |  DEAF  | moved | signed | ring on body | Space fired a button | where the ring ended');
for (const o of OFFS) {
  const a = acc[o];
  console.log(`${String(o).padStart(6)} | ${String(a.deaf).padStart(2)}/${a.n}  |  ${String(a.moved).padStart(2)}   |   ${String(a.signed).padStart(2)}   |      ${String(a.body).padStart(2)}      |        ${String(a.fired).padStart(2)}/${a.n}         | ${JSON.stringify(a.ends)}`);
}
console.log('\nrows:');
for (const o of OFFS) console.log(`  ${String(o).padStart(6)}  ${acc[o].rows.join(' ')}`);
console.log('\nerrs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
