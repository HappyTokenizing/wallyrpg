#!/usr/bin/env node
/* Drives the original 2D "Wally: City of Assets" past its arcade boot and
   into actual gameplay, capturing the scene art the critic agents compare
   against. Writes shots/ref-original-*.png. */

import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(`http://127.0.0.1:${PORT}/ref/original-wally.html`, { waitUntil: 'load' });

const shot = async (name, ms = 900) => {
  await page.waitForTimeout(ms);
  await page.screenshot({ path: join(ROOT, 'shots', `ref-original-${name}.png`), animations: 'allow', timeout: 20000 });
  console.log('  ->', name);
};

// Arcade boot: two taps to reach PRESS START, then start.
await page.waitForTimeout(2500);
await page.keyboard.press('Space'); await page.waitForTimeout(700);
await shot('title', 900);
await page.keyboard.press('Space'); await page.waitForTimeout(1400);

// Title menu -> New game
const newBtn = await page.$('#btnNew');
if (newBtn) { await newBtn.click(); await page.waitForTimeout(2200); }
await shot('intro', 1200);

// Dismiss any opening dialogue, then capture the location screen (hero art).
for (let i = 0; i < 8; i++) {
  const btn = await page.$('#dlg button.primary, #dlg .btn.primary, #dlg .btn');
  if (!btn) break;
  await btn.click().catch(() => {});
  await page.waitForTimeout(500);
}
await shot('place', 1000);

// The city map — the "clay diorama" the README is proudest of.
await page.click('#navMap').catch(() => {});
await shot('map', 1600);

// The office.
await page.click('#navOffice').catch(() => {});
await shot('office', 1200);

// The phone UI.
await page.click('#navPhone').catch(() => {});
await shot('phone', 1200);

await browser.close();
server.close();
console.log('done');
