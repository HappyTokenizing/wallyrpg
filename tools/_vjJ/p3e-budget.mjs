import { boot } from './lib.mjs';
const { page, browser, server } = await boot({ w: 700, h: 460 });
await page.evaluate(() => { const c = window.WALLY.ctx; c.game.actions.grantRide('bike'); c.game.actions.equipRide('bike'); });
await page.waitForTimeout(2600);
const out = await page.evaluate(() => {
  const c = window.WALLY.ctx, g = c.scene.getObjectByName('wally.bike');
  let meshes = 0, tri = 0; const mats = new Set(), geos = new Set(), byType = {};
  g.traverse((m) => {
    if (!m.isMesh || !m.geometry) return;
    meshes++;
    const t = m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
    tri += t; mats.add(m.material.uuid); geos.add(m.geometry.uuid);
    const k = m.geometry.type; byType[k] = (byType[k] || 0) + 1;
  });
  return { meshes, tri, materials: mats.size, geometries: geos.size, byType,
    frustumCulledFalse: (() => { let n = 0; g.traverse((m) => { if (m.isMesh && !m.frustumCulled) n++; }); return n; })() };
});
console.log(JSON.stringify(out));
await browser.close(); server.close();
