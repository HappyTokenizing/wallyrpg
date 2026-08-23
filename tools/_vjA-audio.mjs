#!/usr/bin/env node
/* VERIFY JUDGE — measure the transient ladder at n=3 and n=8 myself. */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.env.WROOT || '/Users/herwig/Documents/GitHub/wallyrpg';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
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
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 140)); });
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 120000 });
await page.waitForTimeout(3000);

async function run(n) {
  await page.evaluate(() => WALLY.debug.audioClearFault());
  await page.waitForTimeout(3000);
  return page.evaluate(async (bars) => {
    const a = WALLY.ctx.audio;
    const t0 = performance.now();
    const before = { notes: a.notes.length, rec: a.transport.recoveries, hard: a.transport.hardRecoveries, alarms: a.transport.barAlarms };
    const inj = WALLY.debug.audioBreakTick(bars);
    const marks = [];
    let peakFails = 0, peakAlarms = 0, healedAt = -1;
    while (performance.now() - t0 < 34000) {
      await new Promise((r) => setTimeout(r, 500));
      const t = a.transport;
      const s = +((performance.now() - t0) / 1000).toFixed(1);
      if (t.barFails > peakFails || t.barAlarms > peakAlarms || t.recoveries > before.rec + (marks.at(-1)?.dr || 0)) {
        marks.push({ s, fails: t.barFails, alarms: t.barAlarms, dr: t.recoveries - before.rec, hard: t.hardRecoveries, silentFor: +t.silentFor.toFixed(2) });
      }
      peakFails = Math.max(peakFails, t.barFails);
      peakAlarms = Math.max(peakAlarms, t.barAlarms);
      if (healedAt < 0 && peakFails >= bars && t.barFails === 0) healedAt = s;
      if (healedAt > 0 && performance.now() - t0 > healedAt * 1000 + 4000) break;
    }
    const t = a.transport;
    return { inj, before, peakFails, peakAlarms, healedAt, marks,
      after: { notes: a.notes.length, rec: t.recoveries, hard: t.hardRecoveries, alarms: t.barAlarms, barFails: t.barFails } };
  }, n);
}

for (const n of [3, 8]) {
  const r = await run(n);
  console.log(`\n=== audioBreakTick(${n})  injected ${JSON.stringify(r.inj)}`);
  console.log(`   peak barFails ${r.peakFails}   peak alarms ${r.peakAlarms}   healed at ${r.healedAt}s`);
  console.log(`   transport resets (recoveries delta) ${r.after.rec - r.before.rec}   hardRecoveries ${r.before.hard} -> ${r.after.hard}`);
  console.log(`   notes ${r.before.notes} -> ${r.after.notes}   barFails after ${r.after.barFails}`);
  console.log('   ladder marks:', JSON.stringify(r.marks));
}
console.log('\npage/console errors:', errs.length, errs.slice(0, 6));
await browser.close(); server.close();
