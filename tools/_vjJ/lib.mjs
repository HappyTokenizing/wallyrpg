/* _vjJ/lib.mjs — verify judge round 9: shared harness. Static server +
   chrome, nothing else. Every probe does its own maths. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export async function boot({ w = 1000, h = 620, query = '?skipIntro' } = {}) {
  const server = createServer(async (rq, rs) => {
    const c = decodeURIComponent(rq.url.split('?')[0]);
    try {
      const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
      rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' });
      rs.end(b);
    } catch { rs.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${port}/index.html${query}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
  await page.waitForTimeout(3500);
  return { page, browser, server, errs, port };
}

/* unwrap a series of wrapped angles into a monotone-safe total */
export function unwrapSum(series) {
  const TAU = Math.PI * 2;
  let tot = 0;
  for (let i = 1; i < series.length; i++) {
    let d = series[i] - series[i - 1];
    d -= Math.round(d / TAU) * TAU;
    tot += d;
  }
  return tot;
}

/* dominant period of a roughly-sinusoidal series, in samples, by
   quadratic-interpolated peak of the autocorrelation. Independent of
   any phase the engine publishes. */
export function periodSamples(y, minLag = 4) {
  const n = y.length;
  const mean = y.reduce((a, b) => a + b, 0) / n;
  const x = y.map((v) => v - mean);
  const ac = [];
  for (let lag = 0; lag < Math.floor(n / 2); lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    ac.push(s / (n - lag));
  }
  let best = -1, bi = -1;
  for (let lag = minLag; lag < ac.length - 1; lag++) {
    if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1] && ac[lag] > best) { best = ac[lag]; bi = lag; }
  }
  if (bi < 0) return null;
  const a = ac[bi - 1], b = ac[bi], c = ac[bi + 1];
  const d = a - 2 * b + c;
  const off = Math.abs(d) > 1e-12 ? 0.5 * (a - c) / d : 0;
  return bi + off;
}
