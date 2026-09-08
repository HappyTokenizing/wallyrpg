#!/usr/bin/env node
/* ============================================================
   tools/voicetest.mjs — THE VOICES SLICE, asserted.

       node tools/voicetest.mjs           everything
       node tools/voicetest.mjs --lines   the node half only (fast)

   THREE THINGS, AND THEY FAIL DIFFERENTLY.

   PART A is plain node over src/character/bubbles.js: the line pool
   itself. No duplicates, no line that the REAL font elides to an
   ellipsis, and a repeat gap wide enough that a six-minute walk does
   not hear the same sentence twice. The elision check is the one that
   caught 24 lines whose punchline was silently cut, so it measures
   with the shipping font and the shipping wrap, not with a length.

   PART B boots the real game and drives the balloon. THE ASSERTION IS
   A SWITCH, NOT A CITATION (contracts.js rule 1): WALLY.debug
   .gawkReach('flat') puts the PRE-ROUND rule back — ANIM_FAR 62 m and
   a 70 m notice radius at every altitude — and 'lens' is what ships.
   Both branches are driven on the SAME page load, at the SAME
   altitudes, over the SAME street, and the pair is the evidence: flat
   must animate nobody above ~15 m and lens must not.

   PART C is the regression the balloon work could plausibly have
   caused and did not: crowd.js's steer() now has an early return in
   it, and the doorway eviction pass lives underneath that return. If
   a wanderer can be parked in a threshold by a balloon going over,
   this is where it shows up.

   Every altitude is reported with the altitude ACTUALLY FLOWN, the
   ground under the lens and the zone the balloon is over, because
   balloon({alt}) teleports and the flight model then moves it.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { boot } from './_perf-lib.mjs';

const ONLY_LINES = process.argv.includes('--lines');
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails++; };

/* ================= PART A — the lines ================= */
const B = await import('../src/character/bubbles.js');
const rngOf = (seed) => { let s = 0; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) | 0;
  return () => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 8) & 0xffffff) / 0x1000000; }; };

console.log('A. the pool');
const all = B.ALL_LINES;
const dup = all.filter((l, i) => all.indexOf(l) !== i);
ok(dup.length === 0, `no duplicate line in ${all.length} (${dup.length} found${dup.length ? ': ' + dup[0] : ''})`);
/* A CHARACTER COUNT IS NOT THE LAYOUT and this assertion is only a
   cheap early warning — the real one is the elision check in Part A2,
   which runs the shipping font. 62 is where the pool sits today. */
/* MEASURED ON WHAT THE PLAYER READS. `{PSHOP}` is seven characters
   and the board can print six there, so the proxy has to run over the
   widest fill or it is measuring the template. */
ok(all.every((l) => B.widestFill(l).length <= 62),
  'every line <= 62 chars at the widest price the board can print (a proxy; A2 is the real check)');

/* THE HOURS THE LINES CLAIM MUST BE THE HOURS THE DOORS KEEP. This is
   the fault the round was called on: "Noodle Cart Alley after nine"
   sat in the 22:00-04:00 bucket and the cart shuts at 23:00, so the
   line invited a walk that contradicted it. Anything in an hour pool
   that names a location by its own name is checked against
   LOCATIONS.hours, in the bucket it is actually filed under. */
const D = await import('../src/game/data.js');
const BUCKET = { dawn: [5, 7], evening: [18, 21], night: [22, 28] };  // night wraps
const NAMED = [
  ['noodlecart', /noodle cart|the cart\b/i],
  ['cafe', /bent spoon/i],
  ['bazaar', /bazaar/i],
  ['exchange', /exchange/i],
  ['markethall', /market hall/i],
];
for (const [bucket, [lo, hi]] of Object.entries(BUCKET)) {
  for (const line of B.HOUR_LINES[bucket] || []) {
    for (const [id, re] of NAMED) {
      if (!re.test(line)) continue;
      const L = D.LOCATIONS.find((x) => x.id === id);
      /* every hour the bucket can fire in, against that door's hours */
      let openAll = true, shutAll = true;
      for (let h = lo; h <= hi; h++) {
        const hh = h % 24;
        const open = hh >= L.hours[0] && hh < L.hours[1];
        if (open) shutAll = false; else openAll = false;
      }
      /* A line may name a shut door ON PURPOSE — "The Bent Spoon shut
         at seven", "The Exchange is dark" — and those are the best
         lines in the pool. What it may not do is name it as OPEN. */
      const claimsOpen = !/shut|dark|closed|lights on|until|opens at|does not open/i.test(line);
      ok(!(claimsOpen && shutAll),
        `${bucket} ${lo}-${hi}h vs ${id} ${L.hours[0]}-${L.hours[1]}h: ${line}`);
    }
  }
}

