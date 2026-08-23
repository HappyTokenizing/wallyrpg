/* _map-overlap.mjs — MAP AGENT measuring rig.
   Boots the game, opens the Places app and the full-map sheet at three
   viewport sizes, and measures overlapping <text> bounding boxes inside
   each chart in SCREEN PIXELS. Prints pairs / px2 / damaged-label count
   and writes a PNG per case so the numbers can be looked at.

   node tools/_map-overlap.mjs [--shots]
*/
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const srv = createServer(async (rq, rs) => {
  try {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream', 'cache-control': 'no-store' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

const SHOTS = process.argv.includes('--shots');
const TAG = (process.argv.find(a => a.startsWith('--tag=')) || '--tag=m3').slice(6);

const MEASURE = () => {
  const out = [];
  for (const svg of document.querySelectorAll('.w-map svg')) {
    const host = svg.closest('.w-map');
    const compact = host.classList.contains('compact');
    /* is it actually on screen? */
    const hr = host.getBoundingClientRect();
    if (hr.width < 5 || hr.height < 5) continue;
    const style = getComputedStyle(host);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const labels = [];
    for (const t of svg.querySelectorAll('text')) {
      const txt = (t.textContent || '').trim();
      if (!txt) continue;
      /* the plaque's title is ONE label set on two lines when it is
         stacked — its own line boxes abut and that is not a collision */
      const cart = !!t.closest('.wm-cart') && /^(BULL BEAR|CITY|BULL BEAR CITY)$/.test(txt);
      /* the compass letter and the emoji pins are furniture, not names,
         but count everything a reader sees as type except the icon glyphs */
      if (t.classList.contains('wm-ico')) continue;
      const r = t.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      labels.push({ t: txt, cart, x1: r.left, y1: r.top, x2: r.right, y2: r.bottom, w: r.width, h: r.height });
    }
    /* the pins, so "a name whose box overlaps another name OR A PIN"
       can be counted as well. The tap target is a transparent circle
       46+ units wide — the INK is the outer stroked disc. */
    const pins = [];
    for (const g of svg.querySelectorAll('g[data-loc]')) {
      const c = g.querySelector('circle[fill]:not([fill="transparent"])');
      if (!c) continue;
      const r = c.getBoundingClientRect();
      if (r.width > 1) pins.push({ x1: r.left, y1: r.top, x2: r.right, y2: r.bottom });
    }
    let pinPairs = 0, pinArea = 0;
    for (const l of labels) {
      for (const p of pins) {
        const ow = Math.min(l.x2, p.x2) - Math.max(l.x1, p.x1);
        const oh = Math.min(l.y2, p.y2) - Math.max(l.y1, p.y1);
        if (ow > 0 && oh > 0) { pinPairs++; pinArea += ow * oh; }
      }
    }

    let pairs = 0, area = 0;
    const dmg = new Set();
    const list = [];
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        if (a.cart && b.cart) continue;
        const ow = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const oh = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        if (ow > 0 && oh > 0) {
          pairs++; area += ow * oh;
          dmg.add(a.t); dmg.add(b.t);
          list.push([a.t, b.t, Math.round(ow * oh)]);
        }
      }
    }
    list.sort((p, q) => q[2] - p[2]);
    out.push({
      compact, n: labels.length, pairs, area: Math.round(area), dmg: dmg.size,
      pinPairs, pinArea: Math.round(pinArea), pins: pins.length,
      leaderSegs: [...svg.querySelectorAll('path')].reduce((n, p) => {
        const d = p.getAttribute('d') || '';
        return /^M[-\d.]+ [-\d.]+L[-\d.]+ [-\d.]+(M|$)/.test(d) ? n + (d.match(/L/g) || []).length : n;
      }, 0),
      meanH: +(labels.reduce((s, l) => s + l.h, 0) / (labels.length || 1)).toFixed(2),
      box: [Math.round(hr.width), Math.round(hr.height)],
      worst: list.slice(0, 6),
      texts: labels.map(l => l.t),
    });
  }
  return out;
};

/* also: does anything in the phone's scroller sit below the fold? */
const FOLD = () => {
  const sc = document.querySelector('.w-appbody') || document.querySelector('.w-sheet-body');
  if (!sc) return null;
  const sr = sc.getBoundingClientRect();
  const rows = [];
  for (const n of sc.children) {
    const r = n.getBoundingClientRect();
    rows.push({
      t: (n.innerText || '').replace(/\s+/g, ' ').slice(0, 34),
      top: +r.top.toFixed(1), bot: +r.bottom.toFixed(1),
    });
  }
  return {
    scroller: [+sr.top.toFixed(1), +sr.bottom.toFixed(1)],
    overflow: Math.round(sc.scrollHeight - sc.clientHeight),
    vh: window.innerHeight, rows,
  };
};

const ALL = {
  phone: { name: 'phone', w: 390, h: 844 },
  land: { name: 'land', w: 844, h: 390 },
  desk: { name: 'desk', w: 1400, h: 900 },
  land2: { name: 'land2', w: 926, h: 428 },
  land3: { name: 'land3', w: 844, h: 600 },
  small: { name: 'small', w: 360, h: 640 },
};
const pick = (process.argv.find(a => a.startsWith('--cases=')) || '').slice(8);
const CASES = pick ? pick.split(',').map(k => ALL[k]).filter(Boolean)
  : [ALL.phone, ALL.land, ALL.desk];

const br = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});

