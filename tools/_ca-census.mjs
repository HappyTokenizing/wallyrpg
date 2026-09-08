/* _ca-census.mjs — CANOPY AGENT. One page load, canopies OFF -> ON ->
   OFF, driven through ctx.foliage.trees.setCanopies(). Everything that
   matters is measured on both sides of that switch:

     the crown's fit against the drawn canopy mesh
     the walkable floor  (lowest world height any crown box reaches)
     the cost            (collision triangles, bodies, broadphase grid)
     on foot             (a capsule walked under real trees, ankles, lens)
     reversibility       (OFF must return the world to exactly OFF)
*/
import { boot } from './_ca-lib.mjs';

const { page, errs, close } = await boot({ settle: 5000 });
const J = (o) => JSON.stringify(o);

/* ---------------- 0. the world, with canopies off ---------------- */
const base = await page.evaluate(() => {
  const t = WALLY.ctx.foliage.trees, phys = WALLY.ctx.phys;
  return {
    trees: t.stats(), solidCount: t.solidCount, crownCount: t.crownCount,
    canopiesOn: t.canopiesOn,
    phys: { tris: phys.stats.triangles, bodies: phys.stats.bodies },
    grid: WALLY.debug.physGrid(),
    render: window.__WALLY_PERF__ ? { tris: window.__WALLY_PERF__.triangles, calls: window.__WALLY_PERF__.calls } : null,
  };
});
console.log('OFF  trees', J(base.trees));
console.log('OFF  solid', base.solidCount, 'crowns', base.crownCount, 'phys', J(base.phys));
console.log('OFF  grid ', J(base.grid));
console.log('OFF  render', J(base.render));

/* ---------------- 1. the crown table + the floor ---------------- */
const table = await page.evaluate(() => {
  const t = WALLY.ctx.foliage.trees;
  const rows = t.crownBoxes();
  const by = {};
  let worstFloor = Infinity, worstAt = null;
  for (const r of rows) {
    const k = (by[r.kind] ||= { n: 0, floor: [], top: [], rx: [], rz: [], h: [] });
    k.n++;
    /* THE LOWEST OF THE EIGHT WORLD CORNERS over the terrain under the
       trunk — not the centre, not the local base. The tilt is the whole
       reason this is measured at the corners. */
    const floor = r.lowOverBase, top = r.highOverBase;
    k.floor.push(floor); k.top.push(top);
    k.rx.push(r.local.rx * r.s); k.rz.push(r.local.rz * r.s); k.h.push(r.local.h * r.s);
    if (floor < worstFloor) { worstFloor = floor; worstAt = { kind: r.kind, x: +r.x.toFixed(1), z: +r.z.toFixed(1), s: +r.s.toFixed(2) }; }
  }
  const q = (a, p) => { a = a.slice().sort((x, y) => x - y); return +a[Math.floor(a.length * p)].toFixed(2); };
  const out = {};
  for (const [k, v] of Object.entries(by)) {
    out[k] = { n: v.n, floorMin: q(v.floor, 0), floorMed: q(v.floor, 0.5), topMed: q(v.top, 0.5), topMax: q(v.top, 0.99), boxH: q(v.h, 0.5), rx: q(v.rx, 0.5), rz: q(v.rz, 0.5), localBaseMed: q(rows.filter((r) => r.kind === k).map((r) => r.local.base), 0.5) };
  }
  /* AND THE OTHER DATUM, which is the one that is easy to get wrong.
     CANOPY_BASE is 2.90 m over the terrain UNDER THE TRUNK. A crown six
     metres wide hangs over ground that is not that terrain, and on a
     hillside the ground under its downhill edge is metres lower — which
     costs nothing while canopies exist only in flight, and would matter
     enormously to anyone who ever took the gate away. So: the clearance
     from each bottom corner to the terrain UNDER THAT CORNER. */
  const W = WALLY.ctx.world;
  let worstCorner = Infinity, cornerAt = null;
  const clears = [];
  for (const r of rows) {
    for (let i = 0; i < 4; i++) {
      const c4 = r.corners[i];
      const cl = c4[1] - W.heightAt(c4[0], c4[2]);
      clears.push(cl);
      if (cl < worstCorner) { worstCorner = cl; cornerAt = { kind: r.kind, x: +r.x.toFixed(1), z: +r.z.toFixed(1) }; }
    }
  }
  clears.sort((a, b) => a - b);
  return {
    out, worstFloor: +worstFloor.toFixed(3), worstAt, total: rows.length,
    corner: { worst: +worstCorner.toFixed(2), at: cornerAt, p01: +clears[Math.floor(clears.length * 0.01)].toFixed(2), med: +clears[Math.floor(clears.length * 0.5)].toFixed(2), under197: clears.filter((v) => v < 1.97).length, n: clears.length },
  };
});
console.log('\nCROWN TABLE (world metres over the terrain under the trunk)');
for (const [k, v] of Object.entries(table.out)) console.log('  ' + k.padEnd(10), J(v));
console.log('  LOWEST crown floor over its OWN trunk terrain:', table.worstFloor, 'm at', J(table.worstAt), '  (capsule 1.62 + step 0.35 = 1.97)');
console.log('  LOWEST bottom corner over the terrain UNDER THAT CORNER:', J(table.corner));

