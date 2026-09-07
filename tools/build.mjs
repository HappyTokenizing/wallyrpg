#!/usr/bin/env node
/* ============================================================
   build.mjs — produce the standalone, double-clickable build,
   AND PROVE IT IS THE GAME.

   Bundles every ES module (including the vendored three.js) into a
   single inline <script type="module"> inside one HTML file. Inline
   module scripts have no fetches, so the result runs from file://
   with no server, no build step and no network — which is the whole
   promise of the original game, kept.

     node tools/build.mjs            -> WALLY-RPG.html   (minified)
     node tools/build.mjs --dev      -> WALLY-RPG.html   (readable, sourcemap)
     node tools/build.mjs --check    -> AUDIT ONLY. Never writes, never
                                       opens a browser. Exits non-zero
                                       if the file on disk is not what
                                       this source tree builds.
     node tools/build.mjs --no-verify   build + audit, skip the browser

   ------------------------------------------------------------
   WHY THE AUDIT EXISTS.

   WALLY-RPG.html is the only file most people ever open, and NOTHING
   in the gate used to look at it. It went stale in exactly the way
   you would predict: `git show HEAD:WALLY-RPG.html` was 2 597 021
   bytes and contained ZERO occurrences of `balloon.envelope`. A whole
   subsystem had been written, tested and reviewed, and the
   deliverable did not have it. The build was not broken — it was
   simply never re-run, and a stale deliverable that boots cleanly and
   looks fine is the worst failure mode available here, because every
   symptom of it is invisible.

   So the build now refuses to write a bundle it cannot vouch for, and
   `--check` answers the question the gate was missing: IS THE FILE ON
   DISK WHAT THIS SOURCE TREE BUILDS? tools/test-balloon.mjs asks it on
   every run.

   FOUR CHECKS, AND EACH ONE FAILS ON A DIFFERENT KIND OF HOLE.

   1. THE MODULE CENSUS. Every .js file under src/ on disk must appear in
      esbuild's own metafile inputs. This is the one that catches a
      subsystem that was written and never wired in: a file nothing
      imports is either dead code or a feature that does not ship, and
      both deserve a red build rather than a quiet one.

   2. THE EXPORT CENSUS. Every name exported by every source module
      must appear in the bundle text. It is auto-maintaining — it
      grows with the source tree and nobody has to remember to add to
      it — and it works because `minifyIdentifiers` is off, so a
      top-level name survives verbatim (esbuild's collision suffix
      makes `FLIGHT` into `FLIGHT2`, which still contains it).

   3. THE SUBSYSTEM MARKERS. A short table of runtime literals, one
      group per major subsystem, that prove a FEATURE is in the file
      rather than merely a symbol. THE TABLE CANNOT ROT SILENTLY:
      every marker is asserted to exist in the SOURCE first, so a
      marker that has been renamed out of the codebase fails as
      "update the table", never as a quiet green.

   4. THE FLOORS AND THE SELF-CONTAINMENT. A size floor against the
      source tree's own byte count, and the rule that makes file://
      work at all: no external <script src>, no stylesheet link, no
      module left to fetch.

   AND THE STALENESS CHECK, which is the actual hole. --check rebuilds
   in memory and compares byte for byte with WALLY-RPG.html on disk.
   esbuild is deterministic for the same inputs and options, so a
   mismatch means one thing: somebody changed src/ or index.html and
   did not rebuild. It says so, with the size delta and the first
   byte that differs.

   THE COMMITTED COPY gets the same treatment, conditionally, and the
   condition is the point: if the working tree matches HEAD for src/
   and index.html, then there is no excuse for a stale committed
   bundle and it is a HARD FAILURE. If the tree is dirty — someone is
   mid-feature, which is the normal case — it is a loud warning
   instead, because a gate that can only be green in the instant after
   a commit is a gate people turn off.
   ============================================================ */

import { build } from 'esbuild';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV = process.argv.includes('--dev');
const CHECK = process.argv.includes('--check');
const VERIFY = !CHECK && !process.argv.includes('--no-verify');
const OUT = resolve(ROOT, process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'WALLY-RPG.html');

/* ------------------------------------------------------------
   THE SUBSYSTEM MARKERS.

   One group per thing a player would notice the absence of. Every
   literal here is checked against the SOURCE before it is checked
   against the bundle, so this table cannot quietly stop meaning
   anything: rename `balloon.envelope` in balloon.js and the build
   says "marker no longer in src/ — the table is stale", which is a
   different and much more useful failure than silence.
   ------------------------------------------------------------ */
