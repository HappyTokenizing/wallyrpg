/* _gb11-e.mjs — ROUND TEN part E.
   (1) resolve the moved+signed record: poll far finer than rAF with a
       MessageChannel task loop, AND take a snapshot synchronously
       inside focusin — which runs INSIDE el.focus(), between
       `rec.signed = ...` and `rec.landed = true`, so it pins which
       attempt did what instead of inferring it a frame late.
   (2) the retry itself, with the window held open by d.padHandBackStall
       so a Tab can be placed at a CHOSEN attempt rather than raced:
       does every attempt see it, or only some?
   (3) does the yield ever leave the focus nowhere? */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot();
const d = driver(B.page, B.cdp);

await B.page.evaluate(() => {
  window.__T = []; window.__T0 = performance.now(); let seq = 0;
  const snap = (tag) => { let r = null; try { r = WALLY.debug.focusRestore(); } catch (e) {}
    return { n: ++seq, t: +(performance.now() - window.__T0).toFixed(2), tag, r }; };
  window.__snap = snap;
  const t = WALLY.ctx.ui.touch;
  const real = t.uiWillFocus;
  t.uiWillFocus = function (el) { const r = real.call(t, el);
    window.__T.push({ ...snap('SIGN'), el: el?.getAttribute?.('aria-label') || el?.tagName, ret: r }); return r; };
  document.addEventListener('focusin', (e) => {
    const a = e.target, sheet = a.closest?.('.w-sheet,.w-pause,.w-phone');
    window.__T.push({ ...snap('FOCUSIN'), el: a.getAttribute?.('aria-label') || (a.textContent || '').trim().slice(0, 12) || a.tagName,
      where: a.closest?.('.w-touch') ? 'pad' : (sheet ? (sheet.classList.contains('out') ? 'DYING' : 'panel') : 'other') });
  }, true);
  document.addEventListener('keydown', (e) => window.__T.push({ ...snap('KEY'), el: e.key + (e.shiftKey ? '+sh' : '') }), true);
  /* a task loop: far finer than rAF, so no state lives and dies
     between two samples the way it does at 16 ms */
  const mc = new MessageChannel(); let last = '';
  mc.port1.onmessage = () => { const s = snap('poll');
    const j = JSON.stringify(s.r); if (j !== last) { last = j; window.__T.push(s); }
    mc.port2.postMessage(0); };
  mc.port2.postMessage(0);
});
const tl = () => B.page.evaluate(() => { const a = window.__T.slice(); window.__T = []; window.__T0 = performance.now(); return a; });
const fmtR = (r) => r ? `to=${r.to} a=${r.attempts} mv=${r.moved} sg=${r.signed} land=${r.landed} yld=${r.yielded} stall=${r.stall}` : 'null';
const show = (T) => T.map(x => `\n       ${String(x.n).padStart(4)} ${String(x.t).padStart(8)} ${x.tag.padEnd(8)} ${(x.el || '').toString().padEnd(14)}${x.where ? '[' + x.where + ']' : ''} | ${fmtR(x.r)}`).join('');

const stale = async () => { await d.reset(); const t = await d.tabTo('Menu'); await d.thumb('Jump', 110, 240); return t; };
const openPause = async () => { await d.thumb('Menu', 70, 340); return (await d.panels()).includes('pause'); };

console.log('\n=== 1. TWO Tabs straddling the close, at sub-frame resolution ===');
for (let i = 0; i < 2; i++) {
  await stale(); await openPause(); await d.wait(320);
  const rb = await d.btnIn('resume');
  await tl();
  await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
  await d.keyDown('Tab'); await d.keyUp('Tab');
  await d.keyDown('Tab'); await d.keyUp('Tab');
  await d.wait(800);
  const T = await tl(); const kb = await d.padKb(); const f = await d.focusNow();
  console.log(`  run${i} deaf=${kb.driving} end=${f.where}/${f.label}${show(T.filter(x => x.tag !== 'poll' || x.r))}`);
}

console.log('\n=== 2. the retry, window held open: a Tab placed at a CHOSEN attempt ===');
console.log('    (d.padHandBackStall(n) adds n no-op attempts before the landing one)');
for (const stall of [0, 4, 10]) {
  for (const at of ['before-close', 'mid-window']) {
    await stale(); await openPause(); await d.wait(320);
    await B.page.evaluate((n) => WALLY.debug.padHandBackStall(n), stall);
    const rb = await d.btnIn('resume');
    await tl();
    if (at === 'before-close') {
      await d.key('Tab', 20); await d.wait(120);
      await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
    } else {
      await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
      await d.wait(Math.max(1, stall * 8));           // inside the widened window
      await d.keyDown('Tab'); await d.keyUp('Tab');
    }
    await d.wait(900);
    const T = await tl(); const kb = await d.padKb(); const f = await d.focusNow(); const r = await d.restore();
    const attempts = T.filter(x => x.r).map(x => x.r.attempts);
    console.log(`  stall=${String(stall).padStart(2)} tab=${at.padEnd(12)} deaf=${String(kb.driving).padEnd(5)} end=${f.where}/${f.label} final=[${fmtR(r)}] attemptsSeen=${Math.max(...attempts, 0)} signs=${T.filter(x => x.tag === 'SIGN').length}`);
  }
}
await B.page.evaluate(() => WALLY.debug.padHandBackStall(0));

console.log('\n=== 3. can the yield leave the keyboard nowhere? ===');
console.log('    the shipping arm cannot return without focusing; the rejected');
console.log('    arm can. Both measured on this page so the claim is a number.');
for (const mode of ['sign', 'none', 'all']) {
  let body = 0, deaf = 0, land = 0, n = 0;
  for (let i = 0; i < 5; i++) {
    await B.page.evaluate((m) => WALLY.debug.padHandBackYield(m), mode);
    await stale(); await openPause(); await d.wait(300);
    const rb = await d.btnIn('resume');
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
    await d.keyDown('Tab'); await d.keyUp('Tab');
    await d.wait(900);
    const kb = await d.padKb(); const f = await d.focusNow(); const r = await d.restore();
    n++; if (f.where === 'body') body++; if (kb.driving) deaf++; if (r?.landed) land++;
  }
  console.log(`  yield=${mode.padEnd(5)} deaf ${deaf}/${n}   ring left on <body> ${body}/${n}   hand-back landed ${land}/${n}`);
}
await B.page.evaluate(() => WALLY.debug.padHandBackYield('sign'));

console.log('\nerrs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
