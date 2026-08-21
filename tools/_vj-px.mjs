import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
function dec(buf){let p=8,w=0,h=0,ct=0;const idat=[];while(p<buf.length){const len=buf.readUInt32BE(p);const t=buf.toString('ascii',p+4,p+8);const d=buf.subarray(p+8,p+8+len);if(t==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);ct=d[9];}else if(t==='IDAT')idat.push(d);else if(t==='IEND')break;p+=12+len;}
const ch={0:1,2:3,4:2,6:4}[ct];const raw=inflateSync(Buffer.concat(idat));const st=w*ch;const out=Buffer.alloc(h*st);let q=0;
for(let y=0;y<h;y++){const f=raw[q++];const row=raw.subarray(q,q+st);q+=st;const o=y*st,po=o-st;
for(let x=0;x<st;x++){const a=x>=ch?out[o+x-ch]:0,b=y>0?out[po+x]:0,c=(x>=ch&&y>0)?out[po+x-ch]:0;let v=row[x];
if(f===1)v+=a;else if(f===2)v+=b;else if(f===3)v+=(a+b)>>1;else if(f===4){const pp=a+b-c,pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?b:c);}out[o+x]=v&255;}}
return {w,h,ch,data:out};}
const [,,file,Y,X0,X1,bgfile]=process.argv;
const img=dec(readFileSync(file));
const bg = bgfile ? dec(readFileSync(bgfile)) : null;
const y=+Y;
const parts=[];
for(let x=+X0;x<=+X1;x++){const i=(y*img.w+x)*img.ch;const r=img.data[i],g=img.data[i+1],b=img.data[i+2];
 let tag='';
 if(bg){const j=(y*bg.w+x)*bg.ch;const br=bg.data[j],bg2=bg.data[j+1],bb=bg.data[j+2];
   if(br>150&&bg2<110&&bb>150) tag='*BG'; }
 parts.push(`${x}:${r},${g},${b}${tag}`);}
console.log(`${file} row ${y}`); console.log(parts.join('  '));
