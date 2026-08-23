/* VJ 4,6,7,8,9,10 — mobile UI, driven with real CDP touches */
import { chromium } from 'playwright-core';
import { serve, reporter } from './lib.mjs';

const { server, port } = await serve();
const R = reporter();
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });

const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctxM.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
await page.waitForTimeout(3500);

const cdp = await ctxM.newCDPSession(page);
const P = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
const tev = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : P(x, y) });
const tap = async (x, y) => { await tev('touchStart', x, y); await page.waitForTimeout(60); await tev('touchEnd', x, y); await page.waitForTimeout(320); };

await page.evaluate(() => {
  window.BOOT = (() => { const p = WALLY.ctx.wally.position; return { x: p.x, y: p.y, z: p.z }; })();
  window.openGround = () => { WALLY.ctx.ui.closeAll(); WALLY.ctx.wally.warpTo(BOOT.x, BOOT.y + 0.3, BOOT.z, {}); };
  window.rectOf = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; };
});

/* ================================================================
   10 + labels: what do the pad buttons ACTUALLY say?
   ================================================================ */
console.log('\n===== 10. TOUCH LABELS vs THE REAL BUTTONS =====');
const pad = await page.evaluate(() => {
  const out = { buttons: [], actions: null };
  for (const b of document.querySelectorAll('.w-touch button')) {
    out.buttons.push({ cls: b.className, aria: b.getAttribute('aria-label'), text: b.textContent.trim() });
  }
  return out;
});
console.log(JSON.stringify(pad.buttons, null, 1));
const ACT = await page.evaluate(async () => {
  const m = await import('/src/ui/touch.js');
  const o = {}; for (const k of Object.keys(m.ACTIONS)) o[k] = { ...m.ACTIONS[k], label: m.actionLabel(k), phrase: m.actionPhrase(k) };
  return o;
});
console.log('ACTIONS ->', JSON.stringify(ACT));
for (const [k, a] of Object.entries(ACT)) {
  const hit = pad.buttons.some((b) => (b.text || '').includes(a.touch) || (b.aria || '').toLowerCase().includes(a.touch.toLowerCase()));
  R.ok(hit || k === 'advance', `touch label "${a.touch}" (${k}) names a control that exists on the pad`,
    hit ? '' : (k === 'advance' ? '(the caption becomes this mid-conversation — checked in 7)' : 'NO BUTTON says or is named that'));
}
/* the shortcut row buttons carry the name only as an aria-label — a
   sighted player sees an icon. Say so rather than scoring it. */
console.log('  NOTE: Phone/Places/Desk/Menu appear as aria-labels only; the buttons are icon-only.');
const buyShown = await page.evaluate(() => {
  const s = [...document.querySelectorAll('*')].filter((e) => (e.textContent || '').trim() === 'Buy');
  return s.length;
});
console.log('  NOTE: ACTIONS.buy.touch = "Buy"; visible "Buy" elements on a touch build: ' + buyShown);

/* ================================================================
   7. CAPTION, three cases, measured by me
   ================================================================ */
console.log('\n===== 7. THE ACTION CAPTION, A/B/C =====');
const capOf = () => page.evaluate(() => (document.querySelector('.w-abtn.act .cap') || {}).textContent);
const nearOf = () => page.evaluate(() => WALLY.ctx.ui.near ? WALLY.ctx.ui.near.id || String(WALLY.ctx.ui.near) : null);
async function talk(ms = 900) {
  await page.evaluate(() => { WALLY.ctx.ui.dialogue({ speaker: 'Otto', text: ['A test line, long enough to be typing for a moment or two while we measure the caption.', 'And a second page so the card stays up.'] }); });
  await page.waitForTimeout(ms);
}
async function endTalk() { await page.evaluate(() => { WALLY.ctx.ui.hide('dialogue'); WALLY.ctx.ui.closeAll(); }); await page.waitForTimeout(500); }

await page.evaluate(() => window.openGround()); await page.waitForTimeout(600);
R.ok((await nearOf()) === null, 'A: open ground — nothing in range', String(await nearOf()));
const a0 = await capOf(); await talk();
const a1 = await capOf(); await endTalk();
const a2 = await capOf();
R.ok(a1 === 'More', `A: conversation in open ground -> "More"`, `${a0} -> ${a1}`);
R.ok(a2 === 'Enter / Talk', `A: reverts to "Enter / Talk"`, String(a2));