const MARKERS = Object.freeze({
  'the balloon':        ['balloon.envelope', 'balloon.throat', 'stepFlight', 'setInflate'],
  'the outline pass':   ['isOutlineHull', 'cullHulls', 'aHullN'],
  'the burner light':   ['setLocalLight', 'uGlowFade', 'uEmissive'],
  'the ocean':          ['uWaveFade', 'seaLevel'],
  'the wind':           ['windWave', 'uWindGust'],
  'the city':           ['buildingAt', 'shoreDistAt'],
  'the rides economy':  ['canBuyRide', 'parkSpot', 'syncParked', 'restoreParked'],
  'the save':           ['exportJSON'],
  'the intro':          ['titlecard'],
  'the boot handshake': ['__WALLY_READY__', '__WALLY_PERF__'],
});

/* the floor the bundle may not fall under, as a fraction of the bytes
   the source tree actually holds. Whitespace-only minification takes
   roughly a quarter off; anything under this has lost a subsystem,
   not a space. */
const SIZE_FLOOR_FRACTION = 0.35;
const SIZE_FLOOR_BYTES = 1_900_000;

/* ------------------------------------------------------------ */

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Names a module puts into the bundle's top level. */
function exportedNames(src) {
  const names = new Set();
  const re = /^\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(re)) names.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const id = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) names.add(id);
    }
  }
  return names;
}

/** Names a module asks another module for AND then actually uses.
    "Imported" alone is not enough: esbuild drops an import nothing
    references, and so it should — an unused import is dead weight, not
    a missing subsystem. The import and re-export statements are cut out
    of the text before the identifier is looked for, so a name that only
    ever appears in the import line does not count as used, and neither
    does a name that only survives in a doc comment — physics.js has an
    `@see CHAIN_DEFAULTS` for a constant it re-exports and never calls,
    and a census that believed that comment would demand a symbol the
    bundler is right to drop. The stripping is deliberately blunt and
    errs toward "not used": every mistake it can make SHRINKS the
    census, so it can lose coverage but it cannot invent a failure. */
function usedImports(src) {
  const body = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*import\s*(?:\{[^}]*\}|[\w$*\s,]+)\s*from\s*['"][^'"]*['"];?/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*(?:from\s*['"][^'"]*['"])?;?/gm, '');
  const names = new Set();
  for (const m of src.matchAll(/^\s*import\s*\{([^}]*)\}\s*from/gm)) {
    for (const part of m[1].split(',')) {
      const id = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id) && new RegExp(`\\b${id}\\b`).test(body)) names.add(id);
    }
  }
  return names;
}

async function bundleOnce() {
  const result = await build({
    entryPoints: [resolve(ROOT, 'src/main.js')],
    bundle: true,
    format: 'esm',
    target: ['chrome110', 'firefox110', 'safari16'],
    // Granular rather than `minify: true`. esbuild's SYNTAX pass merges
    // adjacent template-literal concatenations, and the SVG builders in
    // src/ui and src/intro concatenate dozens of them — the merge mangles
    // ${...} into literal text and the page dies with "Expected length, ${p}".
    // Identifier renaming breaks it the same way, and it would break the
    // export census below with it. Whitespace-only is safe and still gets
    // most of the size win.
    minifyWhitespace: !DEV,
    minifyIdentifiers: false,
    minifySyntax: false,
    sourcemap: DEV ? 'inline' : false,
    legalComments: 'none',
    write: false,
    metafile: true,
    logLevel: CHECK ? 'silent' : 'warning',
    loader: { '.glsl': 'text', '.png': 'dataurl', '.webp': 'dataurl' },
    define: { 'process.env.NODE_ENV': DEV ? '"development"' : '"production"' },
  });
  return { js: result.outputFiles[0].text, metafile: result.metafile };
}

/** Take the dev shell verbatim and swap the module <script> for the
    bundle, so the two builds can never drift apart. */
async function assemble(js) {
  const shell = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  const tag = /<script type="module"[^>]*src="[^"]*"\s*><\/script>/;
  if (!tag.test(shell)) {
    console.error('build: could not find the module <script src> tag in index.html');
    process.exit(1);
  }
  return shell
    .replace(/<title>.*?<\/title>/, '<title>WALLY RPG</title>')
    // </script> inside a string literal would close the tag early.
    .replace(tag, `<script type="module">\n${js.replace(/<\/script>/gi, '<\\/script>')}\n</script>`);
}

