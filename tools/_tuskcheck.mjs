/* _tuskcheck.mjs — does wallyKeyline() cover the whole mark?
   Rasterises the mark and the keyline at 1600 px in the same 0 0 64 64
   box, with the exact stroke map.js's pawn uses, and reports every mark
   pixel the keyline does not stand behind: count, share, bounding box
   in 64-units, and the modal colour of the uncovered ink. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const ROOT = '/Users/herwig/Documents/GitHub/wallyrpg';
const M = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const srv = createServer(async (rq, rs) => {
  try {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    if (c === '/probe.html') {
      rs.writeHead(200, { 'content-type': M['.html'] });
      rs.end('<!doctype html><meta charset=utf-8><body style="margin:0;background:#fff">'
        + '<script type="module">import {wallyKeyline, wallyMarkup} from "/src/ui/style.js";'
        + 'window.KL = wallyKeyline; window.MK = wallyMarkup; window.READY = 1;</script>');
      return;
    }
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': M[extname(c)] || 'application/octet-stream' });
    rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const P = srv.address().port;
const br = await chromium.launch({ channel: 'chrome', args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const pg = await br.newPage({ viewport: { width: 1600, height: 1600 } });
const errs = []; pg.on('pageerror', e => errs.push(e.message));
await pg.goto(`http://127.0.0.1:${P}/probe.html`, { waitUntil: 'load' });
await pg.waitForFunction('window.READY === 1', { timeout: 30000 });

const out = await pg.evaluate(async () => {
  const S = 1600;
  const draw = (inner) => new Promise((res) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 64 64">`
      + `<rect width="64" height="64" fill="#ffffff"/>${inner}</svg>`;
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      res(cx.getImageData(0, 0, S, S).data);
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  /* the pawn's keyline, exactly as ui/map.js sets it */
  const key = await draw(window.KL('fill="#000000" stroke="#000000" stroke-width="3.4" stroke-linejoin="round"'));
  const mark = await draw(window.MK('probe'));

  let markPx = 0, bare = 0;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  const hist = new Map();
  for (let i = 0, p = 0; i < mark.length; i += 4, p++) {
    const r = mark[i], g = mark[i + 1], b = mark[i + 2];
    if (r > 250 && g > 250 && b > 250) continue;      /* stock */
    markPx++;
    const kr = key[i];
    if (kr < 128) continue;                            /* the keyline is behind it */
    bare++;
    const x = p % S, y = (p / S) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    const k = r + ',' + g + ',' + b;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  /* symmetry: how many bare pixels have a bare mirror about x = 32 */
  let sym = 0;
  for (let i = 0, p = 0; i < mark.length; i += 4, p++) {
    const r = mark[i];
    if (r > 250 && mark[i + 1] > 250 && mark[i + 2] > 250) continue;
    if (key[i] < 128) continue;
    const x = p % S, y = (p / S) | 0;
    const mx = S - 1 - x, j = (y * S + mx) * 4;
    const mr = mark[j], mg = mark[j + 1], mb = mark[j + 2];
    if (!(mr > 250 && mg > 250 && mb > 250) && key[j] >= 128) sym++;
  }
  const u = (v) => +(v / S * 64).toFixed(1);
  return {
    markPx, bare, pct: +(bare / markPx * 100).toFixed(2),
    box64: [u(x0), u(x1), u(y0), u(y1)],
    symPct: +(sym / (bare || 1) * 100).toFixed(1),
    top,
  };
});
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('ERRORS', errs);
await br.close(); srv.close();
