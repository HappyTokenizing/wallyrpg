import { boot } from './lib.mjs';
const B = await boot(); const { page } = B;
const CANDS = [
  ['apt->nc',      -370.8, 203.4, -257.4, 226.8],
  ['nc->docks',    -257.4, 226.8,  -84.6, 221.4],
  ['pawn->depot',  -363.6, 127.8, -271.8, 145.8],
  ['lib->prop',    -273.6, -19.8, -225.0,  75.6],
  ['office->cafe', -163.8,  19.8,  -97.2,  75.6],
  ['bank->bazaar', -133.2, -30.6,  -84.6, -66.6],
  ['mkt->broker',   -39.6,  14.4,   10.8, -61.2],
  ['infra->stad',   185.4,  30.6,  196.2, 223.2],
  ['exch->treas',   234.0,-225.0,  316.8,-210.6],
];
for (const [n, ax, az, bx, bz] of CANDS) {
  const out = await page.evaluate(async ([ax,az,bx,bz]) => {
    const c = WALLY.ctx; const res = [];
    for (let pass = 0; pass < 2; pass++) {
      const [sx,sz,tx,tz] = pass === 0 ? [ax,az,bx,bz] : [bx,bz,ax,az];
      V.place(sx, sz); await new Promise(r=>setTimeout(r,900));
      const m0 = c.game.state.stats.metres; let stuckAt = null; let last = null; let same = 0;
      V.aim(tx, tz, { stop: 6, run: true });
      const t0 = performance.now();
      while (performance.now() - t0 < 45000) {
        await new Promise(r=>setTimeout(r,250));
        const p = c.wally.position;
        if (last && Math.hypot(p.x-last.x, p.z-last.z) < 0.4) same++; else same = 0;
        last = { x:p.x, z:p.z };
        if (same > 8) { stuckAt = [+p.x.toFixed(1), +p.z.toFixed(1)]; break; }
        if (Math.hypot(tx-p.x, tz-p.z) < 6) break;
      }
      V.halt();
      res.push({ covered: +(c.game.state.stats.metres - m0).toFixed(1), want: +Math.hypot(tx-sx,tz-sz).toFixed(1), stuckAt });
    }
    return res;
  }, [ax,az,bx,bz]);
  console.log(n.padEnd(14), JSON.stringify(out));
}
await B.close();