await page.evaluate(() => { const w = WALLY.ctx.city.doorPosition('apartment'); WALLY.ctx.wally.warpTo(w.x, w.y + 0.3, w.z, {}); }); await page.waitForTimeout(900);
const bNear = await nearOf();
R.ok(!!bNear, 'B: warped to a door — ui.near is real', String(bNear));
const b0 = await capOf(); await talk();
const b1 = await capOf(); await endTalk();
const b2 = await capOf();
R.ok(b0 === 'Enter / Talk', 'B: at rest in a doorway -> "Enter / Talk"', String(b0));
R.ok(b1 === 'More', 'B: conversation AT a door -> "More"', String(b1));
R.ok(b2 === 'Enter / Talk' && !!(await nearOf()), 'B: reverts with the door still in range', String(b2));

await page.evaluate(() => window.openGround()); await page.waitForTimeout(700);
await talk();
const c1 = await capOf();
await page.evaluate(() => { const w = WALLY.ctx.city.doorPosition('apartment'); WALLY.ctx.wally.warpTo(w.x, w.y + 0.3, w.z, {}); });
await page.waitForTimeout(900);
const cMid = await capOf(); const cOpen = await page.evaluate(() => !!WALLY.ctx.ui.dialogueOpen);
await endTalk();
const c2 = await capOf(); const cNear = await nearOf();
R.ok(c1 === 'More', 'C: started in open ground -> "More"', String(c1));
R.ok(cOpen, 'C: walking to a door did not cut the conversation short');
R.ok(c2 === 'Enter / Talk', 'C: ends with a door in range -> reverts to "Enter / Talk"', `${cMid} -> ${c2} (near ${cNear})`);
R.ok(!!cNear, 'C: ... and the door really was in range at the end', String(cNear));

/* ================================================================
   6. DIALOGUE IN PORTRAIT — all six controls, elementFromPoint
   ================================================================ */
console.log('\n===== 6. PORTRAIT DIALOGUE vs THE SIX CONTROLS =====');
await page.evaluate(() => window.openGround()); await page.waitForTimeout(600);
await talk(1200);
const cover = await page.evaluate(() => {
  const names = [];
  const btns = [...document.querySelectorAll('.w-touch .w-abtn')];
  for (const b of btns) {
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    names.push({
      what: (b.querySelector('.cap') || {}).textContent || b.getAttribute('aria-label'),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      hitOwn: !!(el && b.contains(el)),
      hit: el ? el.className || el.tagName : null,
    });
  }
  const st = document.querySelector('.w-stick');
  const sr = st.getBoundingClientRect();
  const sel = document.elementFromPoint(sr.x + sr.width / 2, sr.y + sr.height / 2);
  names.push({ what: 'thumbstick centre', rect: [Math.round(sr.x), Math.round(sr.y), Math.round(sr.width), Math.round(sr.height)],
    hitOwn: !!(sel && (sel.closest('.w-stickzone') || sel.closest('.w-stick'))), hit: sel ? sel.className || sel.tagName : null });
  const dr = document.querySelector('.w-dlg').getBoundingClientRect();
  return { names, dlg: [Math.round(dr.x), Math.round(dr.y), Math.round(dr.width), Math.round(dr.height)], vh: innerHeight };
});
console.log('  dialogue card rect', JSON.stringify(cover.dlg), 'viewport h', cover.vh);
for (const n of cover.names) {
  R.ok(n.hitOwn, `6. "${n.what}" is not covered by the dialogue card`, `${JSON.stringify(n.rect)} hits ${n.hit}`);
}
R.ok(cover.names.length === 7, '6. all six touch controls + stick were measured', String(cover.names.length));
await endTalk();

/* ================================================================
   8. KEY-NAME SWEEP on touch — my own, broader
   ================================================================ */
