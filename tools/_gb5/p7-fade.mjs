/* PROBE 7 — two things probe 6 measured badly.

   (a) RPT-1/2 read the card through the typewriter's GHOST span, so
       every page came back doubled ("PAGE ONEPAGE ONE") and a string
       compare failed on a correct result. Re-read properly.
   (b) FD-1 pressed while the controls were ALREADY faded, so the press
       never reached the button and the test passed for the wrong
       reason. Steal the focus while the pad is LIVE, then let it fade
       under the stolen focus, then press Space. */
import { boot, padProbe, padRead, panelsNow, nearId, boxes } from './lib.mjs';

const R = await boot({ mobile: true });
const { page, ok, mousePress, touch, press } = R;

const BOOT = await page.evaluate(() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; });
const toOpenGround = () => page.evaluate((b) => {
  WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.wally.warpTo(b.x, b.y + 0.3, b.z, {});
}, BOOT);
const toDoor = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.hide('dialogue'); WALLY.debug.arrive('apartment', true); });
  await page.waitForTimeout(1200);
  try { await page.waitForFunction(() => WALLY.ctx.ui.near != null, { timeout: 5000 }); } catch {}
  await page.waitForTimeout(300);
  return nearId(page);
};
const hush = async () => {
  await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); });
  await page.waitForTimeout(700);
};
const blur = () => page.evaluate(() => document.activeElement?.blur?.());
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  return a === document.body ? 'BODY' : (a?.getAttribute?.('aria-label') || a?.tagName || null);
});
/* the LIVE span, not the ghost the card sizes itself with */
const cardPage = () => page.evaluate(() => {
  const tx = document.querySelector('.w-dlg .w-dlg-tx');
  if (!tx) return null;
  const spans = [...tx.querySelectorAll('span')];
  const t = (spans.length ? spans[spans.length - 1].textContent : tx.textContent) || '';
  return t.replace(/\s+/g, ' ').trim();
});
const idle = (s) => page.evaluate((v) => WALLY.debug.idle(v), s);

await page.evaluate(() => WALLY.debug.hideUI(false));
await page.waitForTimeout(500);
const B = await boxes(page);

/* ---------- (a) three rapid Enters ---------- */
await toOpenGround(); await hush();
await padProbe(page);
await page.evaluate(() => { WALLY.ctx.ui.dialogue({ speaker: 'Rig',
  text: ['PAGE ONE', 'PAGE TWO', 'PAGE THREE', 'PAGE FOUR', 'PAGE FIVE', 'PAGE SIX'] }); return true; });
await page.waitForTimeout(700);
const seq = [await cardPage()];
for (let i = 0; i < 3; i++) { await press(B.act.x, B.act.y, 45); await page.waitForTimeout(200); seq.push(await cardPage()); }
let p = await padRead(page);
const open1 = await page.evaluate(() => !!WALLY.ctx.ui.dialogueOpen);
ok(p.act === 3 && /PAGE ONE/.test(seq[0]) && /PAGE FOUR/.test(seq[3])
  && /PAGE TWO/.test(seq[1]) && /PAGE THREE/.test(seq[2]) && open1 === true,
  'RPT-1 [three rapid Enters advance a dialogue exactly three pages]: one page per press, no drop, no double, card still open',
  `act ${p.act}, pages ${JSON.stringify(seq)}, open ${open1}`);
await hush();

/* ---------- (b) the stolen focus, and the fade ---------- */
await page.evaluate(() => WALLY.debug.hideUI(true));
await page.waitForTimeout(400);
await idle(3.0);
const doorF = await toDoor();
/* make sure the pad is LIVE at the moment of the press */
let st = await idle();
if (st.hidden) {
  await touch('touchStart', 200, 400); await touch('touchEnd', 200, 400);
  await touch('touchStart', 200, 400); await touch('touchEnd', 200, 400);
  await page.waitForTimeout(900);
  st = await idle();
}
await blur();
await padProbe(page);
await mousePress(B.act.x, B.act.y, 'right', 60);
await page.waitForTimeout(150);
const liveAtPress = (await idle()).live;
const fLive = await active();
ok(liveAtPress === true && fLive !== 'BODY',
  'FD-pre1 [the right press really landed on a LIVE Enter and took its focus]',
  `live ${liveAtPress}, activeElement ${fLive}`);
/* now hold still and let the cluster fade out under that focus */
await page.waitForTimeout(4200);
const st2 = await idle();
const fFaded = await active();
const vis = await page.evaluate(() => {
  const b = document.querySelector('.w-abtn.act');
  return { vis: getComputedStyle(b).visibility, op: getComputedStyle(b.closest('.w-acts')).opacity,
    pe: getComputedStyle(b).pointerEvents, isActive: document.activeElement === b };
});
ok(st2.hidden === true, 'FD-pre2 [the controls faded out under the stolen focus]', JSON.stringify(st2));
await page.keyboard.press('Space');
await page.waitForTimeout(900);
p = await padRead(page); let pn = await panelsNow(page);
ok(p.act === 0 && !pn.includes('place'),
  'FD-1 [Space, with the pad faded to invisible and the focus still on Enter]: nothing may fire from a control the player cannot see',
  `focus after the fade ${fFaded}, button ${JSON.stringify(vis)}, act ${p.act}, panels ${JSON.stringify(pn)}, clicks ${JSON.stringify(p.clicks.map((c) => [c.target, c.detail]))}, near ${doorF}`);
await page.evaluate(() => { WALLY.debug.hideUI(false); WALLY.debug.idle(null); WALLY.ctx.ui.closeAll(); });
await blur();

console.log(`\n${R.fails} FAIL(S)`);
await R.close();
process.exit(R.fails ? 1 : 0);