/* ============================================================
   THE PRICE GATE — and the reason it is 120 lines instead of six.

   The gate this replaces matched `^TICK (is|at) <at most two lowercase
   words>[.,]` against a seven-entry number-word table and `continue`d
   on anything else. It therefore SKIPPED, in silence:

     'PWHSE is full of nothing. Two thousand.'   (board 2100)
     'PTWR is seven and a half thousand. One floor.'  (board 7400)
     'PLUXE at five thousand and the lift is out again.'  (board 5200)

   — the price in the second sentence, the price four words long, the
   price followed by "and". A gate that skips what it cannot parse
   reports green on exactly the cases it was written for, so the rule
   here is: EVERY number in a line that names a ticker is CLASSIFIED,
   and an unclassifiable one FAILS. There is no `continue`.

   Six classes, and every one of them is asserted or printed:
     price   TICK + a price connective + a number   -> FAIL, use {TICK}
     money   a number followed by dollars/each/apiece -> FAIL, ditto
     move    up|down + a number + per cent          -> FAIL, ditto
     coupon  TICK pays <n>                          -> === ASSETS.cpn
     echo    a sentence that is nothing but a number -> must repeat a
             number already in the line ('...nine pickers. Nine.')
     count   a number with its noun ('nine pickers'), or with its noun
             elided into the previous sentence ('They built four
             hundred.')                             -> printed, in full
   `count` is the only class that is neither failed nor equated, so it
   is printed line by line under a heading that says to read it. A
   silent tolerance is what the last gate was.
   ============================================================ */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen'];
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALE = ['hundred', 'thousand', 'million'];
const WORD_VAL = {};
ONES.forEach((w, i) => { WORD_VAL[w] = i; });
TENS.forEach((w, i) => { WORD_VAL[w] = (i + 2) * 10; });

/* A number PHRASE: digits, or a run of number words joined by spaces,
   hyphens, 'and' and 'a' ('a hundred and forty', 'seven and a half
   thousand', 'eighty-eight', 'three point two', 'two-ten'). */
const NW = [...ONES, ...TENS, ...SCALE].join('|');
const PHRASE_RE = new RegExp(
  '(?:(?<![A-Za-z0-9])\\d[\\d,]*(?:\\.\\d+)?(?![A-Za-z0-9]))'
  + '|(?:\\b(?:' + NW + ')\\b(?:[- ](?:and[- ])?(?:a[- ])?(?:half|point|' + NW + ')\\b)*)',
  'gi',
);

/** eighty-eight -> 88, a hundred and forty -> 140, three point two -> 3.2 */
function valueOf(phrase) {
  const t = String(phrase).trim().toLowerCase();
  if (/^[\d,]+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));
  const w = t.split(/[\s-]+/).filter((x) => x && x !== 'and' && x !== 'a');
  /* 'three point two' */
  const pi = w.indexOf('point');
  if (pi > 0) {
    const whole = valueOf(w.slice(0, pi).join(' '));
    const frac = w.slice(pi + 1).map((x) => WORD_VAL[x] ?? NaN);
    if (whole === null || frac.some(Number.isNaN)) return null;
    return parseFloat(whole + '.' + frac.join(''));
  }
  let total = 0, cur = 0, seen = false;
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    if (x === 'half') { cur = (cur || 1) + 0.5; seen = true; continue; }
    if (x === 'hundred') { cur = (cur || 1) * 100; seen = true; continue; }
    if (x === 'thousand') { total += (cur || 1) * 1000; cur = 0; seen = true; continue; }
    if (x === 'million') { total += (cur || 1) * 1e6; cur = 0; seen = true; continue; }
    if (WORD_VAL[x] === undefined) return null;
    cur += WORD_VAL[x]; seen = true;
  }
  return seen ? total + cur : null;
}

