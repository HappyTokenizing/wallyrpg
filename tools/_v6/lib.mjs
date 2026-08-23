/* VERIFY JUDGE 6 — my own harness. Static server + booted page + a
   REAL movement driver that pushes the character through wally's own
   input pipe, so every metre is covered by the controller and metered
   by the same 8 Hz sense/stride feed a player gets. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';

export const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.glsl': 'text/plain', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

export async function serve() {
  const server = createServer(async (rq, rs) => {
    const c = decodeURIComponent((rq.url || '/').split('?')[0]);
    try {
      const p = join(ROOT, c === '/' ? 'index.html' : c);
      if (!p.startsWith(ROOT)) { rs.writeHead(403).end(); return; }
      const b = await readFile(p);
      rs.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      rs.end(b);
    } catch { rs.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

export function reporter(tag = '') {
  const rows = []; let fails = 0;
  const ok = (cond, msg, extra = '') => {
    if (!cond) fails++;
    rows.push({ pass: !!cond, msg, extra });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '   ' + extra : ''}`);
    return !!cond;
  };
  const note = (m) => console.log('      ' + m);
  return { ok, note, rows, tag, get fails() { return fails; } };
}

export async function boot(opts = {}) {
  const { server, port } = await serve();
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'],
  });
  const ctxo = await browser.newContext({
    viewport: opts.viewport || { width: 1280, height: 800 },
    deviceScaleFactor: opts.dsf || 1,
    ...(opts.ctx || {}),
  });
  const page = await ctxo.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
  const q = opts.query || '?skipIntro';
  await page.goto(`http://127.0.0.1:${port}/index.html${q}`, { waitUntil: 'load', timeout: 180000 });
  page.setDefaultTimeout(180000);
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
  await page.waitForTimeout(opts.settle ?? 3500);
  await installDriver(page);
  const close = async () => { await browser.close(); server.close(); };
  return { server, port, browser, ctxo, page, errs, close, url: `http://127.0.0.1:${port}/index.html${q}` };
}

/* ---------------- the in-page driver ----------------
   walkTo(x,z) pushes wally's OWN input function with a world-space
   stick vector aimed at a target; the controller, physics, animation
   and the 8 Hz stride feed all run exactly as they do for a player.
   Nothing here calls stride(), travel() or advance(). */