/* -------- 2. the fit: the box against the DRAWN canopy mesh -------- */
const fit = await page.evaluate(() => {
  /* the canopy part of each bucket is the mesh whose material is
     foliage.canopy.*; its geometry is the same merged canopy the crown
     was measured from, so every vertex can be tested against the box */
  const t = WALLY.ctx.foliage.trees;
  const rows = [];
  WALLY.ctx.scene.traverse((ob) => {
    if (!ob.isInstancedMesh || !/^tree\./.test(ob.name || '')) return;
    if (!/^foliage\.canopy/.test(ob.material?.name || '')) return;
    if (!/\.hi$/.test(ob.name)) return;
    const kind = ob.name.slice(5).replace(/\d.*$/, '');
    const g = ob.geometry, p = g.attributes.position;
    g.computeBoundingBox();
    const bb = g.boundingBox;
    /* rebuild the same crown this species registered */
    const c = {
      rx: (bb.max.x - bb.min.x) * 0.5 * 0.90, rz: (bb.max.z - bb.min.z) * 0.5 * 0.90,
      cx: (bb.max.x + bb.min.x) * 0.5, cz: (bb.max.z + bb.min.z) * 0.5,
      base: bb.min.y, top: bb.max.y,
    };
    let inside = 0, aboveFloorTotal = 0;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      aboveFloorTotal++;
      if (Math.abs(x - c.cx) <= c.rx && Math.abs(z - c.cz) <= c.rz && y >= c.base - 1e-4 && y <= c.top + 1e-4) inside++;
    }
    rows.push({
      mesh: ob.name, kind,
      verts: p.count, insidePct: +(100 * inside / aboveFloorTotal).toFixed(1),
      meshW: +(bb.max.x - bb.min.x).toFixed(2), meshD: +(bb.max.z - bb.min.z).toFixed(2),
      meshH: +(bb.max.y - bb.min.y).toFixed(2),
      boxW: +(c.rx * 2).toFixed(2), boxD: +(c.rz * 2).toFixed(2),
      meshMinY: +bb.min.y.toFixed(2), meshMaxY: +bb.max.y.toFixed(2),
    });
  });
  return rows;
});
console.log('\nFIT — the registered box against the drawn canopy geometry (local metres, hi LOD)');
for (const r of fit) console.log('  ' + r.mesh.padEnd(22), J(r));

/* ---------------- 3. THE ON-FOOT PROOF ----------------
   Per site: teleport the player there so the neighbourhood's collision
   actually streams in (a capsule walked through an unstreamed wood
   falls to y = -170 and its two runs agree with each other about
   nothing — the first cut of this rig did exactly that at 8 of 10
   sites), REFUSE the site if phys and the heightfield disagree, then
   walk a capsule through the trunk's own axis three times on one page
   load: canopies off, on, off. */
const sites = await page.evaluate(() => {
  const t = WALLY.ctx.foliage.trees;
  const rows = t.crownBoxes();
  const pick = [];
  for (const k of ['broadleaf', 'pine', 'palm', 'orchard', 'topiary']) {
    const of = rows.filter((r) => r.kind === k).sort((a, b) => b.s - a.s);
    if (of.length) pick.push(of[0], of[Math.floor(of.length / 2)]);
  }
  return pick.map((r) => ({ kind: r.kind, x: r.x, z: r.z, s: +r.s.toFixed(2), low: +r.lowOverBase.toFixed(2), high: +r.highOverBase.toFixed(2), rx: +r.local.rx.toFixed(2) }));
});

