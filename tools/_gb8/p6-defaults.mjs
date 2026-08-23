/* round six, probe 6: did moving preventDefault suppress any OTHER
   default — the compat click, selection, scrolling? */
import { boot, boxes, padProbe2 } from '../_gb7/lib.mjs';

const t = await boot();
const { page, ok, multi } = t;
await padProbe2(page);
const b = await boxes(page);
const W = (ms) => page.waitForTimeout(ms);
const P = (x, y, id) => ({ x, y, id, radiusX: 14, radiusY: 14, force: 1 });
const tap = async (pt, id = 9, hold = 60) => {
  await multi('touchStart', [P(pt.x, pt.y, id)]); await W(hold); await multi('touchEnd', [P(pt.x, pt.y, id)]);
};

/* ---------- 6a. the trap, re-measured on a bare div in THIS build ---------- */
console.log('--- TRAP  which preventDefault kills the compatibility click? ---');
const trap = await page.evaluate(async () => {
  const out = {};
  for (const mode of ['none', 'pointerdown', 'touchstart', 'touchend']) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:20px;top:300px;width:120px;height:60px;z-index:99999;background:#0000';
    document.body.appendChild(d);
    const seen = [];
    for (const ty of ['pointerdown','touchstart','pointerup','touchend','click'])
      d.addEventListener(ty, (e) => { seen.push(ty === 'click' ? 'CLICK d' + e.detail : ty); }, false);
    if (mode !== 'none') d.addEventListener(mode, (e) => e.preventDefault(), false);
    window.__trapEl = d; window.__trapSeen = seen;
    await new Promise(r => setTimeout(r, 10));
    out[mode] = seen;
    window.__trapPending = mode;
    // driven from node below
    break;
  }
  return out;
});
/* drive each mode properly from node */
const trapRun = async (mode) => {
  await page.evaluate((m) => {
    document.querySelectorAll('.gb8trap').forEach(e => e.remove());
    const d = document.createElement('div');
    d.className = 'gb8trap';
    d.style.cssText = 'position:fixed;left:20px;top:300px;width:120px;height:60px;z-index:99999';
    document.body.appendChild(d);
    window.__seen = [];
    for (const ty of ['pointerdown','touchstart','pointerup','touchend','click'])
      d.addEventListener(ty, (e) => window.__seen.push(ty === 'click' ? 'CLICK d' + e.detail : ty), false);
    if (m !== 'none') d.addEventListener(m, (e) => e.preventDefault(), false);
  }, mode);
  await tap({ x: 80, y: 330 }, 11, 60);
  await W(350);
  const seen = await page.evaluate(() => window.__seen.slice());
  console.log(`  prevented on ${mode.padEnd(12)} -> ${JSON.stringify(seen)}`);
  return seen;
};
const tNone = await trapRun('none');
const tPd   = await trapRun('pointerdown');
const tTs   = await trapRun('touchstart');
const tTe   = await trapRun('touchend');
await page.evaluate(() => document.querySelectorAll('.gb8trap').forEach(e => e.remove()));
ok(tNone.some(s => s.startsWith('CLICK')) && tPd.some(s => s.startsWith('CLICK')),
  'TRAP-1 preventDefault on a touch POINTERDOWN does NOT suppress the compat click', JSON.stringify(tPd));
ok(!tTs.some(s => s.startsWith('CLICK')) && !tTe.some(s => s.startsWith('CLICK')),
  'TRAP-2 preventDefault on touchstart/touchend DOES suppress it',
  `ts ${JSON.stringify(tTs)}  te ${JSON.stringify(tTe)}`);

/* ---------- 6b. what click does a real pad button see? ---------- */
console.log('\n--- PAD-46  the click a pad button gets from a real finger ---');
await page.evaluate(() => { window.__bc = []; 
  for (const s of ['.w-abtn.jump', '.w-abtn.act']) {
    const el = document.querySelector(s);
    el && el.addEventListener('click', (e) => window.__bc.push({ sel: s, detail: e.detail, dp: e.defaultPrevented }), true);
  }});
await tap(b.jump, 12, 60);
await W(400);
await tap(b.act, 13, 60);
await W(400);
const bc = await page.evaluate(() => window.__bc.slice());
console.log('  clicks seen on pad buttons:', JSON.stringify(bc));
ok(bc.every(c => c.detail !== 0),
  'PAD-46 a finger-borne click on a pad button still carries detail>=1, so the AT listener refuses it',
  JSON.stringify(bc));

/* ---------- 6c. selection and scrolling ---------- */
console.log('\n--- PAD-47  selection / scrolling not newly suppressed ---');
const css = await page.evaluate(() => {
  const g = (s) => { const e = document.querySelector(s); if (!e) return null; const c = getComputedStyle(e);
    return { us: c.userSelect || c.webkitUserSelect, ta: c.touchAction }; };
  return { pad: g('.w-touch'), jump: g('.w-abtn.jump'), body: g('body'), canvas: g('canvas') };
});
console.log('  computed styles:', JSON.stringify(css));
ok(css.jump && css.jump.us === 'none',
  'PAD-47a the pad already forbids selection in CSS — preventDefault adds nothing there',
  JSON.stringify(css.jump));

/* does a phone sheet still scroll? */
await page.evaluate(() => WALLY.ctx.ui.openPhone());
await W(1000);
const scroller = await page.evaluate(() => {
  const cands = [...document.querySelectorAll('.w-phone *')].filter(e => e.scrollHeight > e.clientHeight + 20);
  if (!cands.length) return null;
  const e = cands[0]; const r = e.getBoundingClientRect();
  e.dataset.gb8 = '1';
  return { x: r.left + r.width/2, y: r.top + r.height/2, top: e.scrollTop, sh: e.scrollHeight, ch: e.clientHeight };
});
if (!scroller) { console.log('  (no scrollable region found in the phone — cannot discriminate)'); }
else {
  await multi('touchStart', [P(scroller.x, scroller.y + 60, 21)]);
  for (let i = 1; i <= 6; i++) { await multi('touchMove', [P(scroller.x, scroller.y + 60 - i*14, 21)]); await W(20); }
  await multi('touchEnd', [P(scroller.x, scroller.y - 24, 21)]);
  await W(500);
  const after = await page.evaluate(() => { const e = document.querySelector('[data-gb8="1"]'); return e ? e.scrollTop : null; });
  console.log(`  phone scroller: top ${scroller.top} -> ${after} (scrollHeight ${scroller.sh}, client ${scroller.ch})`);
  ok(after !== null && after > scroller.top,
    'PAD-47b a phone sheet still scrolls under a finger', `${scroller.top} -> ${after}`);
}
await page.evaluate(() => { for (const n of WALLY.ctx.ui.panels.slice()) WALLY.ctx.ui.hide(n); });

console.log(`\nFAILS ${t.fails}`);
console.log('ERRS', JSON.stringify(t.errs));
await t.close();
