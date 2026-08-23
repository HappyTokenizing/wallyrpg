/* VJ 5 — the phone messages, at 390x844 and on the desktop, with a
   Wally message and a WallyNet post from Wally seeded so his avatar
   sits beside real NPC portraits at 30 px and at 26 px. */
import { chromium } from 'playwright-core';
import { serve } from './lib.mjs';
import { mkdir } from 'node:fs/promises';
const OUT = '/Users/herwig/Documents/GitHub/wallyrpg/shots/vj';
await mkdir(OUT, { recursive: true });
const { server, port } = await serve();
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });

const SEED = () => {
  const st = WALLY.ctx.game.state;
  st.msgs = [
    { from: 'Otto', text: 'Bring the sunglasses. The coffee is bad in a way I have grown to respect.', day: 1, time: 420, read: true },
    { from: 'Wally', text: 'On my way. Give me twenty minutes and a bicycle.', day: 1, time: 431, read: true },
    { from: 'Mabel', text: 'A one-year community bond, please. Nothing clever.', day: 1, time: 610, read: false },
    { from: 'Rico', text: 'Heard you were back. Do not buy anything from Vic.', day: 1, time: 640, read: false },
  ];
  st.wallynet = [
    { who: 'Mabel', text: 'He actually explained the spread. Twice.', good: true },
    { who: 'Wally', text: 'Open for business. Ask me about tokenising anything on this island.', good: true },
    { who: 'Otto', text: 'The boy has a desk now.', good: true },
  ];
};

for (const [tag, vp] of [['390', { width: 390, height: 844 }], ['desk', { width: 1440, height: 900 }]]) {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: tag === '390', isMobile: tag === '390', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message.split('\n')[0]));
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.evaluate(SEED);
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.openPhone('messages'); });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/msgs-${tag}.png` });
  const shot = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.w-msg .hd')];
    const out = [];
    for (const r of rows) {
      const svg = r.querySelector('svg');
      const b = svg ? svg.getBoundingClientRect() : null;
      out.push({ who: (r.childNodes[1] || {}).nodeValue || r.textContent.trim().slice(0, 12),
        cls: svg ? svg.getAttribute('class') : null, size: b ? [Math.round(b.width), Math.round(b.height)] : null,
        hasText: svg ? !!svg.querySelector('text') : null,
        box: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null });
    }
    return out;
  });
  console.log(`\n=== ${tag} MESSAGES ===`);
  for (const s of shot) console.log(`   ${JSON.stringify(s.who).padEnd(12)} svg.class=${s.cls}  ${JSON.stringify(s.size)}  <text>=${s.hasText}`);
  /* crop the avatar strip */
  const first = shot.find((s) => s.box);
  const last = shot[shot.length - 1];
  if (first && last && last.box) {
    await page.screenshot({ path: `${OUT}/msgs-${tag}-crop.png`,
      clip: { x: Math.max(0, first.box.x - 6), y: Math.max(0, first.box.y - 8), width: 260, height: Math.min(vp.height - first.box.y, last.box.y - first.box.y + last.box.h + 16) } });
  }
  /* WallyNet — the 26 px row */
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.openPhone('wallynet'); });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/net-${tag}.png` });
  const net = await page.evaluate(() => [...document.querySelectorAll('.w-msg .hd')].map((r) => {
    const svg = r.querySelector('svg'); const b = svg ? svg.getBoundingClientRect() : null;
    return { who: r.textContent.trim().slice(0, 14), cls: svg ? svg.getAttribute('class') : null,
      size: b ? [Math.round(b.width), Math.round(b.height)] : null, hasText: svg ? !!svg.querySelector('text') : null,
      box: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null };
  }));
  console.log(`=== ${tag} WALLYNET (26 px) ===`);
  for (const s of net) console.log(`   ${JSON.stringify(s.who).padEnd(16)} svg.class=${s.cls}  ${JSON.stringify(s.size)}  <text>=${s.hasText}`);
  const f2 = net.find((s) => s.box), l2 = net[net.length - 1];
  if (f2 && l2.box) {
    await page.screenshot({ path: `${OUT}/net-${tag}-crop.png`,
      clip: { x: Math.max(0, f2.box.x - 6), y: Math.max(0, f2.box.y - 8), width: 260, height: l2.box.y - f2.box.y + l2.box.h + 16 } });
  }
  await ctx.close();
}

/* --- a size ladder: the mark in the disc at every size the phone uses,
       beside a real NPC portrait and beside the OLD lettered circle --- */
{
  const ctx = await browser.newContext({ viewport: { width: 900, height: 340 }, deviceScaleFactor: 4 });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    const s = await import('/src/ui/style.js');
    const P = await import('/src/core/palette.js');
    const g = WALLY.ctx.game;
    const host = document.createElement('div');
    host.id = 'ladder';
    host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#F4EFE6;padding:18px;font:12px system-ui;color:#222';
    const clients = Object.values(g.data.clientById);
    for (const size of [22, 26, 30, 34, 38, 56]) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px';
      const lab = document.createElement('span'); lab.textContent = size + ' px'; lab.style.width = '44px';
      row.append(lab);
      row.append(s.wallyAvatar(size));
      row.append(s.glyphAvatar('W', P.BRAND.token, size));
      for (const c of clients.slice(0, 5)) row.append(s.portrait(c, size));
      host.append(row);
    }
    document.body.append(host);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/ladder.png`, clip: { x: 0, y: 0, width: 560, height: 300 } });
  await ctx.close();
}
await browser.close(); server.close();
console.log('\nshots in ' + OUT);
