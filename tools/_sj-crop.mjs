#!/usr/bin/env node
/* crop + nearest-neighbour upscale a PNG region -> PNG. usage: in.png out.png x y w h scale */
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

function decodePNG(file) {
  const buf = readFileSync(file);
  let off = 8, w=0,h=0,bd=0,ct=0,il=0; const idat=[]; let plte=null,trns=null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off+4, off+8);
    const d = buf.subarray(off+8, off+8+len);
    if (type==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);bd=d[8];ct=d[9];il=d[12];}
    else if (type==='IDAT') idat.push(d);
    else if (type==='PLTE') plte=d; else if (type==='tRNS') trns=d;
    else if (type==='IEND') break;
    off += 12+len;
  }
  if (bd!==8||il) throw new Error('unsupported png');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const chans = {0:1,2:3,3:1,4:2,6:4}[ct];
  const stride = w*chans, out = Buffer.alloc(h*stride);
  let pos=0;
  for (let y=0;y<h;y++){
    const f=raw[pos++]; const line=raw.subarray(pos,pos+stride); pos+=stride;
    const cur=out.subarray(y*stride,(y+1)*stride), prev=y>0?out.subarray((y-1)*stride,y*stride):null;
    for(let x=0;x<stride;x++){
      const a=x>=chans?cur[x-chans]:0, b=prev?prev[x]:0, c=(prev&&x>=chans)?prev[x-chans]:0;
      let v=line[x];
      if(f===1)v=(v+a)&255; else if(f===2)v=(v+b)&255; else if(f===3)v=(v+((a+b)>>1))&255;
      else if(f===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);v=(v+((pa<=pb&&pa<=pc)?a:(pb<=pc?b:c)))&255;}
      cur[x]=v;
    }
  }
  const rgba=new Uint8Array(w*h*4);
  for(let i=0,n=w*h;i<n;i++){
    let r,g,b,a=255;
    if(ct===6){r=out[i*4];g=out[i*4+1];b=out[i*4+2];a=out[i*4+3];}
    else if(ct===2){r=out[i*3];g=out[i*3+1];b=out[i*3+2];}
    else if(ct===0){r=g=b=out[i];}
    else if(ct===4){r=g=b=out[i*2];a=out[i*2+1];}
    else {const p=out[i];r=plte[p*3];g=plte[p*3+1];b=plte[p*3+2];if(trns&&p<trns.length)a=trns[p];}
    rgba[i*4]=r;rgba[i*4+1]=g;rgba[i*4+2]=b;rgba[i*4+3]=a;
  }
  return {w,h,data:rgba};
}

function crc32(buf){let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}
  let crc=0xffffffff;for(let i=0;i<buf.length;i++)crc=t[(crc^buf[i])&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function chunk(type,data){const b=Buffer.alloc(8+data.length+4);b.writeUInt32BE(data.length,0);b.write(type,4,'ascii');data.copy(b,8);b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type,'ascii'),data])),8+data.length);return b;}
function encodePNG(w,h,rgba){
  const stride=w*4, raw=Buffer.alloc(h*(stride+1));
  for(let y=0;y<h;y++){raw[y*(stride+1)]=0;Buffer.from(rgba.buffer,rgba.byteOffset+y*stride,stride).copy(raw,y*(stride+1)+1);}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}

const [inp,outp,X,Y,CW,CH,SC] = process.argv.slice(2);
const x0=+X,y0=+Y,cw=+CW,ch=+CH,sc=+(SC||1);
const img = decodePNG(inp);
const ow=cw*sc, oh=ch*sc;
const out=new Uint8Array(ow*oh*4);
for(let y=0;y<oh;y++)for(let x=0;x<ow;x++){
  const sx=Math.min(img.w-1,x0+Math.floor(x/sc)), sy=Math.min(img.h-1,y0+Math.floor(y/sc));
  const si=(sy*img.w+sx)*4, di=(y*ow+x)*4;
  out[di]=img.data[si];out[di+1]=img.data[si+1];out[di+2]=img.data[si+2];out[di+3]=img.data[si+3];
}
writeFileSync(outp, encodePNG(ow,oh,out));
console.log(`${outp} ${ow}x${oh} from ${inp} ${img.w}x${img.h}`);
