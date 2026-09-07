#!/usr/bin/env node
/* _j31-invneg.mjs — JUDGE 31. THE NEGATIVE CONTROL FOR INVARIANT 4.

   mobilebugs PR-17..PR-21 now implement the invariant _k27-guard.mjs
   only declared. It passes. That is not yet evidence: a check that
   cannot fail is the same species as the header that claimed
   coverage. So the SAME INSTRUMENT is pointed at a world where the
   thing it guards is genuinely broken.

   THE INSTRUMENT IS NOT RE-TYPED. GRASSPX() and SCENECOUNT() are
   sliced verbatim out of tools/mobilebugs.mjs at run time and their
   byte length is printed, so this cannot drift from the check it is
   validating.

   FOUR SABOTAGES, each a real regression shape rather than a poke at
   the lever the check itself uses:
     S1  foliageDensity(0)      the grass field rebuilt empty
     S2  shadowMap.enabled=false  the shadow pass switched off
     S3  csm.setFar(0.5) held    every cascade ends before the ground
     S4  grass AND shadows both
   Each is applied at pr 1 and pr 2 and scored by the actual PR-17..21
   predicates, copied from mobilebugs and printed beside each verdict. */
import { boot, sleep, load1 } from './_j26-lib.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './_j26-lib.mjs';

const src = await readFile(join(ROOT, 'tools/mobilebugs.mjs'), 'utf8');
const slice = (from, to) => {
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('could not slice ' + from);
  return src.slice(a, b).trimEnd().replace(/;$/, '');
};
const GRASSPX_SRC = slice('const GRASSPX = () => {', 'const SCENECOUNT = () => {').replace(/^const GRASSPX = /, '');
const SCENECOUNT_SRC = slice('const SCENECOUNT = () => {', '/* THE PLACE, ASSERTED.').replace(/^const SCENECOUNT = /, '');
console.log(`# _j31-invneg — GRASSPX ${GRASSPX_SRC.length} bytes and SCENECOUNT ${SCENECOUNT_SRC.length} bytes sliced VERBATIM from tools/mobilebugs.mjs.`);
console.log('# rig: headless Chrome channel=chrome, ANGLE Metal, M1 Max, phone 390x844 hasTouch+isMobile+Pixel7 UA @ dsf 3, tier med, h07.0, cafe, world frozen, grain off.');


const F = (s, n) => String(s).padEnd(n);
const SAB = {
  none:      "() => ({ note: 'healthy — no sabotage' })",
  grass:     "() => { WALLY.debug.foliageDensity(0); return { note: 'foliageDensity(0) — the grass field rebuilt empty' }; }",
  shadowmap: "() => { WALLY.ctx.renderer.shadowMap.enabled = false; WALLY.ctx.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; }); return { note: 'renderer.shadowMap.enabled = false — the shadow pass switched off' }; }",
  csmfar:    "() => { WALLY.ctx.render.csm.setFar(0.5); return { note: 'csm.setFar(0.5) held — every cascade ends before the ground does' }; }",
  both:      "() => { WALLY.debug.foliageDensity(0); WALLY.ctx.renderer.shadowMap.enabled = false; WALLY.ctx.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; }); return { note: 'grass field empty AND shadow pass off' }; }",
};

/* ONE PAGE LOAD PER SABOTAGE. The first cut of this file sabotaged and
   restored on a single load and the restore was IMPOSSIBLE: the freeze
   nulls foliage.update(), so the streamer can never rebuild the field
   density(0) tore down, and every row after the grass row inherited a
   dead grass field. A negative control that cannot un-break the thing
   it broke is measuring the wrong cause. Fresh world each time. */
console.log('');
console.log('  ' + F('sabotage', 12) + F('pr', 5) + F('buffer', 12) + F('chunks', 8) + F('grass inst', 12) +
  F('casters', 9) + F('shadowMap', 11) + F('grass px', 11) + F('shadow px', 12) + 'restored');