export async function installDriver(page) {
  await page.evaluate(() => {
    const C = () => window.WALLY.ctx;
    window.V = {};

    V.snap = () => {
      const c = C(), st = c.game.state, p = c.wally.position;
      return {
        loc: st.loc, day: st.day, time: st.time,
        money: +st.money.toFixed(3), energy: +st.energy.toFixed(4),
        hunger: +(st.hunger || 0).toFixed(3),
        equipped: st.rides.equipped, travel: st.travel,
        route: c.game.route ? JSON.parse(JSON.stringify(c.game.route)) : null,
        routeTo: c.game.routeTo,
        metres: +(st.stats.metres || 0).toFixed(2), trips: st.stats.trips,
        pos: [+p.x.toFixed(3), +p.z.toFixed(3)],
      };
    };
    V.arrow = () => {
      const el = document.querySelector('.w-obj') || document.querySelector('#objective');
      if (!el) return { missing: true };
      const g = (s) => { const e = el.querySelector(s); return e ? (e.textContent || '').trim() : null; };
      const cs = getComputedStyle(el);
      return {
        t: g('.t'), d: g('.d'), why: g('.why'),
        cls: el.className, vis: cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.02,
        all: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      };
    };
    V.locName = (id) => (C().game.data.locationById[id] || {}).n || id;
    V.locPos = (id) => { const l = C().game.data.locationById[id]; return l ? [l.world.x, l.world.z] : null; };
    V.dist = (a, b) => { const A = V.locPos(a), B = V.locPos(b); return Math.hypot(A[0] - B[0], A[1] - B[1]); };

    /* put him exactly somewhere, and reset the stride baseline the way
       a teleport does (the MAX_STEP guard does it for us) */
    V.place = (x, z) => {
      const c = C();
      const y = c.wally.position.y;
      if (c.wally.setPosition) c.wally.setPosition(x, y, z);
      else c.wally.position.set(x, y, z);
      return [c.wally.position.x, c.wally.position.z];
    };

    V.setup = (o = {}) => {
      const c = C(), st = c.game.state;
      c.game.clearRoute('v6-setup');
      st.money = o.money ?? 5000;
      st.energy = o.energy ?? 100;
      st.hunger = o.hunger ?? 5;
      st.rides = { owned: { bike: !!o.bike, scooter: !!o.scooter, motorcycle: !!o.moto }, equipped: o.equip || null };
      st.bike = { owned: !!o.bike, equipped: o.equip === 'bike' };
      if (o.knowAll !== false) for (const l of c.game.data.locations) { st.known[l.id] = true; st.access[l.id] = true; }
      if (o.time != null) st.time = o.time;
      return V.snap();
    };

    /* ---- REAL MOVEMENT ---- */
    let drive = null;
    /* ui.js's modal stack GRABS the input function whenever a panel
       opens and hands it back to `baseInput` (null = the built-in
       WASD) when the last one closes — so opening a place sheet
       silently uninstalls this driver. Re-assert it on every aim. */
    const DRIVE_FN = (dt, ctl) => {
      if (!drive) return { x: 0, z: 0, jump: false, jumpHeld: false, run: false };
      const p = C().wally.position;
      const dx = drive.tx - p.x, dz = drive.tz - p.z;
      const d = Math.hypot(dx, dz);
      drive.d = d;
      if (d < (drive.stop || 3)) return { x: 0, z: 0, jump: false, jumpHeld: false, run: false };
      return { x: dx / d, z: dz / d, jump: false, jumpHeld: false, run: !!drive.run };
    };
    C().wally.setInput(DRIVE_FN);

    V.aim = (tx, tz, o = {}) => {
      C().wally.setInput(DRIVE_FN);
      drive = { tx, tz, stop: o.stop ?? 3, run: !!o.run, d: Infinity };
    };
    V.halt = () => { drive = null; };
    V.driveDist = () => (drive ? drive.d : null);

    /* walk toward a world point until within `stop` m or `budget` ms.
       Returns the ledger: straight-line pos delta, path length sampled
       at 20 Hz, energy spent, and whatever the route says. */
    V.walk = async (tx, tz, o = {}) => {
      const c = C();
      const before = V.snap();
      let path = 0;
      let last = { x: c.wally.position.x, z: c.wally.position.z };
      V.aim(tx, tz, o);
      const t0 = performance.now();
      const budget = o.budget ?? 30000;
      const maxPath = o.maxPath ?? Infinity;
      let stopped = 'stop-radius';
      while (performance.now() - t0 < budget) {
        await new Promise((r) => setTimeout(r, 50));
        const p = c.wally.position;
        const step = Math.hypot(p.x - last.x, p.z - last.z);
        if (step < 40) path += step;
        last = { x: p.x, z: p.z };
        if (path >= maxPath) { stopped = 'max-path'; break; }
        const d = Math.hypot(tx - p.x, tz - p.z);
        if (d < (o.stop ?? 3)) { stopped = 'arrived'; break; }
        if (performance.now() - t0 > budget - 60) stopped = 'budget';
      }
      V.halt();
      await new Promise((r) => setTimeout(r, 400));   // let the last sample land
      const after = V.snap();
      return {
        before, after, stopped,
        path: +path.toFixed(2),
        straight: +Math.hypot(after.pos[0] - before.pos[0], after.pos[1] - before.pos[1]).toFixed(2),
        odo: +(after.metres - before.metres).toFixed(3),
        energy: +(before.energy - after.energy).toFixed(4),
        mins: after.time - before.time,
      };
    };

    /* Drive a chain of waypoints, with the same sidestep recovery.
       Returns the real ledger for a real journey. */
    V.walkPath = async (pts, o = {}) => {
      const c = C();
      const before = V.snap();
      const stops = [];
      const t0 = performance.now();
      const budget = o.budget ?? 300000;
      let reached = 0;
      for (const [tx, tz] of pts) {
        if (performance.now() - t0 > budget) break;
        V.aim(tx, tz, { stop: o.stop ?? 8, run: !!o.run });
        const tl = performance.now();
        let last = null, still = 0, side = 1;
        while (performance.now() - tl < (o.legBudget ?? 60000) && performance.now() - t0 < budget) {
          await new Promise((r) => setTimeout(r, 50));
          const p = c.wally.position;
          if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.25) {
            still++;
            if (still === 20) {
              stops.push([+p.x.toFixed(1), +p.z.toFixed(1)]);
              const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz) || 1;
              V.aim(p.x - (dz / d) * 12 * side, p.z + (dx / d) * 12 * side, { stop: 2, run: !!o.run });
              await new Promise((r) => setTimeout(r, 1600));
              V.aim(tx, tz, { stop: o.stop ?? 8, run: !!o.run });
              side = -side; still = 0;
            }
          } else still = 0;
          last = { x: p.x, z: p.z };
          if (Math.hypot(tx - p.x, tz - p.z) < (o.stop ?? 8)) { reached++; break; }
        }
      }
      V.halt();
      await new Promise((r) => setTimeout(r, 400));
      const after = V.snap();
      return {
        before, after, stops, reached, of: pts.length,
        odo: +(after.metres - before.metres).toFixed(2),
        energy: +(before.energy - after.energy).toFixed(4),
        mins: +(after.time - before.time).toFixed(2),
        pos: after.pos,
      };
    };

    /* Walk out and back along a fixed straight road until `metres` of
       ODOMETER (game.stats.metres) have been covered — the same number
       for both arms of a control. */
    V.walkRoad = async (ax, az, bx, bz, metres, o = {}) => {
      const c = C();
      const before = V.snap();
      let leg = 0;
      const t0 = performance.now();
      const budget = o.budget ?? 90000;
      const stops = [];
      while ((c.game.state.stats.metres - before.metres) < metres && performance.now() - t0 < budget) {
        const tgt = leg % 2 === 0 ? [bx, bz] : [ax, az];
        V.aim(tgt[0], tgt[1], { stop: o.stop ?? 4, run: !!o.run });
        const tl = performance.now();
        let last = null, still = 0, side = 1;
        while (performance.now() - tl < (o.legBudget ?? 25000)) {
          await new Promise((r) => setTimeout(r, 50));
          if ((c.game.state.stats.metres - before.metres) >= metres) break;
          const p = c.wally.position;
          /* PEDESTRIANS ARE SOLID. A straight-line drive gets wedged
             behind whoever is standing in the street, so when nothing
             has moved for 1 s, sidestep 10 m and come back on line —
             which is what a player does and still charges every metre
             of the detour. */
          if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.25) {
            still++;
            if (still === 20) {
              stops.push([+p.x.toFixed(1), +p.z.toFixed(1)]);
              const dx = tgt[0] - p.x, dz = tgt[1] - p.z, d = Math.hypot(dx, dz) || 1;
              V.aim(p.x - (dz / d) * 10 * side, p.z + (dx / d) * 10 * side, { stop: 2, run: !!o.run });
              await new Promise((r) => setTimeout(r, 1400));
              V.aim(tgt[0], tgt[1], { stop: o.stop ?? 4, run: !!o.run });
              side = -side; still = 0;
            }
          } else still = 0;
          last = { x: p.x, z: p.z };
          if (Math.hypot(tgt[0] - p.x, tgt[1] - p.z) < (o.stop ?? 4)) break;
          if (c.game.state.loc !== before.loc) break;   // walked into a door
        }
        if ((c.game.state.stats.metres - before.metres) >= metres) break;
        if (c.game.state.loc !== before.loc) break;
        leg++;
      }
      V.halt();
      await new Promise((r) => setTimeout(r, 400));
      const after = V.snap();
      return {
        before, after, legs: leg + 1, stops,
        odo: +(after.metres - before.metres).toFixed(3),
        energy: +(before.energy - after.energy).toFixed(4),
        mins: after.time - before.time,
      };
    };
  });
}
