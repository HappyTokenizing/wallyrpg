/* THE CITY, measured. Every DRAWN container against the one port; the
   residential pier; and what is under each box. */
import { boot, ROOT } from './lib.mjs';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const OUT = join(ROOT,'shots/j2/city'); await mkdir(OUT,{recursive:true});
const { page, errors, close } = await boot({ query:'skipIntro&shot=1',
  viewport:{ width:1600, height:900 }, settle:6000 });

const r = await page.evaluate(() => {
  const c = WALLY.ctx, T = WALLY.THREE;
  WALLY.debug.cityLOD('near');
  const locs = [];
  for (const [id, rec] of c.city.locations)
    locs.push({ id, n: rec.loc.n, kit: rec.kit, formKit: rec.loc.kit, port: rec.loc.port === true,
      zone: rec.loc.z, x: +rec.loc.world.x.toFixed(1), z: +rec.loc.world.z.toFixed(1),
      shore: +c.world.shoreDistAt(rec.loc.world.x, rec.loc.world.z).toFixed(1) });
  const ports = locs.filter(l => l.port);
  const piers = locs.filter(l => l.kit === 'pier');

  /* the drawn ground, for the ray under each box */
  const SKIP=/outline|hull|contactShadow|cloth|drift|grass|\blip\b|foliage|detail|bush|reed|water|sky|cloud/i;
  const targets=[];
  for (const root of [c.world?.groundGroup, c.city?.root].filter(Boolean))
    root.traverse(o => { if(!(o.isMesh||o.isInstancedMesh))return;
      if(o.userData.isOutlineHull||o.userData.noPrepass)return; if(SKIP.test(o.name||''))return;
      for(let p=o;p;p=p.parent) if(p.visible===false) return; targets.push(o); });
  const ray = new T.Raycaster(); ray.far = 400;
  const down = new T.Vector3(0,-1,0);
  const CH = 2.5, HW = 2.6, HD = 1.15;

  const m = new T.Matrix4(); const seen = new Set(); const out = [];
  c.scene.traverse(o => {
    if (!o.isInstancedMesh || o.userData.isOutlineHull) return;
    if (!/container/i.test(o.name||'')) return;
    if (seen.has(o.name)) return; seen.add(o.name);
    o.updateWorldMatrix(true,false);
    for (let i=0;i<o.count;i++){
      o.getMatrixAt(i,m); m.premultiply(o.matrixWorld);
      const x=m.elements[12], y=m.elements[13], z=m.elements[14];
      if (!Number.isFinite(x)) continue;
      const yaw=Math.atan2(m.elements[8], m.elements[0]);
      let dPort=Infinity, near=null;
      for (const p of ports){ const d=Math.hypot(x-p.x, z-p.z); if(d<dPort){dPort=d; near=p.id;} }
      let dPier=Infinity, nearPier=null;
      for (const p of piers){ const d=Math.hypot(x-p.x, z-p.z); if(d<dPier){dPier=d; nearPier=p.id;} }
      /* the daylight under the sole: four corners in the BOX's frame,
         and the box it may be stacked on counts as ground */
      const cs=Math.cos(yaw), sn=Math.sin(yaw);
      let gap=null;
      for (const [cu,cv] of [[HW,HD],[HW,-HD],[-HW,HD],[-HW,-HD]]) {
        const px=x+cu*cs+cv*sn, pz=z-cu*sn+cv*cs;
        ray.set(new T.Vector3(px, y+0.9, pz), down);
        const hit=ray.intersectObjects(targets,true)[0];
        let g = hit ? (y - hit.point.y) : null;
        out.__ = 0;
        if (g === null) { gap = gap === null ? null : gap; continue; }
        gap = gap === null ? g : Math.min(gap, g);
      }
      out.push({ x:+x.toFixed(1), y:+y.toFixed(2), z:+z.toFixed(1),
        port:+dPort.toFixed(1), portId:near, pier:+dPier.toFixed(1), pierId:nearPier,
        shore:+c.world.shoreDistAt(x,z).toFixed(1), gapRaw: gap===null?null:+gap.toFixed(3) });
    }
  });
  /* a stacked box's "ground" is the box beneath it */
  for (const b of out) {
    let under=-Infinity;
    for (const o of out) if (o!==b && Math.hypot(o.x-b.x,o.z-b.z)<1.6 && o.y < b.y-0.2) under=Math.max(under,o.y);
    b.stacked = under>-Infinity;
    b.gap = b.stacked ? +(b.y - under - CH).toFixed(3) : b.gapRaw;
  }
  return { locs, ports, piers, boxes: out, zones: [...new Set(locs.map(l=>l.zone))] };
});

const strays = r.boxes.filter(b => b.port > 40 && b.shore > 26);
const floaters = r.boxes.filter(b => b.gap === null || b.gap > 0.07);
console.log(`ports: ${JSON.stringify(r.ports.map(p=>[p.id,p.x,p.z]))}`);
console.log(`piers (kit=pier): ${JSON.stringify(r.piers.map(p=>[p.id,p.n,p.port,p.x,p.z,p.shore]))}`);
console.log(`containers drawn: ${r.boxes.length}`);
console.log(`  worst distance from a port: ${Math.max(...r.boxes.map(b=>b.port)).toFixed(1)} m`);
console.log(`  worst distance inland (shoreDist): ${Math.max(...r.boxes.map(b=>b.shore)).toFixed(1)} m`);
console.log(`  STRAYS (>40 m from a port AND >26 m inland): ${strays.length}`);
strays.slice(0,8).forEach(b=>console.log('   ', JSON.stringify(b)));
console.log(`  FLOATERS (gap > 0.07 m or no ground): ${floaters.length}`);
floaters.slice(0,8).forEach(b=>console.log('   ', JSON.stringify(b)));
const nearRes = r.boxes.filter(b => { const h = r.piers.find(p=>!p.port); return h && Math.hypot(b.x-h.x,b.z-h.z) < 120; });
console.log(`  within 120 m of Harbour Residences: ${nearRes.length}`);
console.log('  gap distribution:', JSON.stringify(r.boxes.map(b=>b.gap).sort((a,b)=>(b??9)-(a??9)).slice(0,6)));
await writeFile(join(OUT,'containers.json'), JSON.stringify(r, null, 1));
await close();
console.log(JSON.stringify({ errors: errors.slice(0,4) }));
