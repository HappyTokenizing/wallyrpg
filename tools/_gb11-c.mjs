/* _gb11-c.mjs — ROUND TEN part C. Part B showed the Tab on the closing
   lift is delivered, moves the ring root->Resume, and is then sampled
   INTO the baseline: `from` is read when the close BEGINS, so a Tab
   pressed before that is already in it, focusMovedSince() says
   "unmoved", the hand-back signs, and the pad stays deaf.

   If that reading is right the defect is NOT A RACE AT ALL and the
   timing can be removed from the experiment entirely: press Tab with
   the sheet quietly open, wait half a second, then close. Six arms,
   one page, one load, round-robined.

   The control arm (no Tab anywhere) must stay signed and deaf — that
   is PANEL-7/PANEL-8e working, and if it moved too, this probe would
   be measuring the weather. */
import { boot, driver, load, cpus } from './_gb11-lib.mjs';

console.log('LOAD at boot:', load(), `(${cpus()} cpus)`);
const B = await boot();
const d = driver(B.page, B.cdp);

const stale = async () => { await d.reset(); const t = await d.tabTo('Menu'); await d.thumb('Jump', 110, 240); return t; };
const openPause = async () => { await d.thumb('Menu', 70, 340); return (await d.panels()).includes('pause'); };

/* after the close: does the ring's button answer a real Space?
   Two readings, because one of them alone has been wrong before:
     padTakesSpace   the pad's own answer
     panels grew     what the player actually sees                */
async function verdict() {
  const kb = await d.padKb(); const f = await d.focusNow(); const r = await d.restore();
  const before = (await d.panels()).length;
  await d.key('Space', 25); await d.wait(420);
  const after = await d.panels();
  return { deaf: kb.driving === true, kb, f, r, fired: after.length > before, after };
}

const ARMS = {
  /* 1. the quiet Tab: sheet open and settled, Tab, settle, thumb the close */
  async quietTab_thumbClose() {
    await stale(); await openPause();
    await d.wait(450);
    await d.key('Tab', 25); await d.wait(450);
    const mid = await d.focusNow();
    const rb = await d.btnIn('resume');
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
    await d.wait(700);
    return { mid, ...(await verdict()) };
  },
  /* 2. the same, closed with the KEYBOARD. Every player act after the
        last pad touch is now a keystroke and there is no contact
        anywhere near the close. */
  async quietTab_escClose() {
    await stale(); await openPause();
    await d.wait(450);
    await d.key('Tab', 25); await d.wait(450);
    const mid = await d.focusNow();
    await d.key('Escape', 25);
    await d.wait(700);
    return { mid, ...(await verdict()) };
  },
  /* 3. CONTROL: no Tab at all. Must stay signed and deaf. */
  async noTab_thumbClose() {
    await stale(); await openPause(); await d.wait(450);
    const mid = await d.focusNow();
    const rb = await d.btnIn('resume');
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
    await d.wait(700);
    return { mid, ...(await verdict()) };
  },
  /* 4. SHIFT-TAB, quiet, then thumb the close. */
  async quietShiftTab_thumbClose() {
    await stale(); await openPause(); await d.wait(450);
    await d.key('Tab', 25, d.SHIFT); await d.wait(450);
    const mid = await d.focusNow();
    const rb = await d.btnIn('resume');
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45); await d.touch('touchEnd', rb.x, rb.y);
    await d.wait(700);
    return { mid, ...(await verdict()) };
  },
  /* 5. SHIFT-TAB on the closing lift (the mirror of part A's 'race'). */
  async shiftTab_lift() {
    await stale(); await openPause(); await d.wait(300);
    const rb = await d.btnIn('resume');
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45);
    const q = d.touch('touchEnd', rb.x, rb.y);
    await d.keyDown('Tab', d.SHIFT); await d.keyUp('Tab', d.SHIFT);
    await q; await d.wait(700);
    return { mid: null, ...(await verdict()) };
  },
  /* 6. a HELD Tab: keydown, five autoRepeat keydowns, keyup, straddling
        the close. A repeat is a different event shape (e.repeat true)
        and nothing in this layer looks at it — asserted, not assumed. */
  async tabKeyRepeat_lift() {
    await stale(); await openPause(); await d.wait(300);
    const rb = await d.btnIn('resume');
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45);
    await d.keyDown('Tab');
    const q = d.touch('touchEnd', rb.x, rb.y);
    for (let i = 0; i < 5; i++) { await d.keyDown('Tab', 0, { autoRepeat: true }); await d.wait(6); }
    await q; await d.keyUp('Tab');
    await d.wait(700);
    return { mid: null, ...(await verdict()) };
  },
  /* 7. TWO Tabs in quick succession straddling the close. */
  async twoTabs_lift() {
    await stale(); await openPause(); await d.wait(300);
    const rb = await d.btnIn('resume');
    await d.touch('touchStart', rb.x, rb.y); await d.wait(45);
    await d.touch('touchEnd', rb.x, rb.y);
    await d.keyDown('Tab'); await d.keyUp('Tab');
    await d.keyDown('Tab'); await d.keyUp('Tab');
    await d.wait(700);
    return { mid: null, ...(await verdict()) };
  },
};

const names = Object.keys(ARMS);
const acc = {}; for (const n of names) acc[n] = { n: 0, deaf: 0, moved: 0, signed: 0, fired: 0, body: 0, ends: {}, mids: {} };
const N = 6;
for (let i = 0; i < N; i++) {
  for (const n of names) {
    const g = await ARMS[n]();
    const a = acc[n]; a.n++;
    if (g.deaf) a.deaf++;
    if (g.r?.moved) a.moved++;
    if (g.r?.signed) a.signed++;
    if (g.fired) a.fired++;
    if (g.f.where === 'body') a.body++;
    const e = `${g.f.where}:${g.f.label}`; a.ends[e] = (a.ends[e] || 0) + 1;
    if (g.mid) { const m = `${g.mid.where}:${g.mid.label}`; a.mids[m] = (a.mids[m] || 0) + 1; }
    if (i === 0) console.log(`  [${n}] mid=${g.mid ? g.mid.where + '/' + g.mid.label : '-'} restore=${JSON.stringify({ a: g.r?.attempts, mv: g.r?.moved, sg: g.r?.signed, from: g.r?.from, to: g.r?.to })} end=${e} deaf=${g.deaf} spaceFired=${g.fired} panels=${JSON.stringify(g.after)}`);
  }
}
console.log('\n== the timing removed: a Tab with the sheet quietly open ==');
console.log('arm                        | DEAF | moved | signed | Space fired | ring on body | ring ended | ring after the Tab');
for (const n of names) { const a = acc[n];
  console.log(`${n.padEnd(26)} | ${String(a.deaf).padStart(2)}/${a.n} |  ${String(a.moved).padStart(2)}   |  ${String(a.signed).padStart(2)}    |    ${String(a.fired).padStart(2)}/${a.n}    |      ${String(a.body).padStart(2)}      | ${JSON.stringify(a.ends)} | ${JSON.stringify(a.mids)}`); }
console.log('\nerrs:', JSON.stringify(B.errs));
console.log('LOAD at end:', load());
await B.close();
