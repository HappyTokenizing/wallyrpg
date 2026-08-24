/* introhandover.mjs — the cinematic hands the character back INTACT.
 *
 * WHY THIS EXISTS. Every other suite here boots with ?skipIntro, so the
 * WATCHED intro — what every real player sees on their first load — had
 * never been driven by a test. A bug that fired on every first visit
 * ("he moves but no walk animation or bike animation") survived eleven
 * rounds of adversarial review inside that blind spot.
 *
 * WHAT IT ASSERTS, and the four are separate on purpose: position,
 * animator speed, the leg's actual travel, and the frame counter are four
 * different failures. The bug this was written for moved the position
 * perfectly while the animator sat at zero, so any check that only asked
 * "did he move" reported healthy — mine did, twice, before I looked at
 * the right number.
 *
 * TWO TRAPS, both of which fooled this file's first drafts:
 *   · SPACE releases the boot gate AND skips the intro. Press it to get
 *     past the gate and you have skipped the thing under test. Release
 *     with a CLICK.
 *   · headless Chrome auto-allows audio, so ask() never runs and the real
 *     first-run path never happens. Launch with user-gesture-required.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
let fails = 0, passes = 0;
const ok = (c, m, d = '') => { if (c) { passes++; console.log(`PASS  ${m}`, d); } else { fails++; console.log(`FAIL  ${m}`, d); } };

const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--autoplay-policy=user-gesture-required'],
});

async function run(label, mobile) {
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }
    : { viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 90000 });

  if (mobile) await page.touchscreen.tap(195, 420); else await page.mouse.click(640, 360);
  await page.waitForTimeout(1500);

  const t0 = Date.now(); let saw = false;
  while (Date.now() - t0 < 150000) {
    const up = await page.evaluate(() => !!WALLY?.ctx?.intro?.running);
    if (up) saw = true;
    if (saw && !up) break;
    await page.waitForTimeout(500);
  }
  ok(saw, `${label}: the intro actually ran (not skipped) — the path under test`);
  await page.waitForTimeout(1500);

  const f0 = await page.evaluate(() => WALLY?.ctx?.frame ?? 0);
  const p0 = await page.evaluate(() => ({ x: WALLY.ctx.wally.root.position.x, z: WALLY.ctx.wally.root.position.z }));

  if (mobile) {
    await page.touchscreen.tap(90, 700).catch(() => {});
    await page.evaluate(() => WALLY.ctx.wally.setInput?.(() => ({ x: 0, z: 1, run: false })));
  } else await page.keyboard.down('KeyW');

  const legs = await page.evaluate(() => new Promise((res) => {
    const w = WALLY.ctx.wally; let bone = null;
    w.root.traverse((o) => { if (!bone && o.isBone && /leg|thigh|shin/i.test(o.name)) bone = o; });
    if (!bone) return res({ bone: null, range: -1 });
    const s = []; let n = 0;
    const t = () => { s.push(bone.rotation.x); if (++n < 60) requestAnimationFrame(t); else res({ bone: bone.name, range: +(Math.max(...s) - Math.min(...s)).toFixed(4) }); };
    requestAnimationFrame(t);
  }));
  await page.waitForTimeout(900);
  const st = await page.evaluate(() => {
    const w = WALLY.ctx.wally, a = w.anim ?? w.animator ?? w._anim;
    return { animSpeed: +(a?.speed ?? -1).toFixed(3), ctrlSpeed: +(w.controller?.planarSpeed ?? -1).toFixed(3),
             x: w.root.position.x, z: w.root.position.z, frame: WALLY.ctx.frame ?? 0 };
  });
  if (!mobile) await page.keyboard.up('KeyW');

  const moved = Math.hypot(st.x - p0.x, st.z - p0.z);
  ok(moved > 0.5, `${label}: he travels`, `${moved.toFixed(2)} m`);
  ok(st.frame > f0 + 30, `${label}: the frame loop is alive`, `${f0} -> ${st.frame}`);
  ok(st.ctrlSpeed > 0.5, `${label}: the controller reads a real speed`, `${st.ctrlSpeed} m/s`);
  /* THE ONE THE BUG BROKE. The animator must be told the speed the
     controller is actually producing — not a value the cinematic pinned. */
  ok(Math.abs(st.animSpeed - st.ctrlSpeed) < 0.25,
     `${label}: the animator tracks the controller — locomotion handed back`,
     `anim ${st.animSpeed} vs controller ${st.ctrlSpeed}`);
  ok(legs.range > 0.5, `${label}: the legs actually swing`, `${legs.range} rad (idle sway is ~0.16)`);
  ok(errs.length === 0, `${label}: no page errors`, errs.slice(0, 2).join(' | '));
  await ctx.close();
}

await run('desktop, watched intro', false);
await run('mobile, watched intro', true);

await browser.close(); server.close();
console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} — ${passes} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
