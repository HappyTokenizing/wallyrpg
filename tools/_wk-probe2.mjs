/* _wk-probe2.mjs — cost at range, terrain gradient census, intro residue.
   node tools/_wk-probe2.mjs <what>
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const WHAT = process.argv[2] || 'range';

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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
const q = WHAT === 'intro' ? '' : '?skipIntro';
await page.goto(`http://127.0.0.1:${port}/index.html${q}`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(3500);
const say = (k, v) => console.error(k + ' ' + JSON.stringify(v));

if (WHAT === 'range') {
  /* A REALLY PARKED bicycle (the game's own dismount path put it
     there), then walk the PLAYER away from it and difference
     renderer.info with the prop in and out on alternate frames. */
  await page.evaluate(() => {
    const c = window.WALLY.ctx, w = c.wally;
    const cy = c.world.city || c.city;
    const v = cy.doorPosition('apartment');
    const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : 0; } catch (e) { return 0; } };
    w.setPosition(v.x + 3, H(v.x + 3, v.z + 1), v.z + 1);
    c.game.actions.grantRide('bike');
    c.game.actions.equipRide('bike');
  });
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
  await page.waitForTimeout(2400);
  /* PUT IT WHERE THE LENS IS LOOKING. The follow rig keeps its own
     orbit yaw, so setYaw on the character does not turn the camera and
     every "in front of the player" placement came back off screen. The
     prop's own position is nobody's per-frame write while it is parked
     (that is what parkedCull leaves alone), so move the BICYCLE along
     the camera's measured forward instead. */
  const rows = [];
  for (const d of [6, 18, 32, 55, 80, 110]) {
    rows.push(await page.evaluate(async (dd) => {
      const c = window.WALLY.ctx, T = window.WALLY.THREE, w = c.wally, r = c.renderer;
      const b = w.rideProps.bike;
      const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : 0; } catch (e) { return 0; } };
      const fwd = new T.Vector3(); c.camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const x = c.camera.position.x + fwd.x * dd, z = c.camera.position.z + fwd.z * dd;
      b.group.position.set(x, H(x, z), z);
      const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res({
        calls: r.info.render.calls, tris: r.info.render.triangles }))));
      for (let i = 0; i < 6; i++) await frame();
      const med = (a2, k) => { const s2 = a2.map((q) => q[k]).sort((p, q2) => p - q2); return s2[s2.length >> 1]; };
      /* TOGGLE LAYERS, NOT `visible`: parkedCull() rewrites `visible`
         every frame from the camera distance, so a visible-toggle
         measures nothing. Layer masks are nobody else's business. */
      const masks = [];
      b.group.traverse((o) => masks.push([o, o.layers.mask]));
      const on = [], off = [];
      for (let i = 0; i < 16; i++) {
        const want = (i % 2) === 0;
        for (const [o, m] of masks) o.layers.mask = want ? m : 0;
        const s = await frame();
        (want ? on : off).push(s);
      }
      for (const [o, m] of masks) o.layers.mask = m;
      const box = new T.Box3().setFromObject(b.group);
      const sph = box.getBoundingSphere(new T.Sphere());
      const camD = c.camera.position.distanceTo(sph.center);
      const fovS = 720 / (2 * Math.tan(c.camera.fov * Math.PI / 360));
      const sc = sph.center.clone().project(c.camera);
      let vis = 0, hvis = 0;
      b.group.traverse((o) => { if (o.isMesh) { if (o.userData.isOutlineHull) { if (o.visible) hvis++; } else if (o.visible) vis++; } });
      return { d: dd, camD: +camD.toFixed(1),
        px: +((2 * sph.radius / Math.max(0.05, camD)) * fovS).toFixed(1),
        onScreen: sc.z > -1 && sc.z < 1 && Math.abs(sc.x) < 1 && Math.abs(sc.y) < 1,
        groupVisible: b.group.visible, meshesOn: vis, hullsOn: hvis,
        dCalls: med(on, 'calls') - med(off, 'calls'), dTris: med(on, 'tris') - med(off, 'tris') };
    }, d));
  }
  say('range', rows);
}