const walks = [];
for (const site of sites) {
  const r = await page.evaluate(async (s) => {
    const T3 = WALLY.THREE, phys = WALLY.ctx.phys, t = WALLY.ctx.foliage.trees, W = WALLY.ctx.world, w = WALLY.ctx.wally;
    /* stand him 2 m off the axis, on grass — ON the axis he lands on
       the tree's own 1.72 m trunk box and the numbers describe that */
    w.controller.teleport(new T3.Vector3(s.x + 2.2, W.heightAt(s.x + 2.2, s.z) + 1.0, s.z));
    await new Promise((r2) => setTimeout(r2, 1600));
    const gy = W.heightAt(s.x - 6, s.z);
    const g = phys.groundAt(s.x - 6, s.z);
    if (!g.hit || Math.abs(g.y - gy) > 1.0) return { reached: false, physY: +g.y.toFixed(2), landY: +gy.toFixed(2) };
    const run = () => {
      const c = phys.createController({ player: false });
      c.teleport(new T3.Vector3(s.x - 6, gy + 0.4, s.z));
      c.snapToGround(6);
      c.setInput({ x: 1, z: 0 });
      const p = [];
      /* 300 FIXED steps driven synchronously inside one evaluate, so no
         rAF can interleave and the three runs are the same experiment.
         simPosition, not position: phys.step() is what interpolates the
         one into the other, and it never runs inside an evaluate. */
      for (let i = 0; i < 300; i++) {
        c.step(1 / 60);
        if (i % 15 === 0) p.push([+c.simPosition.x.toFixed(4), +c.simPosition.y.toFixed(4), +c.simPosition.z.toFixed(4)]);
      }
      c.dispose();
      return p;
    };
    const v = new T3.Vector3();
    const body = () => {
      const p = w.root.position, ge = W.heightAt(p.x, p.z);
      const foot = (n) => { const o = w.root.getObjectByName(n); o.getWorldPosition(v); return +(v.y - ge).toFixed(3); };
      return { footL: foot('footL'), footR: foot('footR'), ground: +(phys.groundAt(p.x, p.z).y - ge).toFixed(3), cam: +(WALLY.ctx.camera.position.y - ge).toFixed(3) };
    };
    const A = run();
    const bodyA = body();
    t.setCanopies(true);
    await new Promise((r2) => setTimeout(r2, 1200));
    const B = run(), bodyB = body();
    t.setCanopies(false);
    await new Promise((r2) => setTimeout(r2, 1200));
    const C = run(), bodyC = body();
    const dev = (a, b) => { let w2 = 0; for (let i = 0; i < a.length; i++) { const d = Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1], a[i][2] - b[i][2]); if (d > w2) w2 = d; } return +w2.toFixed(6); };
    return {
      reached: true, moved: +Math.hypot(A[A.length - 1][0] - A[0][0], A[A.length - 1][2] - A[0][2]).toFixed(2),
      dropped: +(A[0][1] - A[A.length - 1][1]).toFixed(2),
      devOn: dev(A, B), devBack: dev(A, C), bodyA, bodyB, bodyC,
    };
  }, site);
  walks.push({ site, ...r });
  console.log('  ' + site.kind.padEnd(10) + ' s=' + site.s + ' crown ' + site.low + '-' + site.high + ' m  ' +
    (r.reached ? ('walked ' + r.moved + ' m, fell ' + r.dropped + ' m | path dev on ' + r.devOn + ' m, back ' + r.devBack +
      ' m | ankles ' + r.bodyA.footL + '/' + r.bodyB.footL + '/' + r.bodyC.footL +
      '  lens ' + r.bodyA.cam + '/' + r.bodyB.cam + '/' + r.bodyC.cam)
      : ('UNREACHED — phys says ' + r.physY + ', heightfield says ' + r.landY + ' (this site is not streamed in; it proves nothing and is not counted)')));
}
console.log('\nON-FOOT  sites reached ' + walks.filter((w) => w.reached).length + ' of ' + walks.length +
  '  worst path deviation with crowns registered ' + Math.max(...walks.filter((w) => w.reached).map((w) => w.devOn)).toFixed(6) + ' m');

/* ---------------- 4/5. THE COST, MEASURED ACROSS THE SWITCH ITSELF.
   Not against the boot reading: ten teleports streamed 250 000 more
   collision triangles into the world between then and now, and a delta
   taken against boot would have charged every one of them to the
   canopies. Before, on, off, all inside one evaluate, so nothing can
   stream in between the three readings. */