/* ------------------------------------------------------------
   THE AUDIT
   ------------------------------------------------------------ */
async function audit(html, js, metafile) {
  const bad = [];
  const lines = [];

  const files = await walk(resolve(ROOT, 'src'));
  const rel = files.map((f) => f.replace(ROOT + '/', ''));
  const sources = await Promise.all(files.map((f) => readFile(f, 'utf8')));
  const allSrc = sources.join('\n');
  const srcBytes = sources.reduce((n, s) => n + Buffer.byteLength(s), 0);
  let vendorBytes = 0;
  for (const v of ['vendor/three.module.js', 'vendor/three.core.js']) {
    vendorBytes += (await stat(resolve(ROOT, v))).size;
  }

  /* 1. THE MODULE CENSUS — everything on disk is in the graph. */
  const inputs = new Set(Object.keys(metafile.inputs));
  const orphans = rel.filter((f) => !inputs.has(f));
  if (orphans.length) {
    bad.push(`${orphans.length} module(s) in src/ are not in the bundle graph — nothing imports them, so they do not ship: ${orphans.join(', ')}`);
  }
  lines.push(`modules   ${rel.length - orphans.length}/${rel.length} of the .js files under src/ are in the graph`);

  /* 2. THE EXPORT CENSUS — every LIVE exported name survives into the
     text. Live means some other module in src/ actually imports that
     name: an export nobody imports is dead, esbuild drops it, and
     demanding it be in the bundle would be demanding the bundler stop
     doing its job. What must survive is the graph's real surface — and
     that is still the check that catches a subsystem going missing,
     because `stepFlight` is a name wally.js asks balloon.js for. The
     dead ones are counted and reported rather than ignored; a growing
     number there is dead code, which is worth seeing. */
  const wanted = new Set();
  for (const s of sources) for (const n of usedImports(s)) wanted.add(n);
  let live = 0, dead = 0;
  const lost = [];
  for (let i = 0; i < rel.length; i++) {
    for (const n of exportedNames(sources[i])) {
      if (!wanted.has(n)) { dead++; continue; }
      live++;
      if (!js.includes(n)) lost.push(`${n} (${rel[i]})`);
    }
  }
  if (lost.length) {
    bad.push(`${lost.length} exported name(s) the source imports are NOT in the bundle: ${lost.slice(0, 12).join(', ')}${lost.length > 12 ? ' …' : ''}`);
  }
  lines.push(`exports   ${live - lost.length}/${live} imported-and-exported names present (${dead} exported but unused, tree-shaken)`);

  /* 3. THE SUBSYSTEM MARKERS — source first, then bundle. */
  let markers = 0;
  const stale = [], missing = [];
  for (const [subsystem, list] of Object.entries(MARKERS)) {
    for (const m of list) {
      markers++;
      if (!allSrc.includes(m)) stale.push(`${m} (${subsystem})`);
      else if (!js.includes(m)) missing.push(`${m} — ${subsystem}`);
    }
  }
  if (stale.length) {
    bad.push(`the marker table is STALE: ${stale.join(', ')} no longer exist in src/. Update MARKERS in tools/build.mjs — a marker that has been renamed away is not evidence of anything.`);
  }
  if (missing.length) {
    bad.push(`the bundle is missing ${missing.length} subsystem marker(s) the source has: ${missing.join('; ')}`);
  }
  lines.push(`markers   ${markers - stale.length - missing.length}/${markers} subsystem markers, ${Object.keys(MARKERS).length} subsystems`);

  /* 4. THE FLOORS AND THE SELF-CONTAINMENT. */
  const floor = Math.max(SIZE_FLOOR_BYTES, Math.round((srcBytes + vendorBytes) * SIZE_FLOOR_FRACTION));
  if (js.length < floor) {
    bad.push(`the bundle is ${js.length} bytes against a floor of ${floor} — ${(srcBytes + vendorBytes)} bytes of source and vendor cannot minify to that`);
  }
  lines.push(`size      ${(js.length / 1048576).toFixed(2)} MB of JS, floor ${(floor / 1048576).toFixed(2)} MB (${((srcBytes + vendorBytes) / 1048576).toFixed(2)} MB of source)`);

  const external = [
    ...html.matchAll(/<script[^>]+src="([^"]+)"/gi),
    ...html.matchAll(/<link[^>]+href="([^"]+\.(?:css|js))"/gi),
  ].map((m) => m[1]);
  if (external.length) {
    bad.push(`${external.length} external reference(s) left in the page — this build has to run from file:// with no server: ${external.join(', ')}`);
  }
  if (!html.includes('<script type="module">')) {
    bad.push('the inline module <script> is not in the page at all');
  }
  lines.push(`offline   ${external.length} external references, bundle inlined`);

  return { bad, lines, srcBytes, vendorBytes };
}