for (const c of CASES) {
  const pg = await br.newPage({ viewport: { width: c.w, height: c.h } });
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(`http://127.0.0.1:${PORT}/index.html?shot=1`, { waitUntil: 'load', timeout: 120000 });
  await pg.waitForFunction('window.__WALLY_READY__===true', { timeout: 180000 });
  await pg.waitForTimeout(6000);

  /* FULL DISCOVERY — the worst case, and the one the brief measured:
     every district surveyed, every place inked in. */
  const nloc = await pg.evaluate(() => {
    const g = window.WALLY.ctx.game;
    for (const l of g.data.locations) { g.state.known[l.id] = true; g.state.access[l.id] = true; }
    return g.data.locations.length;
  });
  if (c === CASES[0]) console.log('locations:', nloc);

  /* ---- places app ---- */
  await pg.evaluate(() => window.WALLY.debug.ui('places'));
  await pg.waitForTimeout(1600);
  const mp = await pg.evaluate(MEASURE);
  const fold = await pg.evaluate(FOLD);
  if (SHOTS) await pg.screenshot({ path: join(ROOT, 'shots', `${TAG}-${c.name}.png`) });

  console.log(`\n=== ${c.name} ${c.w}x${c.h} — PLACES APP ===`);
  for (const m of mp) {
    console.log(`  chart ${m.compact ? 'compact' : 'FULL'} box=${m.box.join('x')} labels=${m.n} meanH=${m.meanH}px  pairs=${m.pairs} area=${m.area}px2 damaged=${m.dmg}  vsPins=${m.pinPairs}/${m.pinArea}px2 leaders=${m.leaderSegs}`);
    for (const w of m.worst) console.log(`      "${w[0]}" x "${w[1]}"  ${w[2]}px2`);
  }
  if (fold) {
    console.log(`  scroller ${fold.scroller.join('-')} vh=${fold.vh} overflow=${fold.overflow}`);
    for (const r of fold.rows) console.log(`      ${r.top}-${r.bot} ${r.bot > fold.vh ? 'BELOW ' : '      '}${r.t}`);
  }

  /* ---- full map sheet ---- */
  await pg.evaluate(() => window.WALLY.debug.ui('map'));
  await pg.waitForTimeout(1600);
  const bm = await pg.evaluate(MEASURE);
  const bfold = await pg.evaluate(FOLD);
  if (SHOTS) await pg.screenshot({ path: join(ROOT, 'shots', `${TAG}-${c.name}-big.png`) });
  console.log(`--- ${c.name} — FULL MAP SHEET ---`);
  for (const m of bm) {
    console.log(`  chart ${m.compact ? 'compact' : 'FULL'} box=${m.box.join('x')} labels=${m.n} meanH=${m.meanH}px  pairs=${m.pairs} area=${m.area}px2 damaged=${m.dmg}  vsPins=${m.pinPairs}/${m.pinArea}px2 leaders=${m.leaderSegs}`);
    for (const w of m.worst) console.log(`      "${w[0]}" x "${w[1]}"  ${w[2]}px2`);
    console.log('      names: ' + m.texts.filter(t=>t!==t.toUpperCase()).join(' | '));
  }
  if (bfold) console.log(`  sheet scroller ${bfold.scroller.join('-')} vh=${bfold.vh} overflow=${bfold.overflow}`);
  if (errs.length) console.log('  PAGEERRORS:', errs.slice(0, 4));
  await pg.close();
}
await br.close(); srv.close();