console.log('\n===== 8. KEY NAMES ON A TOUCH BUILD =====');
await page.evaluate(() => {
  window.KEYRE = /(^|[^A-Za-z])(press|hit|tap|key)?\s*(WASD|Esc(ape)?|Space(bar)?|Shift|Tab|Enter key|Ctrl|Alt|Arrow(s| keys?)?)([^A-Za-z]|$)|(^|[\s(·—\-])([EMPOB])([\s)·—.,]|$)/;
  window.sweep = () => {
    const hits = [];
    const seen = new Set();
    const walk = (root, where) => {
      const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      const push = (el, txt, kind) => {
        if (!txt) return;
        const t = String(txt).trim();
        if (!t) return;
        if (window.KEYRE.test(t)) {
          const k = where + '|' + kind + '|' + t + '|' + el.className;
          if (!seen.has(k)) { seen.add(k); hits.push({ where, kind, t, cls: el.className, tag: el.tagName }); }
        }
      };
      let el = root;
      do {
        if (!(el instanceof Element)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        /* leaf text only, so a container does not report its children */
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' ').trim();
        push(el, own, 'text');
        push(el, el.getAttribute && el.getAttribute('aria-label'), 'aria-label');
        push(el, el.getAttribute && el.getAttribute('title'), 'title');
        push(el, el.getAttribute && el.getAttribute('placeholder'), 'placeholder');
      } while ((el = it.nextNode()));
    };
    walk(document.body, window.__SURF || 'screen');
    return hits;
  };
});
const SURFACES = [
  ['HUD (open ground)', async () => { await page.evaluate(() => window.openGround()); await page.waitForTimeout(500); }],
  ['at a door', async () => { await page.evaluate(() => { const w = WALLY.ctx.city.doorPosition('apartment'); WALLY.ctx.wally.warpTo(w.x, w.y + 0.3, w.z, {}); }); await page.waitForTimeout(900); }],
  ['dialogue', async () => { await page.evaluate(() => window.openGround()); await page.waitForTimeout(400); await talk(1800); }],
  ['phone', async () => { await endTalk(); await page.evaluate(() => WALLY.ctx.ui.openPhone()); await page.waitForTimeout(700); }],
  ['phone · places', async () => { await page.evaluate(() => WALLY.ctx.ui.openPhone('places')); await page.waitForTimeout(700); }],
  ['phone · market', async () => { await page.evaluate(() => WALLY.ctx.ui.openPhone('market')); await page.waitForTimeout(700); }],
  ['phone · wallynet', async () => { await page.evaluate(() => WALLY.ctx.ui.openPhone('wallynet')); await page.waitForTimeout(700); }],
  ['desk', async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.openDesk(); }); await page.waitForTimeout(700); }],
  ['pause menu', async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.show('pause'); }); await page.waitForTimeout(700); }],
  ['settings', async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.show('settings'); }); await page.waitForTimeout(700); }],
  ['travel board', async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); const st = WALLY.ctx.game.state; st.known.stadium = true; WALLY.ctx.ui.openTravel ? WALLY.ctx.ui.openTravel('stadium') : WALLY.ctx.ui.openPhone('places'); }); await page.waitForTimeout(800); }],
  ['quick buy', async () => { await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.openQuickBuy(); }); await page.waitForTimeout(700); }],
];
let touchHits = 0;
for (const [name, go] of SURFACES) {
  await go();
  await page.evaluate((n) => { window.__SURF = n; }, name);
  const hits = await page.evaluate(() => window.sweep());
  if (hits.length) { touchHits += hits.length; console.log(`  [${name}] ${hits.length} hit(s):`); for (const hh of hits) console.log(`     (${hh.kind}) "${hh.t}"  <${hh.tag}.${hh.cls}>`); }
  else console.log(`  [${name}] clean`);
}
R.ok(touchHits === 0, `8. TOUCH: zero keyboard key names across ${SURFACES.length} surfaces`, `${touchHits} hit(s)`);
await page.evaluate(() => WALLY.ctx.ui.closeAll());

/* ================================================================
   9. HYBRID + mid-session toggle
   ================================================================ */
