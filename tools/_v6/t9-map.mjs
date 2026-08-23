/* 10. THE MAP at three real sizes — Places (phone app) and the full map. */
import { boot } from './lib.mjs';
import { mkdirSync } from 'node:fs';
const SIZES = [
  ['phone-portrait', 390, 844, 3, true],
  ['phone-landscape', 844, 390, 3, true],
  ['desktop', 1400, 900, 2, false],
];
mkdirSync('/Users/herwig/Documents/GitHub/wallyrpg/shots/_v6', { recursive: true });
for (const [tag, w, h, dsf, touch] of SIZES) {
  const B = await boot({ viewport: { width: w, height: h }, dsf, ctx: touch ? { hasTouch: true, isMobile: true } : {} });
  const { page } = B;
  await page.evaluate(() => { V.setup({ time: 11*60 }); WALLY.ctx.ui.closeAll?.(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => WALLY.ctx.ui.show('places'));
  await page.waitForTimeout(1400);
  const geo = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect();
      return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), bottom: +b.bottom.toFixed(1) }; };
    const svg = q('.w-map-svg'), map = q('.w-map');
    const app = q('.w-phone-body') || q('.w-app') || q('.w-sheet-body');
    const labels = [...(svg ? svg.querySelectorAll('text') : [])].filter(t => !t.classList.contains('wm-ico'))
      .map(t => ({ t: t.textContent, fs: +getComputedStyle(t).fontSize.replace('px',''), box: r(t) }));
    const px = svg ? svg.getBoundingClientRect().width / (+svg.getAttribute('viewBox').split(' ')[2]) : 0;
    /* name labels are sized in VIEWBOX units; convert to css px */
    const named = [...(svg ? svg.querySelectorAll('text[font-size]') : [])].map(t => ({
      t: t.textContent, vbFs: +t.getAttribute('font-size'), cssFs: +(t.getAttribute('font-size') * px).toFixed(2),
    })).filter(o => o.t && o.t.length > 2);
    const btn = [...document.querySelectorAll('button')].map(b => ({ t: (b.textContent||'').trim().slice(0,18), box: r(b) }));
    return {
      viewport: { w: innerWidth, h: innerHeight },
      map: r(map), svg: r(svg), app: r(app),
      pxPerVb: +px.toFixed(4),
      labels: named.slice(0, 40),
      buttons: btn.filter(b => /Full map|Point me/.test(b.t)),
      scrollH: app ? app.scrollHeight : null, clientH: app ? app.clientHeight : null,
      detailTop: r(document.querySelector('.w-label')),
    };
  });
  console.log(`\n===== ${tag} ${w}x${h} dsf${dsf} =====`);
  console.log('viewport', JSON.stringify(geo.viewport));
  console.log('map box  ', JSON.stringify(geo.map), ' svg', JSON.stringify(geo.svg));
  console.log('app body ', JSON.stringify(geo.app), 'scrollH', geo.scrollH, 'clientH', geo.clientH);
  console.log('px per viewBox unit', geo.pxPerVb);
  const fs = geo.labels.map(l=>l.cssFs).filter(Boolean);
  console.log('place-name label css font-size:', fs.length ? `${Math.min(...fs)} .. ${Math.max(...fs)} px  (n=${fs.length})` : 'none');
  console.log('sample labels:', JSON.stringify(geo.labels.slice(0,6)));
  console.log('buttons below the map:', JSON.stringify(geo.buttons));
  console.log('first detail row top:', JSON.stringify(geo.detailTop));
  await page.screenshot({ path: `shots/_v6/places-${tag}.png` });
  /* and the full map sheet */
  await page.evaluate(() => { WALLY.ctx.ui.closeAll(); WALLY.ctx.ui.openMap(); });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `shots/_v6/fullmap-${tag}.png` });
  const g2 = await page.evaluate(() => {
    const svg = document.querySelector('.w-map-svg');
    const b = svg ? svg.getBoundingClientRect() : null;
    return b ? { x:+b.x.toFixed(1), y:+b.y.toFixed(1), w:+b.width.toFixed(1), h:+b.height.toFixed(1), bottom:+b.bottom.toFixed(1), vh: innerHeight } : null;
  });
  console.log('full map svg box:', JSON.stringify(g2));
  console.log('page errors:', B.errs.length, B.errs.slice(0,3).join(' | '));
  await B.close();
}
console.log('\nwrote shots/_v6/places-*.png and fullmap-*.png');
