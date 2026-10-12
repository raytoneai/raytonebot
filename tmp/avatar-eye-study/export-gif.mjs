// Render our native SVG drawing; no production assets or generated bitmaps are edited.
// The HTML uses the actual production motion controller. This portable loop samples its
// idle glance distances, 140/520 ms eye/head timing, 180 ms blink and 6 s halo drift.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { avatarSVG, kinds, names } from './avatars.mjs';
const require = createRequire(import.meta.url);
const sharp = require('/Users/rickyhuo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const dir = new URL('./frames/', import.meta.url);
await mkdir(dir,{recursive:true});
const fps = 20, seconds = 6;
const curve = (t, x1, y1, x2, y2) => {
  const b = (s,a,c) => 3*(1-s)**2*s*a+3*(1-s)*s*s*c+s**3;
  let lo=0,hi=1;
  for(let i=0;i<16;i++){const mid=(lo+hi)/2;if(b(mid,x1,x2)<t)lo=mid;else hi=mid;}
  return b((lo+hi)/2,y1,y2);
};
const stops = [[0,0,0],[.8,-18,-6],[1.7,20,-8],[2.7,0,0],[3.4,-10,8],[4.4,17,3],[5.2,0,0]];
function glance(t,duration,easing){
  let previous=stops[0];
  for(let i=1;i<stops.length;i++){
    const next=stops[i];if(t<next[0])break;
    if(t<next[0]+duration){const p=curve((t-next[0])/duration,...easing);return [previous[1]+(next[1]-previous[1])*p,previous[2]+(next[2]-previous[2])*p];}
    previous=next;
  }
  return previous.slice(1);
}
function blink(t){
  for(const at of [.5,2.7,4.95]){
    const u=(t-at)/.18;
    if(u>=0&&u<=1){const p=u<.5?curve(u*2,.45,0,.25,1):1-curve((u-.5)*2,.45,0,.25,1);return 1-.92*p;}
  }
  return 1;
}
for(let frame=0;frame<fps*seconds;frame++){
  const t=frame/fps;
  const portraits=kinds.map((kind,i)=>{
    const local=(t+i*.13)%seconds;
    const [x,y]=glance(local,.14,[.2,.8,.2,1]);
    const [headX,headY]=glance(local,.52,[.45,0,.25,1]);
    let svg=avatarSVG(kind,{id:`gif-${kind}`,pose:{t:local,x,y,turn:headX/2.6,blink:blink(local)}});
    svg=svg.replace('<svg ','<svg width="330" height="330" ');
    // The outer head catches up after the eyes, matching the existing CSS follow timing.
    svg=svg.replace(`translate(${x/2.4} ${y/3}) rotate`, `translate(${headX/2.4} ${headY/3}) rotate`);
    return `<g transform="translate(${25+i*350} 52)">${svg}</g><text x="${190+i*350}" y="417" text-anchor="middle">${names[kind]}</text>`;
  }).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="458" viewBox="0 0 1080 458"><rect width="1080" height="458" fill="white"/>
    <style>.happy-eye,.glint,.mouth>*{opacity:0}.mouth>.m-smile{opacity:1}text{font-family:Arial,sans-serif;font-size:20px;fill:#0C2458}</style>
    <text x="540" y="29" text-anchor="middle" style="font-size:14px;fill:#6F7C91">RAYTONE / EYE STUDY · 33%</text>${portraits}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(new URL(`${String(frame).padStart(3,'0')}.png`,dir).pathname);
  if(frame===0)await writeFile(new URL('./poster.svg',import.meta.url),svg);
}
console.log(`Rendered ${fps*seconds} frames at ${fps} fps.`);
