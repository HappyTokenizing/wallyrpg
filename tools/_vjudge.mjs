#!/usr/bin/env node
/* Independent verification harness — VERIFY JUDGE.
   Real mobile context: 390x844, hasTouch, isMobile, Android UA, CDP touch. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const OUT = '/private/tmp/claude-501/-Users-herwig-Desktop-Claude-files/648e6001-7010-404a-9eea-f16c59f21a5d/scratchpad/shots';
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const URLBASE = `http://127.0.0.1:${port}/index.html`;

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });

const MOBILE = {
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
};

function mkTouch(cdp) {
  return (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }],
  });
}

async function waitReady(page, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(() => window.__WALLY_READY__ === true).catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

const R = {};

/* ============================================================
   PART 1 — LEGS
   ============================================================ */
{
  console.log('\n############ PART 1  LEGS (mobile, real touch) ############');
  const ctxB = await browser.newContext(MOBILE);
  const page = await ctxB.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.goto(URLBASE + '?skipIntro=1', { waitUntil: 'load', timeout: 90000 });
  await waitReady(page);
  await page.waitForTimeout(3000);
  const cdp = await ctxB.newCDPSession(page);
  const touch = mkTouch(cdp);

  const env = await page.evaluate(() => ({
    w: innerWidth, h: innerHeight, touchPoints: navigator.maxTouchPoints,
    ontouchstart: 'ontouchstart' in window, ua: navigator.userAgent.slice(0, 60),
    coarse: matchMedia('(hover: none) and (pointer: coarse)').matches,
    padOn: document.body.classList.contains('touch') || !!document.querySelector('.w-stick,.w-pad,[class*=stick]'),
  }));
  console.log('env:', JSON.stringify(env));

  // find the touch stick centre
  const stick = await page.evaluate(() => {
    const el = document.querySelector('[class*=stick],[class*=Stick],.w-pad');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cls: el.className, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('stick:', JSON.stringify(stick));
  const SX = stick ? stick.x : 90, SY = stick ? stick.y : 700;

  // helper: sample leg bone over N frames
  const sampleLegs = (n = 40) => page.evaluate((N) => new Promise(res => {
    const w = WALLY.ctx.wally;
    const bones = [];
    w.root.traverse(o => { if (o.isBone && /leg|thigh|shin|knee|foot/i.test(o.name)) bones.push(o); });
    if (!bones.length) return res({ bones: null });
    const pick = bones.slice(0, 6);
    const series = pick.map(() => []);
    let i = 0;
    const t = () => {
      pick.forEach((b, k) => series[k].push(+b.rotation.x.toFixed(4)));
      if (++i < N) requestAnimationFrame(t);
      else res({
        names: pick.map(b => b.name),
        ranges: series.map(s => +(Math.max(...s) - Math.min(...s)).toFixed(4)),
        first: series[0],
      });
    };
    requestAnimationFrame(t);
  }), n);

  const state = () => page.evaluate(() => {
    const c = WALLY.ctx, w = c.wally, ct = w.controller;
    let actionW = null, locoName = null, actions = null;
    try {
      const a = w.anim;
      actions = a?.mixer?._actions?.filter(x => x.isRunning?.() && x.getEffectiveWeight() > 0.001)
        .map(x => x._clip.name + '@' + x.getEffectiveWeight().toFixed(2)) ?? null;
    } catch (e) { actions = 'ERR ' + e.message; }
    return {
      speed: +(ct?.planarSpeed ?? 0).toFixed(2),
      grounded: ct?.grounded, airTime: +(ct?.airTime ?? 0).toFixed(3),
      yaw: +((w?.rotation?.y ?? 0)).toFixed(2),
      actions,
    };
  });

  console.log('\n-- idle before touch --');
  console.log(' state:', JSON.stringify(await state()));
  const idle0 = await sampleLegs(40);
  console.log(' idle leg ranges:', JSON.stringify(idle0.names), JSON.stringify(idle0.ranges));

  console.log('\n-- SMALL push (walk) --');
  await touch('touchStart', SX, SY); await page.waitForTimeout(120);
  await touch('touchMove', SX, SY - 22); await page.waitForTimeout(1500);
  const walkState = await state();
  const walkLegs = await sampleLegs(40);
  console.log(' state:', JSON.stringify(walkState));
  console.log(' leg ranges:', JSON.stringify(walkLegs.ranges), 'bones', JSON.stringify(walkLegs.names));

  console.log('\n-- FULL push (run) --');
  await touch('touchMove', SX, SY - 80); await page.waitForTimeout(1800);
  const runState = await state();
  const runLegs = await sampleLegs(40);
  console.log(' state:', JSON.stringify(runState));
  console.log(' leg ranges:', JSON.stringify(runLegs.ranges));
  R.legRangeRun = runLegs.ranges[0];
  R.legRangeWalk = walkLegs.ranges[0];
  R.legBone = runLegs.names[0];

  // screenshots half a second apart while running
  await page.screenshot({ path: join(OUT, 'legs-A.png') });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'legs-B.png') });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'legs-C.png') });

  // hold longer, sustained sample: 6 seconds of continuous holding
  console.log('\n-- sustained hold 6 s, ranges each second --');
  const sustained = [];
  for (let i = 0; i < 6; i++) {
    const s = await sampleLegs(30);
    sustained.push(s.ranges[0]);
    await page.waitForTimeout(600);
  }
  console.log(' per-second first-bone ranges:', JSON.stringify(sustained));
  R.sustained = sustained;

  console.log('\n-- release -> idle --');
  await touch('touchEnd', SX, SY - 80);
  await page.waitForTimeout(1500);
  const idleState = await state();
  const idleLegs = await sampleLegs(40);
  console.log(' state:', JSON.stringify(idleState));
  console.log(' idle leg ranges:', JSON.stringify(idleLegs.ranges));
  R.idleAfterRelease = { speed: idleState.speed, range: idleLegs.ranges[0], actions: idleState.actions };
  await page.screenshot({ path: join(OUT, 'legs-idle.png') });

  /* HEADING SWEEP — the bug was heading dependent. Turn him with the
     camera-orbit drag and walk on eight headings. */
  console.log('\n-- heading sweep (8 headings, touch stick held on each) --');
  const sweep = [];
  for (let k = 0; k < 8; k++) {
    // rotate camera by dragging in the right/free area
    await touch('touchStart', 300, 300); await page.waitForTimeout(60);
    await touch('touchMove', 300 - 46, 300); await page.waitForTimeout(120);
    await touch('touchEnd', 300 - 46, 300); await page.waitForTimeout(200);
    await touch('touchStart', SX, SY); await page.waitForTimeout(100);
    await touch('touchMove', SX, SY - 80); await page.waitForTimeout(1600);
    const s = await state();
    const l = await sampleLegs(36);
    sweep.push({ h: k, yaw: s.yaw, speed: s.speed, range: l.ranges[0], grounded: s.grounded });
    await touch('touchEnd', SX, SY - 80);
    await page.waitForTimeout(400);
  }
  console.table(sweep);
  R.sweep = sweep;
  R.sweepMin = Math.min(...sweep.map(s => s.range));

  console.log('\n page errors:', errs.length, JSON.stringify([...new Set(errs)].slice(0, 4)));
  await ctxB.close();
}