console.log('\n===== 9. MID-SESSION TOGGLE =====');
const toggleProbe = async () => page.evaluate(async () => {
  const m = await import('/src/ui/touch.js');
  const w = WALLY.ctx;
  const dr = document.querySelector('.w-prompt .key');
  return {
    touchUI: m.touchUI(), coarse: m.coarsePointer(),
    interact: m.actionLabel('interact'), phrase: m.actionPhrase('interact'),
    prompt: dr ? dr.textContent : null,
    hintChips: [...document.querySelectorAll('.w-hint .kb')].map((e) => e.textContent),
    hintAria: [...document.querySelectorAll('.w-hint')].map((e) => e.getAttribute('aria-label')),
    ticker: (document.querySelector('.w-pill.tap .kb') || {}).textContent,
    tickerTitle: (document.querySelector('.w-pill.tap') || {}).title,
    padOn: !!w.ui.touch.enabled,
  };
});
await page.evaluate(() => { const w = WALLY.ctx.city.doorPosition('apartment'); WALLY.ctx.wally.warpTo(w.x, w.y + 0.3, w.z, {}); });
await page.waitForTimeout(900);
const t1 = await toggleProbe(); console.log('  pad ON :', JSON.stringify(t1));
await page.evaluate(() => WALLY.ctx.ui.setTouch(false)); await page.waitForTimeout(600);
const t2 = await toggleProbe(); console.log('  pad OFF:', JSON.stringify(t2));
await page.evaluate(() => WALLY.ctx.ui.setTouch(true)); await page.waitForTimeout(600);
const t3 = await toggleProbe(); console.log('  pad ON :', JSON.stringify(t3));
R.ok(t1.interact === 'Enter' && t1.prompt === 'Enter', '9. pad on -> touch words', JSON.stringify([t1.interact, t1.prompt]));
R.ok(t2.interact === 'E' && t2.prompt === 'E', '9. pad off mid-session -> keyboard words, no reload', JSON.stringify([t2.interact, t2.prompt]));
R.ok(t3.interact === 'Enter' && t3.prompt === 'Enter', '9. and back again', JSON.stringify([t3.interact, t3.prompt]));

/* ================================================================
   4. PAD OFF + HIDE UI ON — is there a route back?
   ================================================================ */
console.log('\n===== 4. PAD OFF + HIDE UI ON =====');
/* (a) through the real Settings sheet, tapped with real touches */
await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.setTouch(true); WALLY.ctx.ui.setHideUI(false); });
await page.waitForTimeout(500);
await page.evaluate(() => { WALLY.ctx.ui.show('settings'); }); await page.waitForTimeout(700);
const rows = await page.evaluate(() => [...document.querySelectorAll('.w-kv')].map((e, i) => {
  const s = e.querySelector('.w-switch'); if (!s) return null;
  const r = s.getBoundingClientRect();
  return { i, name: (e.querySelector('span') || {}).textContent, on: s.classList.contains('on'), cx: r.x + r.width / 2, cy: r.y + r.height / 2, vis: r.height > 0 };
}).filter(Boolean));
console.log('  settings switches:', JSON.stringify(rows));
const hideRow = rows.find((r) => r.name === 'Hide UI');
const padRow = rows.find((r) => r.name === 'Touch controls');
/* scroll them into view first */
await page.evaluate(() => { const el = [...document.querySelectorAll('.w-kv')].find((e) => (e.querySelector('span') || {}).textContent === 'Hide UI'); el?.scrollIntoView({ block: 'center' }); });
await page.waitForTimeout(400);
const rows2 = await page.evaluate(() => [...document.querySelectorAll('.w-kv')].map((e) => {
  const s = e.querySelector('.w-switch'); if (!s) return null; const r = s.getBoundingClientRect();
  return { name: (e.querySelector('span') || {}).textContent, on: s.classList.contains('on'), cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}).filter(Boolean));
const hr = rows2.find((r) => r.name === 'Hide UI'), pr = rows2.find((r) => r.name === 'Touch controls');
console.log('  after scroll:', JSON.stringify([hr, pr]));

/* order 1: pad OFF first, then try Hide UI ON */
await tap(pr.cx, pr.cy);
const afterPadOff = await page.evaluate(() => ({ pad: WALLY.ctx.ui.touch.enabled, hide: WALLY.ctx.ui.hideUI }));
console.log('  after tapping Touch controls:', JSON.stringify(afterPadOff));
await tap(hr.cx, hr.cy);
const afterHide = await page.evaluate(() => ({
  pad: WALLY.ctx.ui.touch.enabled, hide: WALLY.ctx.ui.hideUI,
  sw: [...document.querySelectorAll('.w-kv')].map((e) => { const s = e.querySelector('.w-switch'); return s ? [(e.querySelector('span') || {}).textContent, s.classList.contains('on')] : null; }).filter(Boolean),
  toast: [...document.querySelectorAll('.w-toast, .w-toasts *')].map((e) => e.textContent).filter(Boolean).slice(-3),
}));
console.log('  after tapping Hide UI:', JSON.stringify(afterHide));
R.ok(!(afterHide.hide && !afterHide.pad), '4a. pad OFF then Hide UI ON is refused (or the pad came back)', JSON.stringify(afterHide));

/* order 2: Hide UI ON first, then pad OFF */
await page.evaluate(() => { WALLY.ctx.ui.setTouch(true); WALLY.ctx.ui.setHideUI(false); WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.show('settings'); });
await page.waitForTimeout(700);
await page.evaluate(() => { const el = [...document.querySelectorAll('.w-kv')].find((e) => (e.querySelector('span') || {}).textContent === 'Hide UI'); el?.scrollIntoView({ block: 'center' }); });
await page.waitForTimeout(400);
const rows3 = await page.evaluate(() => [...document.querySelectorAll('.w-kv')].map((e) => { const s = e.querySelector('.w-switch'); if (!s) return null; const r = s.getBoundingClientRect(); return { name: (e.querySelector('span') || {}).textContent, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }).filter(Boolean));
const hr3 = rows3.find((r) => r.name === 'Hide UI'), pr3 = rows3.find((r) => r.name === 'Touch controls');
await tap(hr3.cx, hr3.cy);
const s1 = await page.evaluate(() => ({ pad: WALLY.ctx.ui.touch.enabled, hide: WALLY.ctx.ui.hideUI }));
await tap(pr3.cx, pr3.cy);
const s2 = await page.evaluate(() => ({ pad: WALLY.ctx.ui.touch.enabled, hide: WALLY.ctx.ui.hideUI }));
console.log('  hide-first:', JSON.stringify(s1), '-> pad off:', JSON.stringify(s2));
R.ok(!(s2.hide && !s2.pad), '4b. Hide UI ON then pad OFF brings the HUD back', JSON.stringify(s2));

/* (c) FORCE the trap state past the UI and see what is tappable */
console.log('\n  --- the trap state, forced past the switches ---');
const trap = await page.evaluate(async () => {
  const u = WALLY.ctx.ui;
  u.closeAll(); u.setTouch(false); u.setHideUI(true);
  await new Promise((r) => setTimeout(r, 400));
  const out = [];
  for (const el of document.querySelectorAll('button, [role=button], .w-pe')) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    if (r.width < 8 || r.height < 8) continue;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    out.push({ what: (el.textContent || '').trim().slice(0, 30) || el.getAttribute('aria-label'), cls: el.className, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], reachable: !!(hit && el.contains(hit)) });
  }
  return { pad: u.touch.enabled, hide: u.hideUI, out };
});
console.log('  forced state:', JSON.stringify({ pad: trap.pad, hide: trap.hide }));
for (const o of trap.out) console.log(`    ${o.reachable ? 'TAPPABLE' : 'covered '}  "${o.what}"  ${o.cls}  ${JSON.stringify(o.rect)}`);
R.ok(trap.out.some((o) => o.reachable), '4c. even forced, SOMETHING on screen is tappable', String(trap.out.filter((o) => o.reachable).length));

