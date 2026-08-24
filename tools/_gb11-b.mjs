/* _gb11-b.mjs — ROUND TEN part B. Part A found the Tab ON THE CLOSING
   LIFT deaf 8/8 with NO focus move in the ledger. Two readings, and
   they mean opposite things:
     (i)  the key never reached the page      -> harness artifact
     (ii) it reached it and moved nothing     -> the defect
   So this probe ledgers KEYS as well as focus: every keydown at the
   document, with defaultPrevented read AFTER the fact, plus a marker
   the moment the close begins. Then it sweeps FINER, both sides of
   the lift. */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot();
const d = driver(B.page, B.cdp);

await B.page.evaluate(() => {
  window.__L = []; window.__L0 = performance.now();
  const stamp = (o) => window.__L.push({ t: +(performance.now() - window.__L0).toFixed(1), ...o });
  document.addEventListener('focusin', (e) => {
    const a = e.target, sheet = a.closest?.('.w-sheet,.w-pause,.w-phone');
    stamp({ k: 'IN', el: a.getAttribute?.('aria-label') || (a.textContent || '').trim().slice(0, 12) || a.tagName,
      where: a.closest?.('.w-touch') ? 'pad' : (sheet ? (sheet.classList.contains('out') ? 'DYING' : 'panel') : 'other') });
  }, true);
  document.addEventListener('focusout', (e) => stamp({ k: 'OUT',
    el: e.target.getAttribute?.('aria-label') || (e.target.textContent || '').trim().slice(0, 12) || e.target.tagName }), true);
  /* CAPTURE phase at the document: first thing the page sees. A second
     listener at the BUBBLE phase on window reports whether anything in
     between called preventDefault on it. */
  document.addEventListener('keydown', (e) => stamp({ k: 'KEYcap', key: e.key, sh: e.shiftKey, rep: e.repeat }), true);
  window.addEventListener('keydown', (e) => stamp({ k: 'KEYbub', key: e.key, pd: e.defaultPrevented }), false);
  document.addEventListener('click', (e) => stamp({ k: 'CLICK', detail: e.detail,
    el: e.target.getAttribute?.('aria-label') || (e.target.textContent || '').trim().slice(0, 12) || e.target.tagName }), true);
  document.addEventListener('pointerup', (e) => stamp({ k: 'PUP', pt: e.pointerType }), true);
});
const ledger = () => B.page.evaluate(() => { const l = window.__L.slice(); window.__L = []; window.__L0 = performance.now(); return l; });
const fmt = (L) => L.map(x => x.k === 'KEYcap' ? `${x.t}:KEY(${x.key}${x.sh ? '+sh' : ''}${x.rep ? ' rep' : ''})`
  : x.k === 'KEYbub' ? `${x.t}:kbub(pd=${x.pd})`
  : x.k === 'IN' ? `${x.t}:IN ${x.where}/${x.el}`
  : x.k === 'OUT' ? `${x.t}:out ${x.el}`
  : x.k === 'CLICK' ? `${x.t}:CLICK d${x.detail}/${x.el}` : `${x.t}:${x.k}`).join('  ');

const stale = async () => { await d.reset(); const t = await d.tabTo('Menu'); await d.thumb('Jump', 110, 240); return t; };

/* offset < 0 : Tab while the finger is STILL DOWN, |off| ms before the lift
   offset = 'race' : Tab dispatched without awaiting the touchEnd (part A's 'lift')
   offset >= 0 : Tab that many ms after the lift resolved            */
async function gesture(off) {
  await stale();
  await d.thumb('Menu', 70, 320);
  const rb = await d.btnIn('resume');
  await ledger();
  await d.touch('touchStart', rb.x, rb.y);
  if (typeof off === 'number' && off < 0) {
    await d.wait(45 + off > 0 ? 45 + off : 5);
    await d.keyDown('Tab'); await d.keyUp('Tab');
    await d.wait(Math.abs(off));
    await d.touch('touchEnd', rb.x, rb.y);
  } else if (off === 'race') {
    await d.wait(45);
    const q = d.touch('touchEnd', rb.x, rb.y);
    await d.keyDown('Tab'); await d.keyUp('Tab');
    await q;
  } else {
    await d.wait(45);
    await d.touch('touchEnd', rb.x, rb.y);
    if (off > 0) await d.wait(off);
    await d.keyDown('Tab'); await d.keyUp('Tab');
  }
  await d.wait(700);
  const L = await ledger();
  const kb = await d.padKb(); const f = await d.focusNow(); const r = await d.restore();
  return { deaf: kb.driving === true, kb, f, r, L };
}

const OFFS = [-40, -15, 'race', 0, 2, 4, 6];
const N = 6;
const acc = {}; for (const o of OFFS) acc[o] = { n: 0, deaf: 0, keyseen: 0, keypd: 0, moved: 0, signed: 0, ends: {}, rows: [] };
for (let i = 0; i < N; i++) {
  for (const o of OFFS) {
    const g = await gesture(o);
    const a = acc[o]; a.n++;
    if (g.deaf) a.deaf++;
    if (g.L.some(x => x.k === 'KEYcap' && x.key === 'Tab')) a.keyseen++;
    if (g.L.some(x => x.k === 'KEYbub' && x.key === 'Tab' && x.pd)) a.keypd++;
    if (g.r?.moved) a.moved++;
    if (g.r?.signed) a.signed++;
    const e = `${g.f.where}:${g.f.label}`; a.ends[e] = (a.ends[e] || 0) + 1;
    a.rows.push(g.deaf ? 'DEAF' : 'ok');
    if (i === 0) console.log(`\n[${o}] ${g.deaf ? 'DEAF' : 'ok'}  end ${e}  restore ${JSON.stringify({ a: g.r?.attempts, mv: g.r?.moved, sg: g.r?.signed })}\n     ${fmt(g.L)}`);
  }
}
console.log('\n== finer sweep either side of the lift ==');
console.log('offset | DEAF | Tab keydown seen by page | Tab defaultPrevented | moved | signed | ring ended');
for (const o of OFFS) { const a = acc[o];
  console.log(`${String(o).padStart(6)} | ${String(a.deaf).padStart(2)}/${a.n} |          ${String(a.keyseen).padStart(2)}/${a.n}             |        ${String(a.keypd).padStart(2)}/${a.n}          |  ${String(a.moved).padStart(2)}   |   ${String(a.signed).padStart(2)}   | ${JSON.stringify(a.ends)}`); }
console.log('\nerrs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
