/* VJ 4 follow-up: what the Hide-UI refusal does on a HYBRID, and
   whether "Touch controls off" survives a reload on a phone. */
import { chromium } from 'playwright-core';
import { serve, reporter } from './lib.mjs';

const { server, port } = await serve();
const R = reporter();
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });

async function boot(features, vp, hasTouch, mobile) {
  const ctx = await browser.newContext({ viewport: vp, hasTouch, isMobile: mobile, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  if (features) {
    await page.addInitScript((f) => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => {
        for (const [k, v] of Object.entries(f)) {
          if (q.replace(/\s+/g, '') === k.replace(/\s+/g, '')) {
            const l = real(q);
            return { media: q, matches: v, addEventListener: l.addEventListener.bind(l), removeEventListener: l.removeEventListener.bind(l), addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false };
          }
        }
        return real(q);
      };
    }, features);
  }
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
  await page.waitForTimeout(3000);
  return { ctx, page };
}

const flipHideUI = async (page) => page.evaluate(async () => {
  const u = WALLY.ctx.ui;
  u.closeAll(); u.show('settings');
  await new Promise((r) => setTimeout(r, 600));
  const row = [...document.querySelectorAll('.w-kv')].find((e) => (e.querySelector('span') || {}).textContent === 'Hide UI');
  const sw = row.querySelector('.w-switch');
  sw.click();
  await new Promise((r) => setTimeout(r, 400));
  return { switchOn: sw.classList.contains('on'), hideUI: u.hideUI, pad: u.touch.enabled };
});

/* --- HYBRID: tablet + keyboard. Pad is OFF by default here. --- */
console.log('\n===== HYBRID (pointer:coarse + any-pointer:fine): can he use Hide UI? =====');
{
  const { ctx, page } = await boot({ '(pointer: coarse)': true, '(pointer: fine)': false, '(any-pointer: fine)': true, '(any-pointer: coarse)': true },
    { width: 1024, height: 768 }, true, false);
  const pre = await page.evaluate(() => ({ pad: WALLY.ctx.ui.touch.enabled, hide: WALLY.ctx.ui.hideUI }));
  console.log('  boot:', JSON.stringify(pre));
  const r = await flipHideUI(page);
  console.log('  after flipping Hide UI:', JSON.stringify(r));
  R.ok(r.hideUI === true, 'HYBRID: Hide UI works for a tablet-with-keyboard player (pad off, keyboard present)',
    r.hideUI ? '' : 'REFUSED — menus.js coarseOnly() disagrees with touch.js coarsePointer()');
  await ctx.close();
}

/* --- PHONE control: the refusal must still fire --- */
console.log('\n===== PHONE control: the refusal must fire =====');
{
  const { ctx, page } = await boot(null, { width: 390, height: 844 }, true, true);
  await page.evaluate(() => WALLY.ctx.ui.setTouch(false));
  await page.waitForTimeout(500);
  const r = await flipHideUI(page);
  console.log('  pad off, then Hide UI:', JSON.stringify(r));
  R.ok(r.hideUI === false && r.switchOn === false, 'PHONE: pad off + Hide UI on is refused and the switch snaps back', JSON.stringify(r));
  await ctx.close();
}

/* --- does "Touch controls off" survive a reload on a phone? --- */
console.log('\n===== does the pad stay off across a reload on a phone? =====');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?skipIntro`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { WALLY.ctx.ui.setTouch(false); WALLY.ctx.game.save(); });
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => ({ pad: WALLY.ctx.ui.touch.enabled, set: WALLY.ctx.game.state.settings.touch }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.__WALLY_READY__===true', { timeout: 120000 });
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => ({ pad: WALLY.ctx.ui.touch.enabled, set: WALLY.ctx.game.state.settings.touch }));
  console.log('  before reload:', JSON.stringify(before), ' after:', JSON.stringify(after));
  R.ok(after.pad === false, 'PHONE: "Touch controls off" survives a reload',
    after.pad ? 'the pad came back on — shouldEnable() ignores settings.touch === false' : '');
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n${R.fails} failure(s).`);