/* (d) does the trap survive a reload from settings? */
const saved = await page.evaluate(() => { const s = WALLY.ctx.game.state.settings; WALLY.ctx.game.save(); return { touch: s.touch, hideUI: s.hideUI }; });
console.log('  persisted settings:', JSON.stringify(saved));
await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
await page.waitForTimeout(3500);
const reboot = await page.evaluate(() => ({ pad: WALLY.ctx.ui.touch.enabled, hide: WALLY.ctx.ui.hideUI, set: { ...WALLY.ctx.game.state.settings } }));
console.log('  after reload:', JSON.stringify(reboot));
R.ok(!(reboot.hide && !reboot.pad), '4d. a reload does not restore the trap', JSON.stringify(reboot));

await ctxM.close();

/* ================================================================
   9b. HYBRID — touchscreen WITH a fine pointer
   ================================================================ */
console.log('\n===== 9b. HYBRID: coarse + fine pointer =====');
const ctxH = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: false, deviceScaleFactor: 1 });
const hp = await ctxH.newPage();
hp.on('pageerror', (e) => errs.push('hybrid: ' + e.message.split('\n')[0]));
await hp.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
await hp.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
await hp.waitForTimeout(3000);
const hyb = await hp.evaluate(async () => {
  const m = await import('/src/ui/touch.js');
  return {
    mqCoarse: matchMedia('(pointer: coarse)').matches,
    mqAnyFine: matchMedia('(any-pointer: fine)').matches,
    mqAnyCoarse: matchMedia('(any-pointer: coarse)').matches,
    maxTouch: navigator.maxTouchPoints, ontouch: 'ontouchstart' in window,
    coarsePointer: m.coarsePointer(), touchUI: m.touchUI(),
    padOn: WALLY.ctx.ui.touch.enabled,
    interact: m.actionLabel('interact'),
    /* menus.js's OWN, SEPARATE capability test */
    menusCoarseOnly: matchMedia('(pointer: coarse)').matches && ((navigator.maxTouchPoints | 0) > 0 || 'ontouchstart' in window),
  };
});
console.log('  ', JSON.stringify(hyb));
R.ok(hyb.touchUI === false && hyb.interact === 'E', '9b. hybrid with a fine pointer keeps keyboard words', JSON.stringify([hyb.touchUI, hyb.interact]));
/* now a real finger lands on it: touch.js arms a one-shot touchstart */
const hcdp = await ctxH.newCDPSession(hp);
await hcdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 400, id: 1, radiusX: 12, radiusY: 12, force: 1 }] });
await hcdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await hp.waitForTimeout(900);
const hyb2 = await hp.evaluate(async () => { const m = await import('/src/ui/touch.js'); return { padOn: WALLY.ctx.ui.touch.enabled, touchUI: m.touchUI(), interact: m.actionLabel('interact'), prompt: (document.querySelector('.w-prompt .key') || {}).textContent, hints: [...document.querySelectorAll('.w-hint .kb')].map((e) => e.textContent) }; });
console.log('   after a real finger:', JSON.stringify(hyb2));
R.ok(hyb2.padOn ? hyb2.interact === 'Enter' : hyb2.interact === 'E',
  '9b. after a genuine touchstart the labels follow the pad, not the boot state', JSON.stringify(hyb2));
