/* crop+scale a PNG: node tools/_crop.mjs in.png out.png x y w h [scale] */
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync, deflateSync } from 'node:zlib';
function dec(buf){let p=8,w=0,h=0,ct=0;const idat=[];while(p<buf.length){const len=buf.readUInt32BE(p);const t=buf.toString('ascii',p+4,p+8);const d=buf.subarray(p+8,p+8+len);if(t==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);ct=d[9];}else if(t==='IDAT')idat.push(d);else if(t==='IEND')break;p+=12+len;}
const ch={0:1,2:3,4:2,6:4}[ct];const raw=inflateSync(Buffer.concat(idat));const st=w*ch;const out=Buffer.alloc(h*st);let q=0;
for(let y=0;y<h;y++){const f=raw[q++];const row=raw.subarray(q,q+st);q+=st;const o=y*st,po=o-st;
for(let x=0;x<st;x++){const a=x>=ch?out[o+x-ch]:0,b=y>0?out[po+x]:0,c=(x>=ch&&y>0)?out[po+x-ch]:0;let v=row[x];
if(f===1)v+=a;else if(f===2)v+=b;else if(f===3)v+=(a+b)>>1;else if(f===4){const pp=a+b-c,pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?b:c);}out[o+x]=v&255;}}
return {w,h,ch,data:out};}
function crc(b){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c>>>0;}
function chunk(t,d){const b=Buffer.alloc(8+d.length+4);b.writeUInt32BE(d.length,0);b.write(t,4,'ascii');d.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([Buffer.from(t,'ascii'),d])),8+d.length);return b;}
function enc(w,h,rgb){const st=w*3;const raw=Buffer.alloc(h*(st+1));for(let y=0;y<h;y++){raw[y*(st+1)]=0;rgb.copy(raw,y*(st+1)+1,y*st,(y+1)*st);}
const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;
return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const [,,inp,outp,X,Y,W,H,S]=process.argv;const s=+(S||1);
const img=dec(await readFile(inp));const x0=+X,y0=+Y,w=+W,h=+H;
const ow=Math.round(w*s),oh=Math.round(h*s);const o=Buffer.alloc(ow*oh*3);
for(let y=0;y<oh;y++)for(let x=0;x<ow;x++){const sx=Math.min(img.w-1,x0+Math.floor(x/s)),sy=Math.min(img.h-1,y0+Math.floor(y/s));
const si=(sy*img.w+sx)*img.ch,di=(y*ow+x)*3;o[di]=img.data[si];o[di+1]=img.data[si+1];o[di+2]=img.data[si+2];}
await writeFile(outp,enc(ow,oh,o));console.log('wrote',outp,ow+'x'+oh);
