/* GB7 PROBE 2 — is the Jump reading honest, and THE CHORDS.
   Mobile context, real mouse on a live pad. */
import { boot, boxes, padProbe2, rawMouse, MASK, walkSpeed, vy } from './lib.mjs';

const t0 = Date.now();
const R = await boot({ mobile: true });
console.log('BOOT ms', Date.now() - t0);
const { page, ok, cdp } = R;
const M = rawMouse(cdp);
const W = (ms) => page.waitForTimeout(ms);
await page.evaluate(() => WALLY.debug.hideUI(false));
await W(300);
const B = await boxes(page);
const HOME = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const reset = async () => { await page.evaluate(() => WALLY.debug.uiHide()).catch(() => {});
  await page.evaluate((h) => WALLY.ctx.wally.warpTo(h.x, h.y + 0.05, h.z, {}), HOME); await W(800); };
const arm = () => padProbe2(page);
const led = () => page.evaluate(() => ({ act: window.__pad.act, sc: window.__pad.sc,
  ev: window.__pad.ev.map(e => `${e.type} b${e.button}/m${e.buttons} ${e.target}`) }));

/* peak vy over a window — one sample can miss the impulse entirely */
async function peakVy(ms = 500) {
  return page.evaluate((d) => new Promise((res) => {
    const c = WALLY.ctx.wally?.controller; let best = -99;
    const t = setInterval(() => { const v = c && (c.velocity || c.vel); if (v) best = Math.max(best, v.y); }, 16);
    setTimeout(() => { clearInterval(t); res(+best.toFixed(3)); }, d);
  }), ms);
}
/* and the honest ground-truth: how high did he actually get? */
async function peakY(ms = 900) {
  return page.evaluate((d) => new Promise((res) => {
    const p = WALLY.ctx.wally.position; const y0 = p.y; let best = 0;
    const t = setInterval(() => { best = Math.max(best, p.y - y0); }, 16);
    setTimeout(() => { clearInterval(t); res(+best.toFixed(3)); }, d);
  }), ms);
}

/* ============ 0. IS THE JUMP PROBE HONEST? three ways to jump ============ */
await reset();
const kb = peakY(900); await W(30);
await page.keyboard.down('Space'); await W(120); await page.keyboard.up('Space');
const kbY = await kb; const kbV = 'n/a';
console.log(`JUMPTRUTH keyboard Space: rise ${kbY} m`);

await reset();
let pk = peakY(900), pv = peakVy(600); await W(30);
await R.touch('touchStart', B.jump.x, B.jump.y); await W(140); await R.touch('touchEnd', B.jump.x, B.jump.y);
const tY = await pk, tV = await pv;
console.log(`JUMPTRUTH finger on Jump: rise ${tY} m, peak vy ${tV}`);

await reset();
pk = peakY(900); pv = peakVy(600); await W(30);
await M('mouseMoved', B.jump.x, B.jump.y, 'none', 0, 'mouse');
await M('mousePressed', B.jump.x, B.jump.y, 'left', 1, 'mouse');
await W(140);
await M('mouseReleased', B.jump.x, B.jump.y, 'left', 0, 'mouse');
const mY = await pk, mV = await pv;
console.log(`JUMPTRUTH mouse primary on Jump: rise ${mY} m, peak vy ${mV}`);

ok(tY > 0.15, `JUMP-touch: a real finger on Jump leaves the ground (rise ${tY} m)`);
ok(mY > 0.15, `JUMP-mouse-primary: a mouse primary on Jump leaves the ground (rise ${mY} m)`);
if (kbY <= 0.15 && tY <= 0.15 && mY <= 0.15)
  console.log('JUMPTRUTH: NO input jumped — the probe cannot discriminate a gate defect from a jump that is off');

/* ============ 1. THE CHORDS ============
   Chrome: a second button pressed or released while another is down is a
   POINTERMOVE. Drive the four orders and read what the page actually got. */
const chords = {
  'L-down R-down L-up R-up': [['P', 'left', 1], ['P', 'right', 3], ['R', 'left', 2], ['R', 'right', 0]],
  'L-down R-down R-up L-up': [['P', 'left', 1], ['P', 'right', 3], ['R', 'right', 1], ['R', 'left', 0]],
  'R-down L-down L-up R-up': [['P', 'right', 2], ['P', 'left', 3], ['R', 'left', 2], ['R', 'right', 0]],
  'R-down L-down R-up L-up': [['P', 'right', 2], ['P', 'left', 3], ['R', 'right', 1], ['R', 'left', 0]],
};
async function runChord(x, y, seq, drag = null) {
  await M('mouseMoved', x, y, 'none', 0, 'mouse');
  let i = 0;
  for (const [k, btn, mask] of seq) {
    await M(k === 'P' ? 'mousePressed' : 'mouseReleased', x, y, btn, mask, 'mouse');
    await W(70);
    if (drag && i === 0) { for (let j = 1; j <= 5; j++) { await M('mouseMoved', x, y - 14 * j, btn, mask, 'mouse'); await W(20); } }
    i++;
  }
  await W(250);
}

