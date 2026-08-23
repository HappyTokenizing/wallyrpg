import { boot } from './lib.mjs';
const { page, close } = await boot();
const o = await page.evaluate(() => {
  const W = window.WALLY, c = W.ctx;
  const CELL = 2, gx0 = -672, gz0 = -560;
  const H = (x, z) => c.world.heightAt(x, z);
  const tri = (x, z) => { const gx = (x - gx0) / CELL, gz = (z - gz0) / CELL;
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    return { i, j, fx: +fx.toFixed(4), fz: +fz.toFixed(4), t: fz <= fx ? 0 : 1 }; };
  const cl = (v,a,b)=>v<a?a:(v>b?b:v);
  const out = [];
  const LAT=[0,Math.PI/2,Math.PI,3*Math.PI/2];
  const b=c.world.bounds; let k=0;
  for (let x=b.min.x; x<=b.max.x && out.length<6; x+=10)
  for (let z=b.min.z; z<=b.max.z && out.length<6; z+=10) {
    const h0=H(x,z); if(!Number.isFinite(h0)||h0<c.world.seaLevel+0.15) continue;
    const yaw=LAT[k%4]; k++;
    const p=W.debug.parkProbe(x,z,yaw,'bike',true); if(p.error) continue;
    if (Math.abs(p.gradientDeg)<8) continue;
    const pr=c.wally.rideProps[p.ride], g=pr.group;
    const px=g.position.x, pz=g.position.z, ws=pr.wheels;
    const lz=(w)=>{let s=0;for(let q=w;q&&q!==g;q=q.parent)s+=q.position.z;return s;};
    const zf=lz(ws[0]), zr=lz(ws[1]), base=zf-zr;
    const fx=Math.sin(yaw), fz=Math.cos(yaw);
    const S=(zz,cp)=>({x:px+fx*zz*cp, z:pz+fz*zz*cp});
    const A=S(zf,1),B=S(zr,1);
    const hf=H(A.x,A.z),hr=H(B.x,B.z);
    const p1=cl(Math.atan2(hr-hf,base),-0.838,0.838);
    const A2=S(zf,Math.cos(p1)),B2=S(zr,Math.cos(p1));
    const hf2=H(A2.x,A2.z),hr2=H(B2.x,B2.z);
    const p2=cl(Math.asin(cl((hr2-hf2)/base,-1,1)),-0.838,0.838);
    out.push({ x,z,yaw:+yaw.toFixed(3), px:+px.toFixed(4), pz:+pz.toFixed(4), zf:+zf.toFixed(4), zr:+zr.toFixed(4),
      gradDeg:p.gradientDeg, p1:p1, p2:p2, dp:p2-p1,
      hf, hr, hf2, hr2, chord1:(hr-hf)/base, chord2:(hr2-hf2)/base,
      triF:tri(A.x,A.z), triR:tri(B.x,B.z), triF2:tri(A2.x,A2.z), triR2:tri(B2.x,B2.z) });
  }
  return out;
});
console.log(JSON.stringify(o,null,1));
await close();
