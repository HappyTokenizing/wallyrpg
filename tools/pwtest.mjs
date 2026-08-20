import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome', args:['--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport:{width:640,height:400} });
await p.setContent('<canvas id=c width=200 height=200></canvas><script>const gl=document.getElementById("c").getContext("webgl2");document.title=gl?("WEBGL2 OK | "+gl.getParameter(gl.RENDERER)):"NOGL";<\/script>');
console.log(await p.title());
await p.screenshot({path:'/tmp/pwtest.png'});
await b.close();
