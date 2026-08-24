/* _kb6-revert.mjs — THE REVERT CHECK FOR KB-3, as a script rather
   than as something an agent did once by hand.

   KB-3 in tools/touchtest.mjs asserts that the identifier `focus`
   appears in a member, computed or reflective position nowhere in
   src/ except src/ui/kbowner.js and two declared camera distances.
   A green assertion that cannot go red is decoration, and this
   project has shipped two of those. So: temporarily append an
   undeclared focus call to a file in src/ — deliberately one this
   agent does NOT own — in each of the five shapes that could hide
   one, and require the scan to FAIL every time.

   Two of the five (optional chaining and computed access) are the
   exact shapes that hid two call sites from four rounds of auditing.

     node tools/_kb6-revert.mjs

   Exits non-zero if any shape slips through, and restores the file
   whatever happens.  */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/* hud.js is owned by another agent, which is the point: the assertion
   has to cover files this round never touches. */
const VICTIM = join(ROOT, 'src/ui/hud.js');

const SHAPES = [
  ['a plain call',            'el.focus();'],
  ['optional chaining',       'el?.focus?.({ preventScroll: true });'],
  ['computed access',         "el['focus']();"],
  ['an alias capture',        'const zzf = el.focus; zzf.call(el);'],
  ['Reflect',                 "Reflect.get(el, 'focus').call(el);"],
];

/* run only the scanner half of touchtest, headlessly — it is pure
   node and needs no browser, which is why it can be run per shape */
function scan() {
  const src = execFileSync('node', ['-e', `
    const { readFileSync } = require('node:fs');
    const s = readFileSync(${JSON.stringify(join(ROOT, 'tools/touchtest.mjs'))}, 'utf8');
    const a = s.indexOf('function stripJs(src) {');
    const b = s.indexOf('/* ============================================================\\n   THE SHIFT-TAB THAT LANDED SOMEWHERE REAL');
    process.stdout.write(s.slice(a, b));
  `]).toString();
  const prog = "import { readFile } from 'node:fs/promises';\nimport { join } from 'node:path';\n"
    + `const ROOT = ${JSON.stringify(ROOT)};\nlet bad = 0;\n`
    + "const ok = (c, m, x) => { if (!c) { bad++; console.log('   ' + String(x).slice(0, 160)); } };\n"
    + src + "\nprocess.exit(bad ? 1 : 0);\n";
  try {
    execFileSync('node', ['--input-type=module', '-e', prog], { stdio: ['ignore', 'inherit', 'inherit'] });
    return 'PASS';
  } catch { return 'FAIL'; }
}

const original = await readFile(VICTIM, 'utf8');
let bad = 0;
try {
  console.log(`baseline (nothing added)        ${scan()}   <- must be PASS`);
  for (const [name, code] of SHAPES) {
    await writeFile(VICTIM, original
      + `\n/* temporary revert probe — _kb6-revert.mjs */\nexport function __kb6probe(el) { ${code} }\n`);
    const r = scan();
    if (r !== 'FAIL') bad++;
    console.log(`${name.padEnd(32)}${r}   <- must be FAIL`);
  }
} finally {
  await writeFile(VICTIM, original);
}
const restored = (await readFile(VICTIM, 'utf8')) === original;
console.log(`\n${VICTIM.slice(ROOT.length + 1)} restored byte-for-byte: ${restored}`);
console.log(`final scan                      ${scan()}   <- must be PASS`);
console.log(bad === 0 && restored
  ? '\nPASS — every shape that could hide a call site is caught'
  : `\nFAIL — ${bad} shape(s) slipped through the static enumeration`);
process.exit(bad === 0 && restored ? 0 : 1);