/* ------------------------------------------------------------
   THE COMMITTED COPY. Hard failure when the tree is clean, loud
   warning when it is not. See the header.
   ------------------------------------------------------------ */
function auditHEAD(fresh) {
  const git = (args, enc = 'utf8') => execFileSync('git', args, { cwd: ROOT, encoding: enc, maxBuffer: 64 * 1024 * 1024 });
  let head;
  try {
    head = git(['show', 'HEAD:WALLY-RPG.html'], 'buffer').toString('utf8');
  } catch {
    return { kind: 'none', text: 'no WALLY-RPG.html in HEAD yet — nothing committed to go stale' };
  }
  if (head === fresh) return { kind: 'ok', text: `the committed copy matches this source tree (${head.length} bytes)` };

  const lacks = [];
  for (const list of Object.values(MARKERS)) for (const m of list) if (!head.includes(m)) lacks.push(m);
  let dirty = true;
  try { git(['diff', '--quiet', 'HEAD', '--', 'src', 'index.html']); dirty = false; } catch { dirty = true; }
  const text = `HEAD:WALLY-RPG.html is ${head.length} bytes against a fresh ${fresh.length}`
    + (lacks.length ? `, and lacks ${lacks.length} subsystem marker(s): ${lacks.slice(0, 8).join(', ')}${lacks.length > 8 ? ' …' : ''}` : '')
    + '. Commit the rebuilt bundle.';
  return { kind: dirty ? 'warn' : 'fail', text };
}

/* ============================================================
   RUN
   ============================================================ */
if (!CHECK) console.log(`bundling${DEV ? ' (dev)' : ''}…`);

const { js, metafile } = await bundleOnce();
const html = await assemble(js);
const { bad, lines } = await audit(html, js, metafile);

for (const l of lines) console.log('  ' + l);

if (bad.length) {
  console.error(`\nBUILD AUDIT FAILED — ${bad.length} problem(s). Nothing was written.\n`);
  for (const b of bad) console.error('  · ' + b);
  process.exit(1);
}

/* ---- --check: compare, do not write ---- */
if (CHECK) {
  let onDisk = null;
  try { onDisk = await readFile(OUT, 'utf8'); } catch {}
  if (onDisk === null) {
    console.error(`\nSTALE — ${OUT.replace(ROOT + '/', '')} does not exist. Run: node tools/build.mjs`);
    process.exit(1);
  }
  if (onDisk !== html) {
    let at = 0;
    while (at < onDisk.length && at < html.length && onDisk[at] === html[at]) at++;
    console.error(`\nSTALE DELIVERABLE — ${OUT.replace(ROOT + '/', '')} is not what this source tree builds.`);
    console.error(`  on disk ${onDisk.length} bytes, fresh ${html.length} bytes (${html.length - onDisk.length >= 0 ? '+' : ''}${html.length - onDisk.length})`);
    console.error(`  first difference at byte ${at}`);
    const lacks = [];
    for (const [sub, list] of Object.entries(MARKERS)) for (const m of list) if (!onDisk.includes(m)) lacks.push(`${m} — ${sub}`);
    if (lacks.length) console.error(`  the file on disk is missing ${lacks.length} subsystem marker(s): ${lacks.join('; ')}`);
    console.error('  Run: node tools/build.mjs');
    process.exit(1);
  }
  const headState = auditHEAD(html);
  console.log(`  fresh     ${OUT.replace(ROOT + '/', '')} is byte-identical to what this source tree builds`);
  if (headState.kind === 'fail') {
    console.error(`\nSTALE COMMITTED BUILD — the working tree is clean, so there is no excuse:\n  ${headState.text}`);
    process.exit(1);
  }
  if (headState.kind === 'warn') console.log(`  WARNING   ${headState.text}`);
  else console.log(`  committed ${headState.text}`);
  console.log('CHECK PASS — the deliverable is the game.');
  process.exit(0);
}

await writeFile(OUT, html);
const { size } = await stat(OUT);
console.log(`wrote ${OUT.replace(ROOT + '/', '')}  ${(size / 1048576).toFixed(2)} MB`);
const headState = auditHEAD(html);
if (headState.kind === 'warn') console.log(`  WARNING   ${headState.text}`);