const cost = await page.evaluate(() => {
  const t = WALLY.ctx.foliage.trees, phys = WALLY.ctx.phys;
  const snap = () => ({ tris: phys.stats.triangles, bodies: phys.stats.bodies, ...WALLY.debug.physGrid() });
  const before = snap();
  const t0 = performance.now();
  t.setCanopies(true);
  const onMs = performance.now() - t0;
  const on = snap(); const crowns = t.crownCount;
  const t1 = performance.now();
  t.setCanopies(false);
  const offMs = performance.now() - t1;
  const after = snap();
  return { before, on, after, crowns, onMs: +onMs.toFixed(1), offMs: +offMs.toFixed(1) };
});
const c = cost;
console.log('\nCOST  ' + c.crowns + ' crowns registered in ' + c.onMs + ' ms, dropped in ' + c.offMs + ' ms');
console.log('  collision tris ' + c.before.tris + ' -> ' + c.on.tris + '  (+' + (c.on.tris - c.before.tris) +
  ', ' + (100 * (c.on.tris - c.before.tris) / c.before.tris).toFixed(1) + '%)');
console.log('  bodies         ' + c.before.bodies + ' -> ' + c.on.bodies + ' -> ' + c.after.bodies);
console.log('  grid cells     ' + c.before.cells + ' -> ' + c.on.cells + ' -> ' + c.after.cells +
  '   meanList ' + c.before.meanList + ' -> ' + c.on.meanList + ' -> ' + c.after.meanList +
  '   worstList ' + c.before.worstList + ' -> ' + c.on.worstList + ' -> ' + c.after.worstList);
console.log('  capsule broadphase (the list every player query walks) ' +
  c.before.capsuleTris + ' -> ' + c.on.capsuleTris + ' -> ' + c.after.capsuleTris + ' triangles in ' + c.on.capsuleCells + ' cells');
console.log('  REVERSIBLE  bodies ' + (c.after.bodies === c.before.bodies) + '  cells ' + (c.after.cells === c.before.cells) +
  '  meanList ' + (c.after.meanList === c.before.meanList) + '  triangle SLOTS ' + (c.after.tris === c.before.tris) +
  ' (collision.js remove() clears alive[] and the grid but never gives the slots back)');

/* ------- 7. the character himself, under a real crown, A/B ------- */
const feet = await page.evaluate(async () => {
  const T3 = WALLY.THREE, t = WALLY.ctx.foliage.trees, w = WALLY.ctx.wally, phys = WALLY.ctx.phys, cam = WALLY.ctx.camera, W = WALLY.ctx.world;
  /* the biggest broadleaf on the island: the worst case for a crown
     over a walkable circle of grass */
  const tree = t.crownBoxes().filter((r) => r.kind === 'broadleaf').sort((a, b) => b.s - a.s)[0];
  const gy = W.heightAt(tree.x, tree.z);
  w.controller.teleport(new T3.Vector3(tree.x, gy + 1.2, tree.z));
  await new Promise((r) => setTimeout(r, 1400));
  const v = new T3.Vector3();
  const read = () => {
    const p = w.root.position, g = W.heightAt(p.x, p.z);
    const foot = (n) => { const o = w.root.getObjectByName(n); o.getWorldPosition(v); return +(v.y - g).toFixed(3); };
    return {
      footL: foot('footL'), footR: foot('footR'),
      ground: +(phys.groundAt(p.x, p.z).y - g).toFixed(3),
      cam: +(cam.position.y - g).toFixed(3),
      d: +Math.hypot(p.x - tree.x, p.z - tree.z).toFixed(2),
    };
  };
  const A = read();
  t.setCanopies(true);
  await new Promise((r) => setTimeout(r, 1400));
  const B = read();
  t.setCanopies(false);
  await new Promise((r) => setTimeout(r, 1400));
  const C = read();
  return { tree: { x: +tree.x.toFixed(1), z: +tree.z.toFixed(1), s: +tree.s.toFixed(2), low: +tree.lowOverBase.toFixed(2), high: +tree.highOverBase.toFixed(2) }, A, B, C };
});
console.log('\nUNDER A REAL CROWN  (biggest broadleaf ' + J(feet.tree) + ')');
console.log('  canopies OFF (ships on foot) ', J(feet.A));
console.log('  canopies ON  (the ungated fix)', J(feet.B));
console.log('  canopies OFF again           ', J(feet.C));

/* ------- 8. churn: phys never reclaims a removed body's slots ------- */
const churn = await page.evaluate(() => {
  const t = WALLY.ctx.foliage.trees, phys = WALLY.ctx.phys;
  const seq = [phys.stats.triangles];
  for (let i = 0; i < 5; i++) { t.setCanopies(true); t.setCanopies(false); seq.push(phys.stats.triangles); }
  return { seq, bodies: phys.stats.bodies, cells: WALLY.debug.physGrid().cells };
});
console.log('\nCHURN  triangles after each mount/dismount cycle', J(churn.seq),
  ' bodies back to', churn.bodies, ' cells', churn.cells);

if (errs.length) console.log('\nERRORS', errs.slice(0, 8));
await close();
