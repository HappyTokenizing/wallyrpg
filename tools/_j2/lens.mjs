/* Does the lens ever go INSIDE the envelope on a boarding? Measured against
   the prop's own published envelope volume, every frame, becalmed and
   drifting. Negative clearance = the camera is inside the fabric. */
import { boot, ROOT } from './lib.mjs';
const MODE = process.argv[2] || 'becalmed';
const { page, errors, close } = await boot({ settle: 4500 });
await page.evaluate((mode) => {
  const w = WALLY.ctx.wind;
  if (mode === 'becalmed') { w.setStrength(0); const Z={x:0,y:0,z:0}; w.vector=(x,z,o)=>o?o.set(0,0,0):Z; }
  else { w.setStrength(0.62); const V={x:0.53,y:0,z:0.32}; w.vector=(x,z,o)=>o?o.set(V.x,0,V.z):V; }
  window.__L = [];
  const T = WALLY.THREE, c = WALLY.ctx.camera;
  const p = new T.Vector3();
  const tick = () => {
    let prop = null;
    WALLY.ctx.scene.traverse(o => { if (o.name === 'balloon.envelope') prop = o; });
    let clear = null, inside = null, r = null;
    if (prop && prop.visible) {
      prop.updateWorldMatrix(true, false);
      /* EXACT CONTAINMENT, not a bounding sphere: cast a ray from the lens
         in a fixed direction and count crossings of the fabric. Odd = the
         camera is inside the envelope. The mesh is closed apart from the
         throat, so the ray is aimed sideways, well clear of it. */
      const rc = new T.Raycaster();
      rc.firstHitOnly = false;
      const dir = new T.Vector3(0.7071, 0.2, 0.6794).normalize();
      rc.set(c.position, dir); rc.far = 500;
      const om = prop.material.side;
      prop.material.side = T.DoubleSide;
      const hits = rc.intersectObject(prop, false);
      prop.material.side = om;
      inside = (hits.length % 2) === 1;
      clear = hits.length ? +hits[0].distance.toFixed(3) : null;
      r = hits.length;
    }
    let bi = {}; try { bi = WALLY.debug.balloonInfo(); } catch(e){}
    window.__L.push({ ms:+performance.now().toFixed(0), ph: bi.phase||'', clear: clear===null?null:+clear.toFixed(3),
      r: r===null?null:+r.toFixed(2), camY:+c.position.y.toFixed(2), near:+c.near.toFixed(3) });
    if (window.__L.length < 2200) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, MODE);
await page.waitForTimeout(700);
await page.evaluate(() => { const g = WALLY.ctx.game; g.actions.grantRide('balloon'); g.actions.equipRide('balloon'); });
await page.waitForTimeout(16000);
const L = await page.evaluate(() => window.__L);
await close();
const live = L.filter(r => r.inside !== null);
const inside = live.filter(r => r.inside);
const nearest = live.filter(r=>r.clear!==null).reduce((a,b)=> b.clear < a.clear ? b : a, {clear: 1e9});
console.log(JSON.stringify({ mode: MODE, frames: L.length, framesWithEnvelopeDrawn: live.length,
  framesLensINSIDEtheEnvelope: inside.length,
  insidePhases: [...new Set(inside.map(r=>r.ph))],
  nearestFabric: nearest.clear === 1e9 ? null : nearest.clear, nearestAtPhase: nearest.ph,
  camNear: live.length?live[0].near:null }, null, 1));
console.log('errors', errors.slice(0,3));
