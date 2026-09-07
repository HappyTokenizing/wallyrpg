/* THE CITY. Every shipping container that is actually DRAWN, measured
   against the only port on the island, against the waterline, and against
   whatever is under it. Plus the Docks stacks specifically. */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const OUT = join(ROOT,'shots/j2/city'); await mkdir(OUT,{recursive:true});
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1600, height:900 }, settle:6000 });

const r = await page.evaluate(() => {
  const T = WALLY.THREE, scene = WALLY.ctx.scene, world = WALLY.ctx.world;
  /* every drawn container instance, from the instanced prop meshes */
  const boxes = [];
  const m = new T.Matrix4(), p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3();
  scene.traverse(o => {
    if (!o.isInstancedMesh) return;
    if (!/container/i.test(o.name || '')) return;
    o.updateWorldMatrix(true, false);
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m); m.premultiply(o.matrixWorld); m.decompose(p, q, s);
      if (!Number.isFinite(p.x)) continue;
      if (s.x < 1e-3) continue;                       // a retired instance
      boxes.push({ mesh: o.name, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
        yaw: +new T.Euler().setFromQuaternion(q).y.toFixed(3) });
    }
  });
  /* also any non-instanced ones */
  scene.traverse(o => { if (o.isMesh && !o.isInstancedMesh && /^prop\.container/.test(o.name||'')) {
    o.getWorldPosition(p); boxes.push({ mesh:o.name, x:+p.x.toFixed(2), y:+p.y.toFixed(2), z:+p.z.toFixed(2), single:true }); } });

  /* the places, from the game's own data */
  const places = (WALLY.ctx.game?.data?.places || WALLY.ctx.data?.places || []).map(l =>
    ({ id: l.id, n: l.n, port: l.port === true, kit: l.kit, zone: l.z }));
  /* and where each one actually stands, from the city's own records */
  const spots = {};
  try { for (const rec of WALLY.debug.cityList()) spots[rec.id] = rec; } catch(e) {}
  /* the drawn shells give the world positions */
  const shells = [];
  scene.traverse(o => { if (o.userData && o.userData.locId) {
    o.getWorldPosition(p); shells.push({ id:o.userData.locId, x:+p.x.toFixed(1), z:+p.z.toFixed(1) }); } });
  return { boxes, places, shells, nBoxes: boxes.length };
});
console.log('containers drawn:', r.nBoxes, ' places:', r.places.length, ' shells:', r.shells.length);
console.log('ports:', JSON.stringify(r.places.filter(p=>p.port)));

/* where do the named places stand in world metres? ask the game */
const where = await page.evaluate((ids) => {
  const out = {};
  for (const id of ids) {
    try { const f = WALLY.debug.findPlace ? WALLY.debug.findPlace(id) : null; if (f) out[id] = f; } catch(e) {}
  }
  return out;
}, r.places.map(p=>p.id));
console.log('findPlace sample:', JSON.stringify(Object.entries(where).slice(0,3)));
await writeFile(join(OUT,'raw.json'), JSON.stringify({ ...r, where }, null, 1));
await close();
console.log(JSON.stringify({ errors: errors.slice(0,4) }));
