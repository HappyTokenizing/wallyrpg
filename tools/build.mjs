#!/usr/bin/env node
/* ============================================================
   build.mjs — produce the standalone, double-clickable build.

   Bundles every ES module (including the vendored three.js) into a
   single inline <script type="module"> inside one HTML file. Inline
   module scripts have no fetches, so the result runs from file://
   with no server, no build step and no network — which is the whole
   promise of the original game, kept.

     node tools/build.mjs            -> WALLY-RPG.html   (minified)
     node tools/build.mjs --dev      -> WALLY-RPG.html   (readable, sourcemap)

   Verifies the output actually boots before declaring success.
   ============================================================ */

import { build } from 'esbuild';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV = process.argv.includes('--dev');
const OUT = resolve(ROOT, process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'WALLY-RPG.html');

console.log(`bundling${DEV ? ' (dev)' : ''}…`);

const result = await build({
  entryPoints: [resolve(ROOT, 'src/main.js')],
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'firefox110', 'safari16'],
  // Granular rather than `minify: true`. esbuild's SYNTAX pass merges
  // adjacent template-literal concatenations, and the SVG builders in
  // src/ui and src/intro concatenate dozens of them — the merge mangles
  // ${...} into literal text and the page dies with "Expected length, ${p}".
  // Identifier renaming breaks it the same way. Whitespace-only is safe
  // and still gets most of the size win.
  minifyWhitespace: !DEV,
  minifyIdentifiers: false,
  minifySyntax: false,
  sourcemap: DEV ? 'inline' : false,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
  loader: { '.glsl': 'text', '.png': 'dataurl', '.webp': 'dataurl' },
  define: { 'process.env.NODE_ENV': DEV ? '"development"' : '"production"' },
});

const js = result.outputFiles[0].text;

/* Take the dev shell verbatim and swap the module <script> for the bundle,
   so the two builds can never drift apart. */
const shell = await readFile(resolve(ROOT, 'index.html'), 'utf8');
const tag = /<script type="module"[^>]*src="[^"]*"\s*><\/script>/;
if (!tag.test(shell)) {
  console.error('build: could not find the module <script src> tag in index.html');
  process.exit(1);
}

const html = shell
  .replace(
    /<title>.*?<\/title>/,
    '<title>WALLY RPG</title>'
  )
  .replace(
    tag,
    // </script> inside a string literal would close the tag early.
    `<script type="module">\n${js.replace(/<\/script>/gi, '<\\/script>')}\n</script>`
  );

await writeFile(OUT, html);
const { size } = await stat(OUT);
console.log(`wrote ${OUT.replace(ROOT + '/', '')}  ${(size / 1048576).toFixed(2)} MB`);

/* ---- verify it actually boots from file:// ---- */
console.log('verifying from file://…');
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
await browser.close();

const real = errors.filter(e => !/favicon|status of 404/i.test(e));
if (!ready || real.length) {
  console.error(`\nBUILD VERIFY FAILED — ready=${ready}`);
  real.slice(0, 12).forEach(e => console.error('  ' + e.slice(0, 220)));
  process.exit(1);
}
console.log(`verified: boots clean from file://${perf ? `, ${perf.fps} fps, ${perf.calls} draw calls, ${perf.tris} tris` : ''}`);
console.log('screenshot: shots/build-verify.png');
