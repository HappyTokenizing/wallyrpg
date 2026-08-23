import { boot } from './lib.mjs';
const { page, close } = await boot();
const o = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  return { ctxKeys: Object.keys(c).sort(),
    gameActions: c.game && c.game.actions ? Object.keys(c.game.actions).sort() : null,
    ctrl: c.player ? Object.keys(c.player) : null,
    debugTp: Object.keys(W.debug).filter(k=>/tele|warp|tp|move|place|goto/i.test(k)),
    wallyApi: Object.keys(c.wally).sort().slice(0,60) };
});
console.log(JSON.stringify(o, null, 1));
await close();