await ctxH.close();

/* ================================================================
   8b. DESKTOP CONTROL — the key names MUST be there
   ================================================================ */
console.log('\n===== 8b. DESKTOP CONTROL =====');
const ctxD = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const dp = await ctxD.newPage();
dp.on('pageerror', (e) => errs.push('desktop: ' + e.message.split('\n')[0]));
await dp.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
await dp.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
await dp.waitForTimeout(3000);
const desk = await dp.evaluate(async () => {
  const m = await import('/src/ui/touch.js');
  const w = WALLY.ctx;
  const d = w.city.doorPosition('apartment'); w.wally.warpTo(d.x, d.y + 0.3, d.z, {});
  await new Promise((r) => setTimeout(r, 900));
  w.ui.dialogue({ speaker: 'Otto', text: ['A desktop line for the continue chip.', 'Second page.'] });
  await new Promise((r) => setTimeout(r, 1500));
  return {
    touchUI: m.touchUI(), interact: m.actionLabel('interact'), phrase: m.actionPhrase('interact'),
    prompt: (document.querySelector('.w-prompt .key') || {}).textContent,
    hints: [...document.querySelectorAll('.w-hint .kb')].map((e) => e.textContent),
    hintAria: [...document.querySelectorAll('.w-hint')].map((e) => e.getAttribute('aria-label')),
    ticker: (document.querySelector('.w-pill.tap .kb') || {}).textContent,
    tickerTitle: (document.querySelector('.w-pill.tap') || {}).title,
    more: (document.querySelector('.w-dlg-more') || {}).textContent,
    moreChip: (document.querySelector('.w-dlg-more .key') || {}).textContent,
    obj: (document.querySelector('.w-obj .d') || {}).textContent,
    padOn: w.ui.touch.enabled, stick: !!document.querySelector('.w-stick'),
  };
});
console.log('  ', JSON.stringify(desk));
R.ok(desk.interact === 'E' && desk.prompt === 'E', '8b. desktop door prompt still shows E');
R.ok(JSON.stringify(desk.hints) === JSON.stringify(['P', 'M', 'O', 'Esc']), '8b. desktop hint row still P/M/O/Esc', JSON.stringify(desk.hints));
R.ok(desk.ticker === 'B', '8b. desktop ticker pill still carries B', String(desk.ticker));
R.ok(desk.moreChip === 'E', '8b. desktop dialogue continue chip still E', String(desk.moreChip));
R.ok(/press E/.test(desk.obj || '') || desk.obj === '' || !/tap/.test(desk.obj || ''), '8b. desktop objective says "press E" not "tap Enter"', String(desk.obj));
R.ok(!desk.padOn && !desk.stick, '8b. desktop has no pad');
await ctxD.close();

await browser.close(); server.close();
console.log(`\n${R.fails} failure(s). page errors: ${errs.length} ${errs.join(' | ')}`);