/* ============================================================
   PART 2 — POINTER
   ============================================================ */
async function pointerProbe(vp, tag, mobile) {
  const ctxB = await browser.newContext(mobile
    ? MOBILE
    : { viewport: vp, deviceScaleFactor: 1 });
  const page = await ctxB.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  await page.goto(URLBASE + '?skipIntro=1', { waitUntil: 'load', timeout: 90000 });
  await waitReady(page);
  await page.waitForTimeout(3500);

  const probe = async () => page.evaluate(() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
    const ptr = document.querySelector('.w-ptr');
    const kAll = [...document.querySelectorAll('.w-k')];
    const pillOf = (label) => {
      const k = kAll.find(e => (e.textContent || '').trim().toUpperCase() === label);
      return k ? k.closest('.w-pill') : null;
    };
    const rep = pillOf('REP'), city = pillOf('CITY');
    const cs = ptr ? getComputedStyle(ptr) : null;
    return {
      vw: innerWidth, vh: innerHeight,
      ptrExists: !!ptr,
      ptrOff: ptr ? ptr.classList.contains('off') : null,
      ptrRail: ptr ? ptr.classList.contains('rail') : null,
      ptrCls: ptr ? ptr.className : null,
      ptrText: ptr ? (ptr.innerText || '').replace(/\n/g, ' | ') : null,
      ptrOpacity: cs ? cs.opacity : null,
      pointer: box(ptr),
      rep: box(rep), repText: rep ? rep.innerText.replace(/\n/g, ' ') : null,
      city: box(city), cityText: city ? city.innerText.replace(/\n/g, ' ') : null,
      objective: box(document.querySelector('.w-obj')),
      leftPills: [...document.querySelectorAll('.w-bar-left .w-pill, .w-left .w-pill')].map(box),
      allPills: [...document.querySelectorAll('.w-pill')].map(e => ({ t: e.innerText.replace(/\n/g, ' ').slice(0, 24), ...box(e) })),
    };
  });

  let p = await probe();
  if (p.ptrOff) {
    // give it a destination the way the map does
    const set = await page.evaluate(() => {
      const g = WALLY.ctx.game, hud = WALLY.ctx.hud || WALLY.ctx.ui?.hud;
      const ids = Object.keys(g.data.locationById);
      const cur = g.state.loc;
      const pick = ids.find(i => i !== cur && g.known?.(i)) || ids.find(i => i !== cur);
      const h = WALLY.ctx.hud?.setDestination ? WALLY.ctx.hud : (WALLY.ctx.ui?.hud || null);
      try { return { pick, ok: !!(h && h.setDestination(pick)) }; } catch (e) { return { pick, err: e.message }; }
    });
    console.log(` [${tag}] pointer was off; setDestination ->`, JSON.stringify(set));
    await page.waitForTimeout(1200);
    p = await probe();
  }
  console.log(`\n--- ${tag} (${p.vw}x${p.vh}) ---`);
  console.log(' pointer:', JSON.stringify(p.pointer), 'rail=', p.ptrRail, 'off=', p.ptrOff, 'opacity=', p.ptrOpacity);
  console.log(' ptrText:', JSON.stringify(p.ptrText));
  console.log(' REP  :', JSON.stringify(p.rep), JSON.stringify(p.repText));
  console.log(' CITY :', JSON.stringify(p.city), JSON.stringify(p.cityText));
  console.log(' objective:', JSON.stringify(p.objective));
  console.log(' all pills:', JSON.stringify(p.allPills));
  await page.screenshot({ path: join(OUT, `pointer-${tag}.png`) });
  const errsOut = [...new Set(errs)].slice(0, 4);
  console.log(' page errors:', errs.length, JSON.stringify(errsOut));
  await ctxB.close();
  return p;
}

console.log('\n############ PART 2  POINTER ############');
R.ptrMobile = await pointerProbe(null, 'mobile390', true);
R.ptrDesktop = await pointerProbe({ width: 1600, height: 900 }, 'desktop1600', false);
R.ptrLaptop = await pointerProbe({ width: 1200, height: 800 }, 'laptop1200', false);

await browser.close();
server.close();

console.log('\n############ SUMMARY JSON ############');
console.log(JSON.stringify(R, null, 1));