/* Connectives that make the number a PRICE OF THE TICKER. Deliberately
   generous: a word missing here is a typed price the gate waves past,
   which is the failure this file exists to stop. */
const PRICE_CONNECT = new Set(['is', 'are', 'was', 'at', 'hit', 'hits', 'costs', 'cost',
  'fetches', 'fetch', 'worth', 'trades', 'trading', 'sells', 'sold', 'bought', 'buys',
  'goes', 'went', 'for', 'to', 'around', 'about', 'near', 'under', 'over', 'back',
  'down', 'up', 'still', 'now', 'only', 'just', 'a', 'the', 'an']);
/* A noun after the number makes it a COUNT, not a price — except for
   these, which make it a price with a unit bolted on. */
const MONEY_NOUN = /^(dollars?|bucks?|each|apiece|a\s*piece|grand|k)\b/i;
/* A COUNT NEEDS A NOUN ON IT. 'nine pickers' counts pickers; 'eighty-
   eight and still buying' counts nothing — 'and' is not a unit, and
   treating it as one is how three typed prices walked through the
   first draft of this gate. Anything that is a function word sends the
   number back to the price branch. */
const STOPWORD = new Set(['and', 'but', 'or', 'so', 'yet', 'if', 'then', 'than', 'because',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this', 'these', 'those',
  'he', 'she', 'they', 'we', 'i', 'you', 'him', 'her', 'them', 'me', 'my', 'his', 'their',
  'still', 'now', 'again', 'only', 'just', 'not', 'no', 'never', 'ever', 'here', 'there',
  'nobody', 'somebody', 'everybody', 'anyone', 'everyone', 'someone', 'all', 'any', 'more',
  'less', 'up', 'down', 'out', 'off', 'over', 'under', 'per']);