const verdicts = [];
for (const key of ['none', 'grass', 'shadowmap', 'csmfar', 'both']) {
  const l0 = load1();
  const logs = [];
  const { page, close } = await boot({ w: 390, h: 844, dpr: 3, phone: true, logs, qs: '?skipIntro&hour=12.5' });
  await sleep(5000);
  const arrived = await page.evaluate(() => WALLY.debug.arrive('cafe', true));
  if (arrived !== true) { console.error('FATAL arrive(cafe) = ' + JSON.stringify(arrived)); await close(); process.exit(3); }
  await sleep(6000);
  await page.evaluate(() => WALLY.debug.setHour(7.0));
  await sleep(2500);
  /* SABOTAGE BEFORE THE FREEZE — a regression is present in a running
     world, not injected into a stopped one. */
  const note = await page.evaluate((k) => new Function('return (' + k + ')()')(), SAB[key]);
  await sleep(3000);
  const at = await page.evaluate(() => {
    WALLY.debug.governor(false);
    WALLY.ctx.render.setGrain(0);
    for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none';
    let frozen = 0;
    for (const h of WALLY.ctx._handles || []) {
      if (!h || h === WALLY.ctx.render) continue;
      for (const k of ['update', 'lateUpdate']) if (typeof h[k] === 'function') { h[k] = () => {}; frozen++; }
    }
    const c = WALLY.ctx.camera, g = WALLY.debug.worldHeight(c.position.x, c.position.z);
    return { frozen, eye: c.position.toArray().map(v => +v.toFixed(2)), ground: g.y, zone: g.zone,
      hour: WALLY.ctx.sky?.hour ?? null };
  });
  await sleep(1200);
  const rows = [];
  for (const pr of [1, 2, 1]) {
    await page.evaluate((p) => WALLY.debug.pixelRatio(p), pr);
    await sleep(1800);
    const row = await page.evaluate(([S, G]) => {
      const scene = new Function('return (' + S + ')')()();
      const px = new Function('return (' + G + ')')()();
      return { vp: WALLY.debug.viewport(), scene, px };
    }, [SCENECOUNT_SRC, GRASSPX_SRC]);
    rows.push({ pr, ...row, drift: rows.length === 2 });
  }
  for (const r of rows) console.log('  ' + F(key + (r.drift ? '*' : ''), 12) + F(r.pr, 5) + F(r.vp.buffer.join('x'), 12) +
    F(r.scene.grassChunks, 8) + F(r.scene.grassInstances, 12) + F(r.scene.casters, 9) +
    F(String(r.scene.shadowMapOn), 11) + F((r.px.grassPx * 100).toFixed(2) + ' %', 11) +
    F((r.px.shadowPx * 100).toFixed(2) + ' %', 12) + (r.px.restoredPx * 100).toFixed(2) + ' %');
  const [a, b, aa] = rows;
  const same = (k) => a.scene[k] === b.scene[k] && a.scene[k] === aa.scene[k];
  const v = {
    'PR-17': same('grassChunks') && same('grassInstances') && same('grassTris') && same('trees') && same('treesDrawn') && a.scene.grassInstances > 0,
    'PR-18': same('casters') && same('receivers') && same('cascades') && same('mapSize') && a.scene.shadowMapOn === true && a.scene.casters > 0,
    'PR-19': a.px.grassPx > 0.05 && Math.abs(a.px.grassPx - b.px.grassPx) <= 0.02 && a.px.grassPx === aa.px.grassPx,
    'PR-20': a.px.shadowPx > 0.015 && Math.abs(a.px.shadowPx - b.px.shadowPx) <= 0.01 && a.px.shadowPx === aa.px.shadowPx,
    'PR-21': a.px.restoredPx === 0 && b.px.restoredPx === 0,
  };
  verdicts.push({ key, note: note.note, v });
  console.log('      eye ' + JSON.stringify(at.eye) + " zone '" + at.zone + "' hour " + at.hour + ' FROZEN (' + at.frozen + ' hooks) load ' + l0 + '->' + load1() +
    '  |  ' + note.note);
  console.log('      -> ' + Object.entries(v).map(([k, ok]) => `${k} ${ok ? 'pass' : 'FAIL'}`).join('   ') +
    `   pageerrors ${logs.filter(l => /PAGEERROR/.test(l)).length}`);
  await close();
}
console.log('');
console.log('  ' + F('sabotage', 12) + 'invariant-4 assertions that FAILED');
for (const x of verdicts) {
  const f = Object.entries(x.v).filter(([, ok]) => !ok).map(([k]) => k);
  console.log('  ' + F(x.key, 12) + (f.length ? f.join(', ') : '(none — all five pass)') + '   [' + x.note + ']');
}
console.log(`\n# load (1-min) at end: ${load1()}`);
