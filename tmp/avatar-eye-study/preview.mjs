import { avatarSVG, kinds, names } from './avatars.mjs';
import { mountAvatarMotion } from '../../src/avatars/avatarMotion.ts';

const state = document.querySelector('#state');
const autoplay = document.querySelector('#autoplay');
const halo = document.querySelector('#halo');
const pause = document.querySelector('#pause');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const scene = [['idle',3200],['thinking',4800],['reading',4000],['working',3000],['writing',3000],['asking',2200],['success',1800]];
let motions = [], timer, paused = false, step = 0;
if (reduced.matches) autoplay.checked = false;

function render() {
  motions.forEach(m => m.destroy());
  const ratio = Number(document.querySelector('[name="ratio"]:checked').value);
  document.querySelector('#portraits').innerHTML = kinds.map(kind => `<section class="person">
    <div class="stage"><span class="raytone-avatar" data-kind="${kind}" data-interactive="true">${avatarSVG(kind,{ratio,halo:halo.checked,id:`large-${kind}`})}</span></div>
    <h2>${names[kind]}</h2><div class="sub">${kind === 'man' ? '加高镜框 · 保留方框' : kind === 'boy' ? '棒球帽 · 三条黄线' : '条纹耳麦 · 胶囊发夹'}</div>
    <div class="small"><span class="raytone-avatar" data-kind="${kind}" style="width:76px;height:76px">${avatarSVG(kind,{ratio,halo:halo.checked,id:`small-${kind}`})}</span><span class="size-label">实际欢迎区<br>76 px</span></div>
  </section>`).join('');
  motions = [...document.querySelectorAll('.raytone-avatar')].map(root => mountAvatarMotion(root,{interactive:root.dataset.interactive === 'true',kind:root.dataset.kind}));
  motions.forEach(m => m.setState(state.value));
  if(paused) freeze();
}
function freeze() {
  document.querySelectorAll('.raytone-avatar').forEach(root => {
    root.dataset.paused = 'true';
    root.getAnimations({subtree:true}).forEach(a => a.pause());
  });
  motions.forEach(m => m.destroy());
  document.querySelectorAll('.raytone-avatar').forEach(root => {
    root.querySelectorAll('.gaze,.follow-group,.drag-group').forEach(g => g.style.transform='none');
  });
}
function schedule() {
  clearTimeout(timer);
  if (!autoplay.checked || paused || reduced.matches || document.hidden) return;
  timer = setTimeout(() => {
    step = (step + 1) % scene.length;
    state.value = scene[step][0];
    motions.forEach(m => m.setState(state.value));
    schedule();
  },scene[step][1]);
}
document.querySelectorAll('[name="ratio"]').forEach(input => input.addEventListener('change',render));
halo.addEventListener('change',render);
state.addEventListener('change',() => { autoplay.checked=false;clearTimeout(timer);render(); });
autoplay.addEventListener('change',() => { if(autoplay.checked) {step=0;state.value='idle';render();}schedule(); });
pause.addEventListener('click',() => { paused=!paused;pause.textContent=paused?'继续':'暂停';pause.setAttribute('aria-pressed',String(paused));render();schedule(); });
document.addEventListener('visibilitychange',schedule);
reduced.addEventListener('change',() => { if(reduced.matches) autoplay.checked=false;schedule(); });
window.addEventListener('pagehide',() => {clearTimeout(timer);motions.forEach(m => m.destroy());});
render();schedule();