if (WHAT === 'shadow') {
  /* Is a parked machine's CAST shadow visible at range? Screenshot the
     same frame with castShadow on and off and count changed pixels. */
  await page.evaluate(() => {
    const c = window.WALLY.ctx, w = c.wally;
    const cy = c.world.city || c.city;
    const v = cy.doorPosition('apartment');
    const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : 0; } catch (e) { return 0; } };
    w.setPosition(v.x + 3, H(v.x + 3, v.z + 1), v.z + 1);
    c.game.actions.grantRide('bike');
    c.game.actions.equipRide('bike');
  });
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
  await page.waitForTimeout(2400);
  /* A CONTROL FIRST. Film grain (§3.8) is animated, so two screenshots
     of an unchanged frame already differ everywhere — the first cut of
     this measured 25% changed pixels at every range and meant nothing.
     So: shoot the frame twice with NOTHING changed, then a third time
     with castShadow off, and compare the two diffs. */
  const out = [];
  for (const d of [20, 40, 55]) {
    const place = (cs) => page.evaluate(([dd, c2]) => {
      const c = window.WALLY.ctx, T = window.WALLY.THREE, w = c.wally;
      const b = w.rideProps.bike;
      const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : 0; } catch (e) { return 0; } };
      const fwd = new T.Vector3(); c.camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const x = c.camera.position.x + fwd.x * dd, z = c.camera.position.z + fwd.z * dd;
      b.group.position.set(x, H(x, z), z);
      if (c2 !== null) b.group.traverse((o) => { if (o.isMesh && !o.userData.isOutlineHull) o.castShadow = c2; });
    }, [d, cs]);
    await place(true); await page.waitForTimeout(900);
    await page.screenshot({ path: `/tmp/wk-sh-${d}-a.png` });
    await place(null); await page.waitForTimeout(900);
    await page.screenshot({ path: `/tmp/wk-sh-${d}-b.png` });   // control: nothing changed
    await place(false); await page.waitForTimeout(900);
    await page.screenshot({ path: `/tmp/wk-sh-${d}-c.png` });   // shadow off
    await place(true);
    out.push(d);
  }
  say('shadow.shots', out);
}

if (WHAT === 'detail') {
  /* Per-mesh screen size of a parked bicycle at a spread of ranges:
     how many of the 53 draw calls are for something the eye cannot
     resolve at all. */
  await page.evaluate(() => {
    const c = window.WALLY.ctx, w = c.wally;
    const cy = c.world.city || c.city;
    const v = cy.doorPosition('apartment');
    const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : 0; } catch (e) { return 0; } };
    w.setPosition(v.x + 3, H(v.x + 3, v.z + 1), v.z + 1);
    c.game.actions.grantRide('bike');
    c.game.actions.equipRide('bike');
  });
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.WALLY.ctx.game.actions.equipRide(null));
  await page.waitForTimeout(2400);
  say('detail', await page.evaluate(() => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE, w = c.wally;
    const b = w.rideProps.bike;
    const fovS = 900 / (2 * Math.tan(c.camera.fov * Math.PI / 360));
    const rows = [];
    const items = [];
    b.group.updateMatrixWorld(true);
    b.group.traverse((o) => {
      if (!o.isMesh || !o.geometry || o.userData.isOutlineHull) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const s = o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
      items.push({ name: o.name || 'anon', r: s.radius });
    });
    for (const d of [8, 16, 24, 32, 45, 64]) {
      const px = items.map((it) => (2 * it.r / d) * fovS);
      rows.push({ d, meshes: items.length,
        under1: px.filter((p) => p < 1).length,
        under2: px.filter((p) => p < 2).length,
        under3: px.filter((p) => p < 3).length,
        under4: px.filter((p) => p < 4).length,
        biggestPx: +Math.max(...px).toFixed(1) });
    }
    return rows;
  }));
}