for (const [name, seq] of Object.entries(chords)) {
  /* --- Enter --- */
  await reset(); await arm();
  await runChord(B.act.x, B.act.y, seq);
  let L = await led();
  ok(L.act === 0, `CHORD-Enter [${name}]: verb ran ${L.act}x, wanted 0`, L.act ? JSON.stringify(L.ev.slice(-8)) : '');
  const armed = await page.evaluate(() => document.querySelector('.w-abtn.act')?.classList.contains('down'));
  ok(armed === false, `CHORD-Enter [${name}]: not stranded armed afterwards (down=${armed})`);
  /* and the very next honest press must still work */
  await page.evaluate(() => { window.__pad.act = 0; });
  await M('mouseMoved', B.act.x, B.act.y, 'none', 0, 'mouse');
  await M('mousePressed', B.act.x, B.act.y, 'left', 1, 'mouse');
  await W(70);
  await M('mouseReleased', B.act.x, B.act.y, 'left', 0, 'mouse');
  await W(300);
  L = await led();
  ok(L.act === 1, `CHORD-Enter [${name}]: the NEXT honest press still fires (${L.act})`);

  /* --- Jump --- */
  await reset(); await arm();
  const pj = peakY(1200);
  await runChord(B.jump.x, B.jump.y, seq);
  const jY = await pj;
  const jStuck = await page.evaluate(() => document.querySelector('.w-abtn.jump')?.classList.contains('down'));
  const wantJump = seq[0][1] === 'left';
  ok(jStuck === false, `CHORD-Jump [${name}]: not stranded held afterwards (down=${jStuck})`);
  console.log(`CHORD-Jump-info [${name}]: rise ${jY} m (primary opened the chord: ${wantJump})`);

  /* --- the stick, deflected by the PRIMARY first --- */
  await reset(); await arm();
  await runChord(B.stick.x, B.stick.y, seq, true);
  const st = await page.evaluate(() => ({ t: +WALLY.debug.touchState().t.toFixed(2),
    live: document.querySelector('.w-stick')?.classList.contains('live') }));
  const spd = await walkSpeed(page);
  ok(st.t === 0 && st.live === false,
    `CHORD-stick [${name}]: back at rest after the chord (t=${st.t}, live=${st.live}, speed ${spd})`);
}

/* ============ 2. POINTERDOWN b0 WHOSE POINTERUP REPORTS ANOTHER ============
   Straight synthesis: press left, release claiming button 2. This is the
   exact shape the fire-point guard was added for, minus the chord. */
for (const [label, box, kind] of [['Enter', B.act, 'act'], ['Phone', B.sc[0], 'sc']]) {
  await reset(); await arm();
  await M('mouseMoved', box.x, box.y, 'none', 0, 'mouse');
  await M('mousePressed', box.x, box.y, 'left', 1, 'mouse');
  await W(80);
  await M('mouseReleased', box.x, box.y, 'right', 0, 'mouse');
  await W(350);
  const L = await led();
  const n = kind === 'act' ? L.act : L.sc;
  ok(n === 0, `SWAP-${label} [down b0, up b2]: verb ran ${n}x, wanted 0`, JSON.stringify(L.ev.slice(-6)));
  const stuck = await page.evaluate((s) => document.querySelector(s)?.classList.contains('down'),
    kind === 'act' ? '.w-abtn.act' : '.w-acts .shortcuts .w-abtn');
  ok(stuck === false, `SWAP-${label}: the button let go anyway (down=${stuck})`);
  await page.evaluate(() => { window.__pad.act = 0; window.__pad.sc = 0; });
  await M('mousePressed', box.x, box.y, 'left', 1, 'mouse'); await W(70);
  await M('mouseReleased', box.x, box.y, 'left', 0, 'mouse'); await W(350);
  const L2 = await led();
  ok((kind === 'act' ? L2.act : L2.sc) === 1, `SWAP-${label}: the next honest press still fires`);
}

/* the stick's mirror: down b0, drag, up b2 — must NOT strand deflected */
await reset(); await arm();
await M('mouseMoved', B.stick.x, B.stick.y, 'none', 0, 'mouse');
await M('mousePressed', B.stick.x, B.stick.y, 'left', 1, 'mouse');
for (let j = 1; j <= 5; j++) { await M('mouseMoved', B.stick.x, B.stick.y - 14 * j, 'left', 1, 'mouse'); await W(20); }
const midT = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
await M('mouseReleased', B.stick.x, B.stick.y - 70, 'right', 0, 'mouse');
await W(400);
const endT = await page.evaluate(() => +WALLY.debug.touchState().t.toFixed(2));
const endSpd = await walkSpeed(page);
ok(midT > 0.5, `SWAP-stick-pre: the primary drag really deflected it first (t=${midT})`);
ok(endT === 0, `SWAP-stick [down b0, up b2]: does NOT strand at deflection (t=${endT}, speed ${endSpd})`);

console.log(`\nFAILS ${R.fails}   pageerrors ${R.errs.length}`);
await R.close();
