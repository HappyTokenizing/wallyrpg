#!/usr/bin/env node
/* Does the rAF TIMESTAMP delta (what main.js's census rings) agree with
   a performance.now() delta over the same interval? Run with and
   without the frame-rate limiter. */
import { boot, INJECT, stats } from './_sm-lib.mjs';
import { execSync } from 'node:child_process';
const load = () => execSync('uptime').toString().split('load averages:')[1].trim();

for (const limiter of [true, false]) {
  const logs = [];
  const { page, close } = await boot({ logs, limiter });
  await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
  await page.waitForTimeout(6000);
  await page.evaluate(INJECT);
  await page.evaluate(() => window.__SMP__.start('ts'));
  await page.waitForTimeout(6000);
  await page.evaluate(() => window.__SMP__.stop());
  const d = await page.evaluate(() => window.__SMP__.read());
  const rec = d.rec.slice(1);
  const raw = stats(rec.map(r => r.raw)), wall = stats(rec.map(r => r.wall));
  const diff = rec.map(r => +(r.wall - r.raw).toFixed(2));
  console.log(`limiter ${limiter ? 'ON ' : 'OFF'}  load ${load()}`);
  console.log('   raw (rAF ts delta) ', JSON.stringify(raw));
  console.log('   wall (perf.now)    ', JSON.stringify(wall));
  console.log('   wall-raw           ', JSON.stringify(stats(diff)));
  console.log('   raw frames < 2 ms  ', rec.filter(r => r.raw < 2).length, ' wall frames < 2 ms ', rec.filter(r => r.wall < 2).length);
  console.log('   cpu                ', JSON.stringify(stats(rec.map(r => r.cpu))));
  console.log('   gpu                ', JSON.stringify(stats(rec.filter(r => r.gpu != null).map(r => r.gpu))));
  await close();
}
