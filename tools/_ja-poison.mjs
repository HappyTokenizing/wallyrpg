#!/usr/bin/env node
/* _ja-poison.mjs — JUDGE RIG. Does the price gate FAIL on a price
   claim it cannot parse, or does it SKIP it?

   THE GATE IS NOT RETYPED. It is sliced out of tools/voicetest.mjs as
   TEXT between two anchors and imported as a module, so what runs here
   is byte-identical to what runs in the suite. A gate retyped into a
   probe is a probe testing a quotation. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as D from '../src/game/data.js';
import * as B from '../src/character/bubbles.js';

const src = readFileSync(new URL('./voicetest.mjs', import.meta.url), 'utf8');
const a = src.indexOf('const ONES = [');
const b = src.indexOf('   THE REVERT CHECK');
if (a < 0 || b < 0) { console.error('anchors moved — refusing to guess'); process.exit(3); }
const slice = src.slice(a, src.lastIndexOf('/* ---', b));
console.log('gate sliced verbatim from voicetest.mjs: ' + slice.split('\n').length
  + ' lines, sha1 ' + createHash('sha1').update(slice).digest('hex').slice(0, 12));
const mod = await import('data:text/javascript;base64,'
  + Buffer.from(slice + '\nexport { priceGate, valueOf };').toString('base64'));

const run = (label, lines, show = true) => {
  const msgs = [];
  const res = mod.priceGate(lines, D.ASSETS, (c, m) => { if (!c) msgs.push(m); });
  console.log('\n' + label);
  console.log('  numbers classified ' + res.checked + ' · FAILS ' + msgs.length
    + ' · counts printed and tolerated ' + res.counts.length);
  if (show) { for (const m of msgs) console.log('    RED   ' + m); }
  return { fails: msgs.length, checked: res.checked, counts: res.counts.length };
};

/* 1. THE CONTROL — the shipping pool, so a red below means poison and
      not a gate that reddens at everything. */
run('1. CONTROL: the whole shipping pool (' + B.ALL_LINES.length + ' lines)', B.ALL_LINES, true);

/* 2. THE POISON. Six shapes, each one a price a player could go and
      check against the board and find wrong, written so the OLD gate's
      `^TICK (is|at) <two words>[.,]` pattern cannot match it. If any
      of these comes back green the gate is skipping, not failing. */
const POISON = [
  /* a: the price is in the SECOND sentence, no connective at all */
  'PWHSE is full of nothing. Two thousand.',
  /* b: four number-words deep */
  'PTWR is seven and a half thousand. One floor.',
  /* c: followed by "and", which the old gate treated as a noun */
  'PLUXE at five thousand and the lift is out again.',
  /* d: a digit price with a money noun bolted on */
  'GEMS goes for 420 dollars, which is madness.',
  /* e: a day move with no ticker in the sentence at all */
  'Honey up eleven per cent since Tuesday.',
  /* f: THE UNCLASSIFIABLE ONE. A number in a ticker line that is
        neither coupon, echo, money, count nor price-with-connective —
        the branch that exists purely so nothing is skipped. */
  'TRNK had a morning. Nine, still.',
];
const p = run('2. POISON: six typed price claims the old gate could not parse', POISON, true);

/* 3. AND THE PAIRED ASSERTION, so the check is not vacuous: the SAME
      claims written the way the mechanism wants them must go green. If
      both sets fail, the gate is not discriminating, it is just red. */
const CURED = [
  'PWHSE is full of nothing. {PWHSE}.',
  'PTWR is {PTWR}. One floor.',
  'PLUXE at {PLUXE} and the lift is out again.',
  'GEMS goes for {GEMS}, which is madness.',
  'Honey is having a week.',
  'TRNK had a morning. It usually does.',
];
const c = run('3. CURED: the same six claims through the mechanism', CURED, true);

/* 4. THE VALUE READER, on the phrases the old table could not read. */
console.log('\n4. valueOf() on the phrases the seven-word table could not read');
for (const s of ['two thousand', 'seven and a half thousand', 'five thousand',
  'eighty-eight', 'a hundred and forty', 'three point two', 'four twenty', '7,412'])
  console.log('    ' + s.padEnd(28) + mod.valueOf(s));

console.log('\nVERDICT  poison ' + p.fails + '/6 red · cured ' + c.fails + '/6 red · '
  + (p.fails === 6 && c.fails === 0 ? 'THE GATE DISCRIMINATES' : 'LOOK AGAIN'));
process.exit(p.fails === 6 && c.fails === 0 ? 0 : 1);
