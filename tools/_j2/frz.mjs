import { boot } from './lib.mjs';
const { page, close } = await boot({ query:'skipIntro&shot=1', viewport:{width:800,height:450}, settle:5000 });
await page.evaluate(() => {
  const raf = window.requestAnimationFrame.bind(window);
  window.__FROZEN = null;
  window.requestAnimationFrame = (cb) => raf((t) => cb(window.__FROZEN !== null ? window.__FROZEN : t));
  window.__FREEZE = (on) => { window.__FROZEN = on ? performance.now() : null; return window.__FROZEN; };
  WALLY.debug.balloon({ alt: 200 }); WALLY.debug.balloonStick(0,0);
});
await page.waitForTimeout(3000);
await page.evaluate(() => window.__FREEZE(true));
const t = await page.evaluate(() => new Promise(r => {
  const rows = []; let i = 0;
  const tick = () => { const c = WALLY.ctx.camera, w = WALLY.ctx.wally;
    rows.push({ dt: +WALLY.ctx.dt.toFixed(5), el: +WALLY.ctx.elapsed.toFixed(3),
      cam: [+c.position.x.toFixed(3), +c.position.y.toFixed(3), +c.position.z.toFixed(3)],
      wy: +w.position.y.toFixed(3), mode: WALLY.ctx.cam?.mode });
    if (++i < 30) requestAnimationFrame(tick); else r(rows); };
  requestAnimationFrame(tick);
}));
console.log(JSON.stringify(t.filter((_,i)=>i%6===0), null, 0));
await close();
