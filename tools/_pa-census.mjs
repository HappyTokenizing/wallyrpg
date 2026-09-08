#!/usr/bin/env node
/* ============================================================
   _pa-census.mjs — THE PLACEMENT CENSUS, working copy.

   Everything the city PLACES, measured against the thing that is
   supposed to hold it up, and against the kind of place its own kind
   belongs in. Reported by CAUSE: one wrong rule repeats across every
   instance that uses it, so a list of 114 objects is a list of seven
   faults.

   Four questions, each with its own frame:

   A  KIT PARTS, IN THE BUILDING'S OWN FRAME. cliptest.mjs already asks
      "does every part touch another part". That passes for a shelf on
      two brackets hanging in the street, because the three of them
      touch each other. The question is CONNECTEDNESS: a building is
      one object, so every part must reach the building's main mass.

   B  PROPS, AGAINST THE DRAWN FLOOR. Raycast, not floorY() — floorY is
      the rule placement used and asking it would be the measurement
      agreeing with itself.

   C  PROPS, AGAINST THEIR OWN KIND OF PLACE. A lobster pot inland.

   D  GROUND FURNITURE, against the thing it is furniture FOR: a gully
      at a kerb, a manhole in a carriageway, a sill on a boundary.
   ============================================================ */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (rq, rs) => {
  const c = decodeURIComponent(rq.url.split('?')[0]);
  try {
    const b = await readFile(join(ROOT, c === '/' ? 'index.html' : c));
    rs.writeHead(200, { 'content-type': MIME[extname(c)] || 'application/octet-stream' }); rs.end(b);
  } catch { rs.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
let pageErr = null;
page.on('pageerror', (e) => { pageErr = e.message.split('\n')[0]; });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?skipIntro&partcensus`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction('window.__WALLY_READY__===true', null, { timeout: 180000 });
await page.waitForTimeout(4000);
console.log('# rig: headless Chrome (channel chrome), SwiftShader, 960x540, load ' +
  execSync('uptime').toString().split('load averages:')[1].trim());

const out = await page.evaluate(() => {
  const c = window.WALLY.ctx, T = window.WALLY.THREE;
  const R = {};

  /* ---------------- A. islands in a building ---------------- */
  const TOL = 0.02;
  {
    const cen = c.city.partCensus();
    const islands = [];
    let total = 0, buildings = 0;
    for (const b of cen) {
      const p = b.parts; total += p.length; buildings++;
      const par = p.map((_, i) => i);
      const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      const uni = (a2, b2) => { const x = find(a2), y = find(b2); if (x !== y) par[x] = y; };
      for (let i = 0; i < p.length; i++) {
        for (let j = i + 1; j < p.length; j++) {
          const a = p[i], o = p[j];
          const gx = Math.max(a.min[0] - o.max[0], o.min[0] - a.max[0], 0);
          const gy = Math.max(a.min[1] - o.max[1], o.min[1] - a.max[1], 0);
          const gz = Math.max(a.min[2] - o.max[2], o.min[2] - a.max[2], 0);
          if (Math.hypot(gx, gy, gz) <= TOL) uni(i, j);
        }
      }
      const size = new Map();
      for (let i = 0; i < p.length; i++) { const r = find(i); size.set(r, (size.get(r) || 0) + 1); }
      let main = -1, best = -1;
      for (const [r, n] of size) if (n > best) { best = n; main = r; }
      const groups = new Map();
      for (let i = 0; i < p.length; i++) {
        const r = find(i); if (r === main) continue;
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(i);
      }
      const m = new T.Matrix4().fromArray(b.matrix), v = new T.Vector3();
      for (const [, idxs] of groups) {
        let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
        for (const i of idxs) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i].min[k]); hi[k] = Math.max(hi[k], p[i].max[k]); }
        /* how far this island is from the nearest part of the mass */
        let gap = Infinity;
        for (let j = 0; j < p.length; j++) {
          if (find(j) !== main) continue;
          const o = p[j];
          const gx = Math.max(lo[0] - o.max[0], o.min[0] - hi[0], 0);
          const gy = Math.max(lo[1] - o.max[1], o.min[1] - hi[1], 0);
          const gz = Math.max(lo[2] - o.max[2], o.min[2] - hi[2], 0);
          gap = Math.min(gap, Math.hypot(gx, gy, gz));
        }
        v.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2).applyMatrix4(m);
        islands.push({
          id: b.id, kind: b.kind, n: idxs.length,
          parts: [...new Set(idxs.map((i) => p[i].part))].join('+'),
          gap: +gap.toFixed(3),
          size: [+(hi[0] - lo[0]).toFixed(2), +(hi[1] - lo[1]).toFixed(2), +(hi[2] - lo[2]).toFixed(2)],
          local: [+((lo[0] + hi[0]) / 2).toFixed(2), +((lo[1] + hi[1]) / 2).toFixed(2), +((lo[2] + hi[2]) / 2).toFixed(2)],
          at: [+v.x.toFixed(1), +v.y.toFixed(2), +v.z.toFixed(1)],
        });
      }
    }
    R.A = { buildings, total, islands };
  }

  /* ---------------- the drawn floor, by ray ---------------- */
  const SKIP = /outline|hull|contactShadow|cloth|drift|grass|\blip\b|foliage|detail|bush|reed|\bwater\b|sky|cloud|prop\./i;
  const targets = [];
  for (const r of [c.world.groundGroup, c.city.root].filter(Boolean)) {
    r.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      if (o.userData.isOutlineHull || o.userData.noPrepass) return;
      if (SKIP.test(o.name || '')) return;
      targets.push(o);
    });
  }
  /* PIN THE TILE UNDER THE PROBE TO LOD 0, OR THE CENSUS MEASURES THE
     LOD AND NOT THE PLACEMENT.

     terrain.js draws four levels and a coarse tile box-filters the
     raster, so the drawn ground 300 m from the camera stands up to a
     metre off the heightfield everything was placed on. The first run
     of this reported 47 % of the city's lamp posts floating or sunk,
     with every example on a `terrain.N.M` tile far from the spawn —
     which is the LOD, not the lamp. surfacetest.mjs never sees this
     because it WALKS, and the tile under his feet is always level 0.

     There is no walk here, so the LOD is driven directly: before each
     probe the tile under it is brought to level 0 with the module's own
     updateLOD(), and processPending is drained so the geometry is
     actually swapped in rather than queued. Cheap because the props are
     sorted first — one LOD pass per 40 m of island, not per prop. */
  const terrain = c.world.terrain;
  const _fake = new T.Vector3();
  const fakeCam = { getWorldPosition(v) { return v.copy(_fake); } };
  let lodAt = null;
  function pinLOD(x, z) {
    if (lodAt && Math.hypot(x - lodAt[0], z - lodAt[1]) < 40) return;
    _fake.set(x, 40, z);
    terrain.updateLOD(fakeCam);
    for (let k = 0; k < 400; k++) terrain.processPending(64);
    terrain.updateLOD(fakeCam);
    for (let k = 0; k < 400; k++) terrain.processPending(64);
    lodAt = [x, z];
  }

  /* THE FIRST THING A DOWNWARD RAY MEETS IS NOT THE FLOOR, AND THAT
     MISTAKE WAS THE BIGGEST ROW IN SECTION B.

     The ray starts 1.2 m above the prop so that a prop sunk in the
     ground still finds the surface it is sunk into. That headroom is
     also where a building keeps its projections: a window sill, a
     string course, a plinth nosing, a canopy, a balcony. Those all face
     UP, so no amount of normal-testing removes them; they are simply
     the wrong surface. Measured on the four worst instances B2 named:

       gasbottle -398.7,175.1   rustyrow.infill0.wall  +0.307 m
                                rustyrow.infill0.skirt +0.000 m  <- floor
       oildrum     26.5,-160.1  mineral.wall           +0.524 m
                                ground.zone:ironhills  -0.050 m  <- floor

     The bottle is standing exactly on its berm skirt and the drum is
     5 cm over the footway. Both were reported as a third and a half a
     metre of SINK, and between them and their kind they are the whole
     of B2's "building mesh: wall" row — 18 instances, worst -1.121 m,
     with no placement fault anywhere behind it.

     So: gather every UPWARD-facing hit and take the one NEAREST THE
     PROP'S OWN BASE. That is what "the floor under this thing" means,
     it needs no tolerance to tune, and it caps nothing — a prop
     genuinely sunk half a metre still has its pavement as the nearest
     surface and still reads -0.5. The normal goes through the world
     normal matrix, because a mesh under a rotated building group has a
     local normal that says nothing, and 0.2 is the cut because a kerb
     face at 40 degrees is still something a prop can stand on. It also
     drops the BACK faces of the founding berms, which city.js emits
     double-wound on purpose (its "AND THEN STOP GUESSING" note) and
     which answer a downward ray twice at the same height.

     `lastSkipped` names what was standing over the prop, so an overhang
     appears in the report as context instead of as a defect. */
  const ray = new T.Raycaster(); const DOWN = new T.Vector3(0, -1, 0); const O = new T.Vector3();
  const _n3 = new T.Matrix3(), _nv = new T.Vector3();
  let lastHit = '', lastSkipped = '';
  function floorRay(x, y, z) {
    pinLOD(x, z);
    O.set(x, y + 1.2, z); ray.set(O, DOWN); ray.far = 8;
    const h = ray.intersectObjects(targets, false);
    lastHit = ''; lastSkipped = '';
    let best = null, bd = Infinity;
    const ups = [];
    for (const it of h) {
      if (!it.face) continue;
      _n3.getNormalMatrix(it.object.matrixWorld);
      _nv.copy(it.face.normal).applyMatrix3(_n3).normalize();
      if (_nv.y <= 0.2) continue;
      ups.push(it);
      const d = Math.abs(it.point.y - y);
      if (d < bd) { bd = d; best = it; }
    }
    if (!best) return null;
    lastHit = best.object.name || '?';
    /* anything up-facing standing over the floor we chose: that is a
       building projection, and the reason this prop used to read sunk */
    for (const it of ups) {
      if (it.point.y > best.point.y + 0.2) {
        lastSkipped = (it.object.name || '?') + '@+' + (it.point.y - y).toFixed(2);
        break;
      }
    }
    return best.point.y;
  }

  /* ---------------- B + C. props ---------------- */
  {
    const AIR = new Set(['strung']);
    const insts = [];
    c.scene.getObjectByName('city.propsRoot').traverse((o) => {
      if (!o.isInstancedMesh) return;
      const n = o.name || '';
      if (/\.outline$/.test(n)) return;
      const m = /^prop\.([a-z]+)\./.exec(n);
      if (!m) return;
      const type = m[1];
      if (AIR.has(type)) return;
      /* THE CELL GROUP HAS A TRANSFORM. Prop meshes are bucketed per
         cell (`@-1,0` in the name) and the instance matrix is in the
         cell's frame, so decomposing it raw put every prop in the
         wrong place — the first run of this reported a 4.9 m floating
         container that does not exist. */
      o.updateWorldMatrix(true, false);
      const mat = new T.Matrix4(), p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, mat); mat.premultiply(o.matrixWorld); mat.decompose(p, q, s);
        insts.push({ type, x: p.x, y: p.y, z: p.z });
      }
    });
    /* one entry per instance, not per material family: a prop is drawn
       once per family it uses and each family carries the SAME matrix */
    const seen = new Set(); const uniq = [];
    for (const it of insts) {
      const k = it.type + '|' + it.x.toFixed(3) + '|' + it.y.toFixed(3) + '|' + it.z.toFixed(3);
      if (seen.has(k)) continue; seen.add(k); uniq.push(it);
    }
    uniq.sort((a, b) => (Math.round(a.x / 40) - Math.round(b.x / 40)) || (a.z - b.z));

    /* THE EXCLUSIONS BELONG TO SECTION B, NOT ONLY TO B2.

       A CENSUS WHOSE BIGGEST ROW IS AN ARTEFACT TEACHES EVERYONE TO
       IGNORE THE CENSUS. Both caveats were true and both were printed
       eighty lines below the numbers they invalidate, so B's per-type
       "worst float" and "worst sink" went on quoting a stacked pallet
       and a prop under a balcony as the two worst placements in the
       game. They are computed here now, before the counting, and the
       excluded instances are reported as their own line rather than
       vanishing — an artefact you cannot see is the next census's
       mystery.

       STACKED: city.js stacks props on purpose (`p.stack`). Props are
       excluded from the ray targets, or they would shadow the floor for
       everything beside them, so the upper of a stacked pair reads as
       daylight. Anything with another instance under it and within
       1.2 m in plan is a stack. Only applied to FLOATS over 0.15 m: a
       bin 8 cm off the flags beside a crate is not standing on it. */
    for (let i = 0; i < uniq.length; i++) {
      const p = uniq[i];
      p.stack = false;
      for (let j = 0; j < uniq.length; j++) {
        if (i === j) continue;
        const q2 = uniq[j];
        if (Math.abs(q2.x - p.x) > 1.2 || Math.abs(q2.z - p.z) > 1.2) continue;
        if (q2.y < p.y - 0.15) { p.stack = true; break; }
      }
    }

    const byType = {};
    for (const it of uniq) {
      const fy = floorRay(it.x, it.y, it.z);
      const on = lastHit, over = lastSkipped;
      const t = (byType[it.type] ||= { n: 0, float: [], sink: [], worstF: 0, worstS: 0, ctx: [], stacked: 0, under: 0 });
      t.n++;
      const fl = c.city.floorY(it.x, it.z);
      it.on = on; it.fy = fy; it.fl = fl; it.over = over;
      it.d = fy == null ? null : +(it.y - fy).toFixed(3);
      it.dRule = +(it.y - fl).toFixed(3);
      if (over) t.under++;
      if (fy != null) {
        const d = it.y - fy;           // >0 floats over the floor, <0 sunk in
        t.all = (t.all || []); t.all.push(+d.toFixed(3));
        /* a prop standing on another prop is not floating */
        if (d > 0.15 && it.stack) { t.stacked++; }
        else if (d > 0.06) { t.float.push({ d: +d.toFixed(3), at: [+it.x.toFixed(1), +it.z.toFixed(1)], on }); if (d > t.worstF) t.worstF = +d.toFixed(3); }
        else if (d < -0.06) { t.sink.push({ d: +d.toFixed(3), at: [+it.x.toFixed(1), +it.z.toFixed(1)], on }); if (d < t.worstS) t.worstS = +d.toFixed(3); }
      } else t.ctx.push({ why: 'no floor under it', at: [+it.x.toFixed(1), +it.z.toFixed(1)] });
      it.shore = c.world.shoreDistAt(it.x, it.z);
      it.road = c.world.distanceToRoad(it.x, it.z);
      it.paved = c.city.pavedAt(it.x, it.z);
      it.zone = (c.world.zoneAt(it.x, it.z) || {}).id || String(c.world.zoneAt(it.x, it.z) || '-');
      it.beach = c.world.isBeach ? !!c.world.isBeach(it.x, it.z) : false;
    }
    R.B = { byType, uniq: uniq.length, raw: insts.length };
    R.props = uniq.map((u) => ({ type: u.type, x: +u.x.toFixed(1), z: +u.z.toFixed(1), y: +u.y.toFixed(2), shore: +u.shore.toFixed(1), road: +u.road.toFixed(1), paved: u.paved, zone: u.zone, beach: u.beach, on: u.on, over: u.over, stack: u.stack, d: u.d, dRule: u.dRule }));
  }

  /* ---------------- D. ground furniture ---------------- */
  {
    const g = c.city.groundStats || {};
    /* `c.world.paths.stats` is undefined — world.js republishes paths.js
       as {nodes, edges, at} and drops the stats. ctx.city.roadStats is
       the route that exists today; it says in `src` whether it read the
       module's own numbers or derived them. */
    R.D = { paths: c.city.roadStats, dest: { n: g.destPaths, tris: g.destTris, at: g.destAt },
      stats: { kerbMetres: g.kerbMetres, gullies: g.gullies, manholes: g.manholes, sills: g.sills, desirePaths: g.desirePaths, approaches: g.approaches } };
  }
  return R;
});

const money = (n) => String(n).padStart(4);
console.log('\n=== A. parts of a building that do not reach the building ===');
console.log(`   ${out.A.total} parts across ${out.A.buildings} buildings`);
const byCause = new Map();
for (const i of out.A.islands) {
  const k = `${i.kind}/${i.parts}/${i.n}`;
  if (!byCause.has(k)) byCause.set(k, []);
  byCause.get(k).push(i);
}
const causes = [...byCause.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [k, list] of causes) {
  const w = list.reduce((a, b) => Math.max(a, b.gap), 0);
  console.log(`   ${money(list.length)}  ${k.padEnd(46)} worst gap ${w.toFixed(3)} m   e.g. ${list[0].id} local ${list[0].local.join(',')} size ${list[0].size.join('x')}`);
}
console.log(`   TOTAL ${out.A.islands.length} islands, ${out.A.islands.reduce((a, b) => a + b.n, 0)} parts`);

console.log('\n=== B. props against the drawn floor ===');
const rows = Object.entries(out.B.byType).sort((a, b) => (b[1].float.length + b[1].sink.length) - (a[1].float.length + a[1].sink.length));
console.log(`   ${out.B.uniq} instances (${out.B.raw} draws)`);
for (const [t, v] of rows) {
  if (!v.float.length && !v.sink.length && !v.ctx.length) continue;
  const a = (v.all || []).slice().sort((x, y) => x - y);
  const med = a.length ? a[Math.floor(a.length / 2)] : 0;
  console.log(`   ${t.padEnd(12)} n=${money(v.n)}  float ${money(v.float.length)} (worst ${v.worstF})  sink ${money(v.sink.length)} (worst ${v.worstS})  median ${med.toFixed(3)}  noFloor ${v.ctx.length}` +
    `${v.stacked ? `  [${v.stacked} stacked, excluded]` : ''}${v.under ? `  [${v.under} under an overhang]` : ''}`);
  const ex = (v.float[0] || v.sink[0]);
  if (ex) console.log(`                 e.g. ${ex.d} m at ${ex.at.join(',')} on ${ex.on}`);
}
{
  const st = rows.reduce((a, [, v]) => a + v.stacked, 0);
  const un = rows.reduce((a, [, v]) => a + v.under, 0);
  console.log(`   EXCLUDED AS MEASUREMENT ARTEFACTS: ${st} props standing on another prop, ` +
    `${un} standing under an overhang whose soffit the ray now steps past. Neither is a placement fault.`);
}
const okTypes = rows.filter(([, v]) => !v.float.length && !v.sink.length && !v.ctx.length).map(([t]) => t);
console.log(`   clean: ${okTypes.join(' ') || '(none)'}`);

/* THE SAME DEFECTS, CUT BY THE SURFACE THE RAY LANDED ON — which is
   the CAUSE. A type-by-type list says twenty types are a bit wrong; a
   surface-by-surface list says which rule is wrong. */
console.log('\n=== B2. the same defects by the surface under them ===');
const cls = (n) => (!n ? 'nothing' : /^terrain\./.test(n) ? 'terrain (bare ground)'
  : /^ground\.desire/.test(n) ? 'ground.js desire path'
  : /^ground\.zone:/.test(n) ? 'ground.js footway'
    : /^road\.zone:/.test(n) ? 'road ribbon'
      : /\.skirt$/.test(n) ? 'building berm skirt'
        : /^city\./.test(n) ? 'city (berm/step/pad)' : 'building mesh: ' + n.split('.').pop());
/* ONE SET OF EXCLUSIONS, DECIDED ONCE, IN THE PAGE. This used to
   re-derive the stack test here, which meant section B and section B2
   could disagree about how many defects there are — and they did, by
   the whole of B's worst-float row. `p.stack` is now set beside the
   measurement itself and both sections read it. */
const stacked = out.props.filter((p) => p.stack && p.d != null && p.d > 0.15).length;
const bad = out.props.filter((p) => {
  if (p.d == null || Math.abs(p.d) <= 0.06) return false;
  if (p.d > 0.15 && p.stack) return false;
  return true;
});
const bys = {};
for (const p of bad) { const k = cls(p.on); (bys[k] ||= []).push(p); }
console.log(`   ${bad.length} of ${out.props.length} instances more than 0.06 m off the drawn floor (${stacked} stacked on another prop, excluded)`);
for (const [k, v] of Object.entries(bys).sort((a, b) => b[1].length - a[1].length)) {
  const s2 = v.map((p) => p.d).sort((a, b) => a - b);
  const types = {}; for (const p of v) types[p.type] = (types[p.type] || 0) + 1;
  const top = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => t + ':' + n).join(' ');
  /* does the RULE the placer used agree with the drawn floor here? */
  const ruleOff = v.filter((p) => Math.abs(p.dRule) > 0.06).length;
  console.log(`   ${String(v.length).padStart(4)}  ${k.padEnd(26)} worst ${s2[0]} .. ${s2[s2.length - 1]}   floorY() also off on ${ruleOff}/${v.length}`);
  console.log(`         ${top}`);
}

console.log('\n=== C. props against their own kind of place ===');
const P = out.props;
const cnt = (f) => P.filter(f).length;
const q = (a, f) => { const v = a.map(f).sort((x, y) => x - y); return v.length ? [v[0], v[Math.floor(v.length / 2)], v[v.length - 1]] : [0, 0, 0]; };
console.log('   type          n   shoreDist min/med/max   roadDist min/med/max   onPaved');
for (const t of [...new Set(P.map((p) => p.type))].sort()) {
  const g = P.filter((p) => p.type === t);
  const sh = q(g, (p) => p.shore), rd = q(g, (p) => p.road);
  const pv = g.filter((p) => p.paved).length;
  console.log(`   ${t.padEnd(12)} ${String(g.length).padStart(3)}   ${sh.map((n) => n.toFixed(0).padStart(4)).join(' ')}          ${rd.map((n) => n.toFixed(0).padStart(4)).join(' ')}        ${String(pv).padStart(3)}/${g.length}`);
}
const zoneTable = {};
for (const p of P) { (zoneTable[p.type] ||= {})[p.zone] = ((zoneTable[p.type] || {})[p.zone] || 0) + 1; }
console.log('   zone spread of the district-coded types:');
for (const t of ['hay', 'churn', 'trough', 'orecart', 'oildrum', 'tyres', 'cabledrum', 'topiary', 'urn', 'techplanter', 'lobsterpot', 'container'])
  if (zoneTable[t]) console.log(`     ${t.padEnd(12)} ${Object.entries(zoneTable[t]).map(([z, n]) => z + ':' + n).join('  ')}`);

console.log('\n=== D. ground furniture ===');
console.log('   ground: ' + JSON.stringify(out.D.stats));
console.log('   paths:  ' + JSON.stringify(out.D.paths));
console.log(`   tracks to destinations: ${out.D.dest.n}, ${out.D.dest.tris} tris`);
for (const d of out.D.dest.at || []) console.log(`     ${d}`);
if (pageErr) console.log('PAGEERROR', pageErr);
await browser.close(); server.close();
