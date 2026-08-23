/* _wa-probe.mjs — boot the game headless and run an evaluate() body from a file.
   node tools/_wa-probe.mjs <script.js> [--url "index.html?skipIntro"] [--wait 3500]
   The script file is evaluated in the page as the body of an async function and
   its return value is printed as JSON. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json',
};
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const body = await readFile(resolve(process.argv[2]), 'utf8');
const url = arg('url', 'index.html?skipIntro');
const wait = +arg('wait', 3500);

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
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${port}/${url}`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(wait);

let out;
try {
  out = await page.evaluate(new Function(`return (async () => { ${body} })()`));
} catch (e) {
  out = { ERROR: String(e).split('\n').slice(0, 6).join(' | ') };
}
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('PAGE ERRORS:', JSON.stringify(errs.slice(0, 8), null, 1));
await browser.close();
server.close();
process.exit(errs.length ? 1 : 0);