/* ---- verify it actually boots from file:// ---- */
if (!VERIFY) process.exit(0);
console.log('verifying from file://…');
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--allow-file-access-from-files', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(pathToFileURL(OUT).href, { waitUntil: 'load', timeout: 60000 });
const ready = await page
  .waitForFunction('window.__WALLY_READY__ === true', { timeout: 45000 })
  .then(() => true)
  .catch(() => false);
await page.waitForTimeout(2500);
await page.screenshot({ path: resolve(ROOT, 'shots/build-verify.png'), animations: 'allow', timeout: 20000 });
const perf = await page.evaluate(() => window.__WALLY_PERF__ || null).catch(() => null);

/* THE FEATURE, REACHED IN THE FILE:// BUILD ITSELF. The audit proves
   the bytes are there; this proves they run. A bundle can contain every
   marker and still ship a balloon nothing can board — which is exactly
   the failure this whole file exists to make impossible.

   IT NEEDS ?shot=1 AND THE LOAD ABOVE MUST NOT HAVE IT. The first load
   is the page a person actually double-clicks: title card, intro, the
   lot, and that is what the screenshot and the error check are of. But
   the intro owns the frame while it plays, so a balloon boarded
   underneath it sits in its boarding phase for ever and the probe would
   report a build failure about a game that is fine. So the real page is
   shot first, and then the same file is reloaded with the flag every
   tool in tools/ already uses. */
if (ready) {
  await page.goto(pathToFileURL(OUT).href + '?shot=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__WALLY_READY__ === true', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
const balloon = ready ? await page.evaluate(async () => {
  try {
    WALLY.ctx.game.actions.grantRide('balloon');
    WALLY.debug.balloon();
    /* WAIT FOR THE ENVELOPE TO BE UP BEFORE ASKING FOR AN ALTITUDE.
       flyUpdate holds the machine on its skids for the whole inflation,
       so an altitude written during the boarding is put back on the
       grass on the very next frame — and the verify then reports a
       balloon standing in a field as a build failure. */
    for (let i = 0; i < 900 && WALLY.debug.balloonInfo().phase !== 'aloft'; i++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    WALLY.debug.balloon({ alt: 60 });
    /* the fly camera is damped and eases out over about a second and a
       half; a screenshot taken before it settles is of the sky */
    for (let i = 0; i < 150; i++) await new Promise((r) => requestAnimationFrame(r));
    const s = WALLY.debug.balloonInfo();
    /* counted the way tools/test-balloon.mjs B1 counts them: off the
       prop's own group, with the outline hulls told apart by the flag
       the §2.2 pass sets rather than by their names */
    const p = WALLY.ctx.wally.rideProps.balloon;
    let env = 0, hulls = 0, inScene = false;
    p.group.traverse((o) => {
      if (o.userData.isOutlineHull) hulls++;
      else if (o.name === 'balloon.envelope') env++;
    });
    WALLY.ctx.scene.traverse((o) => { if (o === p.group) inScene = true; });
    return { ok: env > 0 && hulls > 0 && s.phase === 'aloft' && s.alt > 30 && s.inflate > 0.9,
      alt: s.alt, phase: s.phase, envelope: env, hulls, inScene, inflation: s.inflate };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}).catch((e) => ({ ok: false, error: String(e) })) : { ok: false, error: 'never booted' };
if (balloon.ok) {
  await page.screenshot({ path: resolve(ROOT, 'shots/build-verify-balloon.png'), animations: 'allow', timeout: 20000 })
    .catch(() => {});
}
await browser.close();

const real = errors.filter(e => !/favicon|status of 404/i.test(e));
if (!ready || real.length) {
  console.error(`\nBUILD VERIFY FAILED — ready=${ready}`);
  real.slice(0, 12).forEach(e => console.error('  ' + e.slice(0, 220)));
  process.exit(1);
}
if (!balloon.ok) {
  console.error('\nBUILD VERIFY FAILED — the balloon is not reachable in the standalone build');
  console.error('  ' + JSON.stringify(balloon));
  process.exit(1);
}
console.log(`verified: boots clean from file://${perf ? `, ${perf.fps} fps, ${perf.calls} draw calls, ${perf.tris} tris` : ''}`);
console.log(`verified: the balloon is boardable from file:// — envelope in the scene, ${balloon.alt} m up, phase ${balloon.phase}`);
console.log('screenshots: shots/build-verify.png (the page as it opens), shots/build-verify-balloon.png (the balloon, in the standalone build)');