const isWord = (s) => /^[a-z'’-]+$/i.test(s);

/**
 * Classify and assert every number in every line.
 * @param {string[]} lines
 * @param {object[]} assets  data.js ASSETS
 * @param {(cond:boolean,msg:string)=>void} ok
 */
function priceGate(lines, assets, ok) {
  const TICKS = new Map(assets.map((a) => [a.tick, a]));
  const counts = [];
  let checked = 0;
  for (const line of lines) {
    const named = (line.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) || []).filter((t) => TICKS.has(t));

    /* SLOTS FIRST — they are the mechanism, so they get asserted too. */
    for (const t of line.match(/\{([A-Z][A-Z0-9]{1,5})\}/g) || []) {
      const tick = t.slice(1, -1);
      checked++;
      ok(TICKS.has(tick), `slot ${t} names a real ticker: ${line}`);
      ok(named.includes(tick), `slot ${t} quotes the ticker its own line names: ${line}`);
    }
    /* A DAY MOVE IS A BOARD NUMBER TOO, AND IT DOES NOT NEED A TICKER.
       "Honey up eleven per cent" sends a player to HONEY exactly as a
       ticker would, and the board's day change will not say eleven.
       Scanned on every line, before the ticker filter, because that
       filter is what let this one through. */
    {
      const mv = line.match(/\b(?:up|down|off|ahead)\s+([\w'’-]+(?:[- ][\w'’-]+){0,2}?)\s+(?:per\s+cent|%)/i);
      if (mv && valueOf(mv[1]) !== null) {
        checked++;
        ok(false, `a day move is a board number and cannot be typed — "${mv[1]} per cent": ${line}`);
      }
    }
    if (!named.length) continue;

    /* sentence spans, so a claim cannot leak across a full stop */
    const sentences = [];
    { let i = 0; for (const part of line.split(/(?<=[.!?])\s+/)) { sentences.push([i, i + part.length, part]); i += part.length + 1; } }
    const sentenceAt = (i) => sentences.find(([a, b]) => i >= a && i < b) || sentences[sentences.length - 1];

    PHRASE_RE.lastIndex = 0;
    const found = [];
    let m;
    while ((m = PHRASE_RE.exec(line))) found.push({ txt: m[0], i: m.index });

    for (let k = 0; k < found.length; k++) {
      const { txt, i } = found[k];
      const lower = txt.toLowerCase();
      const multi = /[\s-]/.test(lower.trim()) || /^\d/.test(lower);
      const [sa, , stext] = sentenceAt(i);
      const before = line.slice(0, i).replace(/[^\w'’-]+$/, '');
      const prevWord = (before.match(/[\w'’-]+$/) || [''])[0];
      /* the next word IN THIS SENTENCE. Across a full stop it is not
         this number's noun — 'A real one. In money.' is a pronoun and
         a new sentence, not a count of Ins. */
      const restOfSentence = line.slice(i + txt.length, sentenceAt(i)[1]);
      const after = restOfSentence.replace(/^[^\w{]+/, '');
      const nextWord = (after.match(/^[\w'’-]+/) || [''])[0];
      /* the sentence stripped of the number: '' means the sentence IS
         the number, which is the shape 'Two thousand.' hid inside */
      const bare = stext.replace(txt, '').replace(/[^A-Za-z]/g, '') === '';

      /* 'one' is also a pronoun ('A real one.', 'A third one.'). It is
         a quantity only with a noun on it or standing as a sentence.
         Every other numeral is always a numeral. */
      if (lower === 'one' && !bare && !(nextWord && isWord(nextWord))) continue;
      checked++;

      /* the move scan above already failed this one */
      if (/^(up|down|off|ahead)$/i.test(prevWord) && /^(per\s+cent|%)/i.test(after)) continue;
      /* --- coupon: TICK pays <n> --- */
      if (/^pays?$/i.test(prevWord)) {
        const t = named.find((x) => stext.includes(x));
        const a = t && TICKS.get(t);
        ok(!!a && a.cpn !== undefined && Math.abs(valueOf(txt) - a.cpn) < 1e-9,
          `${t || '?'} pays ${txt} (${valueOf(txt)}); data.js cpn is ${a ? a.cpn : 'n/a'}: ${line}`);
        continue;
      }
      /* --- echo: a sentence that is only a number --- */
      if (bare) {
        const v = valueOf(txt);
        const echoed = found.slice(0, k).some((f) => valueOf(f.txt) === v);
        ok(echoed, `"${txt}." stands alone as a sentence, so it must repeat a number already `
          + `in the line — otherwise it reads as a price and nothing checks it: ${line}`);
        continue;
      }
      /* --- money: a price with a unit bolted on --- */
      if (MONEY_NOUN.test(after)) {
        ok(false, `"${txt} ${nextWord}" is a typed price — use {TICK}: ${line}`);
        continue;
      }
      /* --- count: a number with its noun on it --- */
      if (nextWord && isWord(nextWord) && !STOPWORD.has(nextWord.toLowerCase())) {
        counts.push(`${txt} ${nextWord}`.padEnd(28) + line);
        continue;
      }
      /* --- price: the ticker's own sentence, a connective, a number --- */
      const tickInSentence = named.some((t) => stext.includes(t));
      if (tickInSentence) {
        const between = before.slice(sa - Math.min(sa, 0)).split(/\s+/).slice(-4);
        const path = between.every((w) => !w || PRICE_CONNECT.has(w.toLowerCase()) || TICKS.has(w));
        ok(false, `${named[0]} quotes "${txt}" as a typed number; the board is `
          + `seeded at v*(0.94..1.06) and moves daily — use {${named[0]}}`
          + (path ? '' : ' [connective not recognised, which is also a fail]') + `: ${line}`);
        continue;
      }
      /* --- count with its noun elided into the previous sentence --- */
      if (multi || (nextWord && isWord(nextWord) && !STOPWORD.has(nextWord.toLowerCase()))) {
        counts.push(`${txt} (noun elided)`.padEnd(28) + line);
        continue;
      }
      ok(false, `unclassified number "${txt}" beside ${named[0]} — the gate cannot tell whether `
        + `a player can check it, and that is a fail: ${line}`);
    }
  }
  return { checked, counts };
}

/* ------------------------------------------------------------------
   THE REVERT CHECK (contracts.js rule 1). TODAY'S GATE AGAINST
   YESTERDAY'S CODE, not yesterday's gate against yesterday's code —
   the second of those passes by construction and says nothing.

   Both gates and both line sets on the same run, so the pair is the
   evidence rather than a before-number quoted in a comment. The
   shipped gate looks at six of these twenty-four lines and passes; the
   one above classifies twenty-nine numbers in them and fails sixteen,
   including the three the shipped one could not parse and skipped in
   silence (PWHSE's price in the second sentence, PTWR's four-word
   price, PLUXE's price followed by "and").
   ------------------------------------------------------------------ */
const OLD_LINES = [
  'CTSK at eighty-eight and still buying.',
  'Bought HERD at 140. Cows always come back.',
  'BGRD pays a dividend. A real one. In money.',
  'ORBT sold nine pickers to Green Edge. Nine.',
  'SOLAR, on a field that grew nothing for nine years.',
  'B5Y pays three point two. Boring is a strategy.',
  'LNTR opened a third shop. A third one.',
  'CTSK at eighty-eight is a story, not a firm.',
  'GEMS at four twenty. For a rock. In a bag.',
  'Two years of ACRN. Two years of tinned hope.',
  'ORBT sold nine pickers. They built four hundred.',
  'WATCH at five sixty. It does not even keep time.',
  'B10Y locks it away for ten years. Ten.',
  'PLUXE at five thousand and the lift is out again.',
  'RICO is one chef. That is the whole business.',
  'WFLW is twelve. There is a reason it is twelve.',
  'PFLAT is up nine per cent and nobody here can sell.',
  'PSHOP is sixteen hundred. For a doorway.',
  'PDORM is nineteen hundred. Original radiators.',
  'SNEAK at two-ten. For shoes somebody wore.',
  'HERD is a hundred and forty and the cows do not know.',
  'PWHSE is full of nothing. Two thousand.',
  'PTWR is seven and a half thousand. One floor.',
  'Honey up eleven per cent. I have four hives.',
];

/** The gate as it shipped at 41194ad, verbatim. */
function shippedGate(lines, ok) {
  const NUMWORD = { twelve: 12, 'eighty-eight': 88, 'four twenty': 420, 'five sixty': 560,
    'two-ten': 210, 'sixteen hundred': 1600, 'nineteen hundred': 1900 };
  let looked = 0;
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9]{3,5}) (?:is|at) ([a-z-]+(?: [a-z-]+)?)[.,]/);
    if (!m) continue;
    const a = D.ASSETS.find((x) => x.tick === m[1]);
    if (!a || !(m[2] in NUMWORD)) continue;
    looked++;
    ok(NUMWORD[m[2]] === a.v, `${m[1]} quoted at ${NUMWORD[m[2]]}, board says ${a.v}: ${line}`);
  }
  return looked;
}

console.log('\nA1. prices — every number beside a ticker, classified');
{
  const res = priceGate(all, D.ASSETS, ok);
  console.log(`  info  ${res.checked} numbers and slots classified in ${all.length} lines`);
  console.log('  info  counts accepted (a number with its noun on it) — READ THESE:');
  for (const c of res.counts) console.log('        ' + c);
}

console.log('\nA1b. the revert check — both gates, both line sets, one run');
{
  let sf = 0, nf = 0;
  const looked = shippedGate(OLD_LINES, (c) => { if (!c) sf++; });
  const res = priceGate(OLD_LINES, D.ASSETS, (c, m) => { if (!c) { nf++; console.log('        would fail: ' + m); } });
  console.log(`  info  shipped gate vs the old lines: looked at ${looked}/${OLD_LINES.length}, ${sf} failed`);
  console.log(`  info  this gate    vs the old lines: classified ${res.checked}, ${nf} failed`);
  ok(sf === 0 && looked < OLD_LINES.length,
    `the shipped gate passed the old lines (${sf} fails) having looked at only ${looked} of ${OLD_LINES.length}`);
  ok(nf >= 14, `this gate fails ${nf} of them, PWHSE / PTWR / PLUXE included`);
  for (const must of ['PWHSE is full of nothing. Two thousand.',
    'PTWR is seven and a half thousand. One floor.',
    'PLUXE at five thousand and the lift is out again.']) {
    let hit = 0;
    priceGate([must], D.ASSETS, (c) => { if (!c) hit++; });
    ok(hit > 0, `the case the shipped gate skipped in silence now fails: ${must}`);
  }
}

/* ------------------------------------------------------------------
   A1c. THE SLOT, BOTH WAYS ON ONE RUN. The mechanism is "a price is
   read from the board when the line is spoken", and it has two halves
   that fail differently: with a board the slot must be GONE from what
   the speaker says, and with no board the line must not be OFFERED at
   all. Node has no ctx.game, so without this the whole node half runs
   with the twelve slot lines invisible and proves nothing about them.
   ------------------------------------------------------------------ */
console.log('\nA1c. the slot, board on and board off, one run');
{
  const slotted = all.filter(B.hasSlot);
  ok(slotted.length >= 12, `${slotted.length} lines quote the live board`);

  /* board OFF — the state npc.js is in for the first few seconds */
  B.setPriceBoard(null);
  ok(slotted.every((l) => B.fillPrices(l) === null), 'with no board every slot line is unsayable');
  {
    const p = B.createLinePicker(rngOf('slot-off'));
    let leaked = 0;
    for (let i = 0; i < 600; i++) if (String(p.pick({ zone: 'mainstreet', hour: 13 })).includes('{')) leaked++;
    ok(leaked === 0, `board off: 0 of 600 picks put a brace on screen (${leaked})`);
  }

  /* board ON — every slot filled, and filled with the board's own text */
  const seenTicks = [];
  B.setPriceBoard((t) => { seenTicks.push(t); return t === 'PTWR' ? '7,412' : '1,234'; });
  ok(B.fillPrices('PTWR is {PTWR}. One floor.') === 'PTWR is 7,412. One floor.',
    'the fill is the board\'s own string: ' + B.fillPrices('PTWR is {PTWR}. One floor.'));
  {
    const p = B.createLinePicker(rngOf('slot-on'));
    let braces = 0, filled = 0;
    for (let i = 0; i < 600; i++) {
      const l = String(p.pick({ zone: 'mainstreet', hour: 13 }));
      if (l.includes('{')) braces++;
      if (l.includes('1,234') || l.includes('7,412')) filled++;
    }
    ok(braces === 0, `board on: no brace reaches the screen (${braces})`);
    ok(filled > 0, `board on: ${filled} of 600 picks quoted the live board`);
  }
  /* EVERY slot ticker, not just the ones one street happens to open:
     PWHSE only ever fires in Iron Hills and PDORM only in the Learning
     Quarter, so a single-scene check would leave most of them untried. */
  const want = new Set(all.flatMap((l) => B.slotTickers(l)));
  for (const zone of Object.keys(B.DISTRICT_LINES).concat([null])) {
    const p2 = B.createLinePicker(rngOf('slot-' + zone));
    for (let i = 0; i < 400; i++) p2.pick({ zone, hour: 13 });
  }
  const asked = new Set(seenTicks);
  const never = [...want].filter((t) => !asked.has(t));
  ok(never.length === 0,
    `every one of the ${want.size} slot tickers was read off the live board (missed: ${never.join(', ') || 'none'})`);
  B.setPriceBoard(null);
}

/* The picker, on a fixed scene, on a fresh stream. */
for (const scene of [
  { zone: 'mainstreet', hour: 13 }, { zone: 'rustyrow', hour: 23 },
  { zone: 'waterfront', hour: 19, rainfall: 0.6 }, { zone: null, hour: 12 },
]) {
  const p = B.createLinePicker(rngOf('voicetest' + JSON.stringify(scene)));
  const seen = new Map(); let minGap = Infinity;
  for (let i = 0; i < 400; i++) {
    const l = p.pick(scene);
    if (seen.has(l)) minGap = Math.min(minGap, i - seen.get(l));
    seen.set(l, i);
  }
  ok(minGap >= 20, `minGap ${minGap} >= 20  ${JSON.stringify(scene)}`);
}
if (ONLY_LINES) { console.log(fails ? `\n${fails} FAILED` : '\nall green'); process.exit(fails ? 1 : 0); }

/* ================= PART B and C — the real game ================= */
const logs = [];
const { page, close } = await boot({ w: 1600, h: 900, qs: '?skipIntro', logs });
await page.waitForTimeout(4000);
const arrived = await page.evaluate(() => WALLY.debug.arrive('cafe'));
if (arrived !== true) { console.log('  FAIL arrive(cafe) returned ' + arrived); await close(); process.exit(1); }
await page.evaluate(() => {
  const t = WALLY.ctx.game.time; const w = 13 - (t.hour ?? 12);
  if (w > 0) t.advance(Math.round(w * 60), 0);
  const c = WALLY.ctx, p = c.wally.position;
  let sx = 0, sz = 0, n = 0;
  for (const h of c.npc.humans) { if (h.asleep) continue;
    const d = Math.hypot(h.root.position.x - p.x, h.root.position.z - p.z);
    if (d > 80) continue; sx += h.root.position.x; sz += h.root.position.z; n++; }
  if (n) c.wally.setYaw(Math.atan2(sx / n - p.x, sz / n - p.z));
});
await page.waitForTimeout(2500);

/* the font, with the real canvas — this cannot be done in node */
console.log('\nA2. the font (real canvas, real wrap)');
const fit = await page.evaluate(() => WALLY.debug.bubbleFit());
ok((fit.elided || []).length === 0, `no line elided to an ellipsis (${(fit.elided || []).length})`);
/* AND SAY WHICH. "5" is a number to go hunting with; the lines are the
   fix. measure() lays out widestFill(), so a slot line is printed at
   the widest price the economy's 2.7x clamp can ever put in it. */
for (const l of fit.elided || []) console.log('        elided: ' + l);
/* rows3 is information, not a gate: the pool has ALWAYS been a
   three-row pool (maxW is 290 px at 30 px bold, about nineteen
   characters) and the file's own header claimed two for a long time.
   The gate is the ellipsis, because that is where the punchline goes. */
console.log(`  info  ${fit.rows3.length}/${fit.n} lines take three rows; widest row ${fit.widest.w}px of ${fit.maxW}px`);

console.log('\nB. the balloon, both rules on one page load');
const foot = await page.evaluate(() => WALLY.debug.bubbleScene().gawk);
ok(foot.reach === 70, `on foot the notice radius is the old 70 m (is ${foot.reach})`);
await page.evaluate(() => { try { WALLY.ctx.game.actions.grantRide('balloon'); } catch (e) {} });
await page.waitForTimeout(2000);

/* 90 m is AIRVIEW.min in data.js — the floor at which the balloon's
   whole reason for existing (the horizon discovery radius) switches
   on, so it is the altitude a player who bought a $24,000 machine
   actually flies at. 150 and 250 are past it. 19 m USED TO BE THE
   FIRST RUNG and it was the reason this block read green through two
   rounds of the bug: it is below AIRVIEW.min, it is the one altitude
   the old rule happened to reach, and it carried the assertion for
   the two rows above it that did not. The ladder now starts where
   the machine is flown. */
const ALTS = [90, 150, 250];
const table = [];
for (const mode of ['flat', 'lens']) {
  await page.evaluate((m) => WALLY.debug.gawkReach(m), mode);
  for (const alt of ALTS) {
    /* PINNED TWICE ON PURPOSE. The first balloon({alt}) after
       grantRide does not take — a run whose first rung asked for 90 m
       measured 4.1 m agl 2.8 s later and still climbing, so row one
       was never the altitude it printed. */
    await page.evaluate((a) => { WALLY.debug.balloon({ alt: a }); }, alt);
    await page.waitForTimeout(500);
    await page.evaluate((a) => { WALLY.debug.balloon({ alt: a }); }, alt);
    await page.waitForTimeout(2800);
    table.push(await page.evaluate((m) => {
      const c = WALLY.ctx, wp = c.wally.position;
      const g = WALLY.debug.bubbleScene().gawk;
      let z = null; try { z = c.world.zoneAt(wp.x, wp.z)?.id ?? null; } catch (e) {}
      return { mode: m, agl: +(wp.y - c.world.heightAt(wp.x, wp.z)).toFixed(1),
        camY: +c.camera.position.y.toFixed(1), zone: z,
        reach: g.reach, active: g.active, looking: g.looking,
        /* LOOKING IS NOT PROOF. It counts gawkOn, which is non-zero
           for people who are not drawn at all — which is exactly how
           "nobody notices" shipped twice past a green test. Count
           what is on the screen. */
        drawn: g.sky + c.npc.humans.filter((h) => h.root.visible).length,
        stopped: g.stopped, pointing: g.pointing };
    }, mode));
  }
}
console.log('  mode  agl  camY zone           reach act look stop pnt');
for (const r of table) {
  console.log('  ' + r.mode.padEnd(5), String(r.agl).padStart(4), String(r.camY).padStart(5),
    String(r.zone).padEnd(14), String(r.reach).padStart(5), String(r.active).padStart(3),
    String(r.looking).padStart(4), String(r.stopped).padStart(4), String(r.pointing).padStart(3));
}
const flat = table.filter((r) => r.mode === 'flat' && r.agl > 14);
const lens = table.filter((r) => r.mode === 'lens' && r.agl > 14);
ok(flat.length > 0 && flat.every((r) => r.reach === 70),
  'flat: the notice radius is 70 m at every altitude — the rule that shipped before');
ok(flat.length > 0 && flat.every((r) => r.looking === 0),
  'flat: NOBODY looks up above 14 m, which is the complaint, reproduced');
/* `some` WAS GREEN WHILE THE TABLE ABOVE IT ENDED IN A ZERO ROW.
   19 m and 90 m carried the assertion and 150 m — the altitude a
   player who has bought the machine actually flies at — reported
   nobody looking up at all, which is the complaint, unfixed, printed
   two lines higher and asserted past. The claim the lens rule makes is
   "at EVERY altitude", so that is what is asserted, and the failure
   names the row rather than leaving it to be read out of the table. */
const dead = lens.filter((r) => r.looking === 0 || r.drawn === 0);
ok(lens.length > 0 && dead.length === 0,
  'lens: somebody is DRAWN and looks up at EVERY altitude at or above AIRVIEW.min — '
  + lens.map((r) => r.agl + 'm:' + r.drawn + '/' + r.looking).join(' ')
  + (dead.length ? '   <- ZERO at ' + dead.map((r) => r.agl + 'm').join(', ') : ''));
ok(lens.every((r) => r.active <= 46), 'lens: the skeleton budget is never exceeded');

console.log('\nC. the doorways still evict (crowd.js steer() early return)');
await page.evaluate(() => { WALLY.debug.balloon(false); });
await page.waitForTimeout(1500);
await page.evaluate(() => WALLY.debug.doorProbe({ n: 6, pause: 12, evict: true }));
await page.waitForTimeout(9000);
const probe = await page.evaluate(() => WALLY.debug.doorProbeState());
const stood = probe.rows.map((r) => r.stood).filter((v) => v >= 0);
ok(stood.length >= 4, `${stood.length} probes reported (of ${probe.rows.length})`);
ok(stood.every((v) => v <= 1.6), `nobody stood in a doorway longer than 1.6 s (worst ${Math.max(...stood)})`);

const errs = logs.filter((l) => l.startsWith('[PAGEERROR]'));
ok(errs.length === 0, `no page errors (${errs.length})` + (errs[0] ? ' — ' + errs[0] : ''));
await close();
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