if (WHAT === 'grad') {
  /* How steep does ground he can actually be standing on get? Sampled
     over the whole walkable island on a 3 m grid, wheelbase-length
     chords in the worst heading at each point. */
  say('grad', await page.evaluate(() => {
    const c = window.WALLY.ctx;
    const H = (x, z) => { try { const h = c.world.heightAt(x, z); return Number.isFinite(h) ? h : null; } catch (e) { return null; } };
    const B = 0.94;
    const hist = new Array(60).fill(0);
    let n = 0, worst = 0, worstAt = null;
    const walk = (x, z) => { try { return c.world.walkable ? c.world.walkable(x, z) !== false : true; } catch (e) { return true; } };
    for (let x = -520; x <= 520; x += 3) {
      for (let z = -520; z <= 520; z += 3) {
        const h0 = H(x, z);
        if (h0 == null || h0 < 0.4) continue;      // sea / beach
        if (!walk(x, z)) continue;
        let best = 0;
        for (let a = 0; a < 6; a++) {
          const th = (a / 6) * Math.PI;
          const fx = Math.sin(th), fz = Math.cos(th);
          const hf = H(x + fx * B * 0.5, z + fz * B * 0.5), hr = H(x - fx * B * 0.5, z - fz * B * 0.5);
          if (hf == null || hr == null) continue;
          best = Math.max(best, Math.abs(Math.atan2(hf - hr, B)));
        }
        const d = best * 180 / Math.PI;
        n++;
        hist[Math.min(59, Math.floor(d))]++;
        if (d > worst) { worst = d; worstAt = [x, z]; }
      }
    }
    const cum = [];
    let acc = 0;
    for (let i = 0; i < 60; i++) { acc += hist[i]; cum.push(acc / n); }
    const pct = (p) => { for (let i = 0; i < 60; i++) if (cum[i] >= p) return i + 1; return 60; };
    return { samples: n, worstDeg: +worst.toFixed(2), worstAt,
      p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), p999: pct(0.999), p9999: pct(0.9999),
      over15: +((1 - cum[14]) * 100).toFixed(3), over20: +((1 - cum[19]) * 100).toFixed(3),
      over25: +((1 - cum[24]) * 100).toFixed(3), over30: +((1 - cum[29]) * 100).toFixed(3) };
  }));
}

if (WHAT === 'intro') {
  await page.evaluate(() => window.WALLY.debug.begin && window.WALLY.debug.begin());
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.WALLY.debug.playIntro());
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => window.WALLY.debug.introState());
    if (st.finished) break;
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2500);
  const look = async () => page.evaluate(() => {
    const c = window.WALLY.ctx, T = window.WALLY.THREE;
    let found = null;
    c.scene.traverse((o) => { if (o.name === 'intro.bicycle') found = o; });
    const shown = (o) => { for (let n = o; n; n = n.parent) if (n.visible === false) return false; return true; };
    const p = c.wally.root.position;
    if (!found) return { present: false, playerAt: p.toArray().map((v) => +v.toFixed(2)) };
    const wp = new T.Vector3(); found.getWorldPosition(wp);
    const fwd = new T.Vector3(); c.camera.getWorldDirection(fwd);
    const to = wp.clone().sub(c.camera.position).normalize();
    return { present: true, visible: shown(found), at: wp.toArray().map((v) => +v.toFixed(2)),
      distFromPlayer: +wp.distanceTo(p).toFixed(2), camFwdDot: +fwd.dot(to).toFixed(2),
      ownsBike: c.game.actions.bike().owned };
  });
  say('intro.atHandover', await look());
  await page.waitForTimeout(3200);
  say('intro.after3s', await look());
  /* walk away, as a player does — real held keys, the follow rig's own
     camera. The bicycle should be gone the first frame it is out of
     shot, and the player must never have watched it go. */
  await page.mouse.click(640, 400);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1600);
  say('intro.walking1_6s', await look());
  await page.waitForTimeout(2600);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(700);
  say('intro.afterWalkAway', await look());
}

console.error('ERRS ' + JSON.stringify(errs.slice(0, 6)));
await browser.close();
server.close();
