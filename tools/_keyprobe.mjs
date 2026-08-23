import { chromium } from 'playwright-core';
async function trial(label, fn) {
  const b = await chromium.launch({ channel: 'chrome' });
  try {
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    await p.goto('about:blank');
    await p.evaluate(() => { window.__K=[]; addEventListener('keydown', e=>window.__K.push(e.code), true); });
    const cdp = await ctx.newCDPSession(p);
    await fn(cdp, p);
    await p.waitForTimeout(1500);
    const k = await p.evaluate(()=>window.__K);
    const storm = k.filter(c=>c==='Numpad5').length;
    const real = k.filter(c=>c!=='Numpad5');
    console.log(`${label.padEnd(52)} storm=${String(storm).padStart(6)}  delivered=${JSON.stringify(real)}`);
  } catch (e) { console.log(`${label.padEnd(52)} CRASHED ${String(e).split('\n')[0].slice(0,60)}`); }
  await b.close().catch(()=>{});
}
await trial('0) nothing dispatched', async () => {});
await trial('a) rawKeyDown KeyW (no keyUp)', async (c) =>
  c.send('Input.dispatchKeyEvent', { type:'rawKeyDown', code:'KeyW', key:'w', windowsVirtualKeyCode:87, nativeVirtualKeyCode:87 }));
await trial('b) keyUp KeyW ALONE (what flushKeys does)', async (c) =>
  c.send('Input.dispatchKeyEvent', { type:'keyUp', code:'KeyW', key:'w', windowsVirtualKeyCode:87, nativeVirtualKeyCode:87 }));
await trial('c) keyDown+text KeyW, then keyUp', async (c) => {
  await c.send('Input.dispatchKeyEvent', { type:'keyDown', code:'KeyW', key:'w', text:'w', unmodifiedText:'w', windowsVirtualKeyCode:87, nativeVirtualKeyCode:87 });
  await c.send('Input.dispatchKeyEvent', { type:'keyUp', code:'KeyW', key:'w', windowsVirtualKeyCode:87, nativeVirtualKeyCode:87 });
});
await trial('d) playwright page.keyboard.down/up("w")', async (c, p) => {
  await p.keyboard.down('w'); await p.keyboard.up('w');
});
await trial('e) playwright keyboard.down/up("Space")', async (c, p) => {
  await p.keyboard.down(' '); await p.keyboard.up(' ');
});
await trial('f) playwright keyboard.press("Tab")', async (c, p) => { await p.keyboard.press('Tab'); });
await trial('g) rawKeyDown Space', async (c) =>
  c.send('Input.dispatchKeyEvent', { type:'rawKeyDown', code:'Space', key:' ', windowsVirtualKeyCode:32, nativeVirtualKeyCode:32 }));
