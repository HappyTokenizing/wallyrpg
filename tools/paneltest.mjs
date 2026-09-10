#!/usr/bin/env node
/* ============================================================
   paneltest.mjs — does a UI panel take movement away, and does it
   GIVE IT BACK?

   THE BUG THIS EXISTS FOR. playtest.mjs found the player frozen for the
   rest of the session after P, M and O had been opened, while
   movetest.mjs showed movement surviving P on its own. So one specific
   panel was suspected of eating the controls for good.

   WHAT THIS FILE USED TO DO, AND WHY ITS ANSWER WAS WORTHLESS. It
   pressed a key, pressed Escape ONCE, walked for three seconds and
   printed the metres. It printed

       after KeyM + Esc: moved 0 m
       after KeyO + Esc: moved 0 m
       all three in sequence: moved 0 m
       moved after reposition: 0 m

   and it exited 0, because it had no assertions in it at all — it was a
   diagnostic printer whose exit code meant nothing, and a total
   movement freeze read as a green run.

   AND THE FREEZE WAS THE TEST, NOT THE GAME. `KeyM` is not "open the
   map": ui.js runs `openPhone('places')`, so the phone opens INTO an
   app. Escape on a phone-with-an-app runs `phone.home()` and RETURNS —
   it backs out of the app to the phone's home screen, it does not close
   the phone. One Escape therefore leaves the phone standing, the game
   correctly refuses to walk while it is up, and every later step in the
   old file inherited that open panel: the KeyO reading, the
   three-in-sequence reading and the teleport reading were all taken
   with the phone still on screen. One missing Escape, four zeros.

   Measured, on this build: `KeyP` clears in one Escape, `KeyM` and
   `KeyO` in two. Those counts are printed, never assumed — the backing
   -out loop below reads `ui.panels` and stops when it is empty, so a
   panel that grows or loses a level does not silently change what this
   file is testing.

   SO WHAT IS ASSERTED HERE IS THE MECHANISM, NOT THE METRES.
   `ctx.ui.panels` is the game's own account of what is open (ui.js
   exposes the sheet stack by name). Every step reads it, backs out
   until it is empty rather than guessing at a key count, and reports
   how many Escapes that took. Movement is then required to COME BACK.

   The "0 m while a panel is open" reading is kept and asserted the
   other way up, as the control: it is the correct behaviour, and
   without it "movement came back" would pass on a build where the
   panel never took it away in the first place.

     node tools/paneltest.mjs
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
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

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 90000 });
await page.waitForTimeout(3500);

const results = [];
const check = (name, pass, detail) => results.push([name, !!pass, detail]);

const pos = () => page.evaluate(() => {
  const w = WALLY.ctx.wally;
  const p = w && w.root && w.root.position;
  const ok = p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  return { ok, x: ok ? +p.x.toFixed(2) : String(p && p.x), z: ok ? +p.z.toFixed(2) : String(p && p.z) };
});
/* The game's own account of what is open. ui.js exposes the sheet stack
   by name; a DOM selector guess (`.modal, .panel.open`) matched nothing
   on this build and reported `modal seen: false` while the phone was
   plainly up, which is how the old file missed its own finding. */
const panels = () => page.evaluate(() => (WALLY.ctx.ui?.panels ?? ['<ui.panels missing>']));

async function walk(seconds = 3) {
  const a = await pos();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
  const b = await pos();
  if (!a.ok || !b.ok) return { moved: NaN, a, b };
  return { moved: +Math.hypot(b.x - a.x, b.z - a.z).toFixed(2), a, b };
}

/* Back out until the game says nothing is open. Never press Escape on an
   empty stack: ui.js opens the PAUSE menu on that, so a fixed count of
   presses can end with more open than it started with. */
async function clearPanels(max = 5) {
  let n = 0;
  while (n < max) {
    const p = await panels();
    if (!p.length) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    n++;
  }
  return { escapes: n, left: await panels() };
}

const MOVES = 3.0;   // metres in 3 s that counts as "he can walk"

console.log('--- baseline ---');
const base = await walk();
console.log(`  moved ${base.moved} m   panels ${JSON.stringify(await panels())}`);
check(`baseline walks (>${MOVES} m in 3 s)`, base.moved > MOVES, `${base.moved} m`);

for (const key of ['KeyP', 'KeyM', 'KeyO']) {
  await page.keyboard.press(key);
  await page.waitForTimeout(1200);
  const open = await panels();
  const held = await walk(1.5);           // the control: it must NOT walk
  const cleared = await clearPanels();
  const after = await walk();
  console.log(`  ${key}: opened ${JSON.stringify(open)} -> moved ${held.moved} m while open` +
    ` -> ${cleared.escapes} Escape(s) to clear -> ${JSON.stringify(cleared.left)} -> moved ${after.moved} m`);
  check(`${key} opens something ui.panels can name`, open.length > 0, JSON.stringify(open));
  check(`${key} control: he cannot walk while it is open (<0.5 m)`, held.moved < 0.5, `${held.moved} m`);
  check(`${key} closes (stack empty)`, cleared.left.length === 0, `${cleared.escapes} Escape(s), left ${JSON.stringify(cleared.left)}`);
  check(`${key} gives movement back (>${MOVES} m)`, after.moved > MOVES, `${after.moved} m`);
}

console.log('--- all three in sequence, as playtest does ---');
for (const k of ['KeyP', 'KeyM', 'KeyO']) { await page.keyboard.press(k); await page.waitForTimeout(800); }
const seqOpen = await panels();
const seqClear = await clearPanels();
const seq = await walk(4);
console.log(`  stack was ${JSON.stringify(seqOpen)}; ${seqClear.escapes} Escape(s) -> ${JSON.stringify(seqClear.left)}; moved ${seq.moved} m`);
check('the P/M/O sequence closes completely', seqClear.left.length === 0, JSON.stringify(seqClear.left));
check(`movement survives the P/M/O sequence (>${MOVES} m)`, seq.moved > MOVES, `${seq.moved} m`);

console.log('--- NaN probe: reposition high above terrain ---');
await page.evaluate(() => {
  const w = WALLY.ctx.wally, c = w.controller;
  if (c && c.teleport) c.teleport(40, 60, 40); else w.root.position.set(40, 60, 40);
});
await page.waitForTimeout(2500);
const p2 = await pos();
const r2 = await walk();
console.log(`  position finite after reposition: ${p2.ok} ${JSON.stringify(p2)}; moved ${r2.moved} m`);
check('a drop from 60 m leaves the controller finite', p2.ok, JSON.stringify(p2));
check(`and he can still walk afterwards (>${MOVES} m)`, r2.moved > MOVES, `${r2.moved} m`);

check('no page errors', errs.length === 0, errs.length ? [...new Set(errs)].slice(0, 3).join(' | ') : 'clean');

console.log('');
let ok = true;
for (const [name, pass, detail] of results) {
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
}
console.log(ok ? '\nPASS — every panel gives movement back' : '\nFAIL — a panel is holding the controls');

await browser.close();
server.close();
process.exit(ok ? 0 : 1);
