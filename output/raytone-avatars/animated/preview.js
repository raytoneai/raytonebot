import { avatarSVG, characters } from './avatars.js';
import { mountMotion, states } from './motion.js';

const root = document.querySelector('#avatar');
const characterList = document.querySelector('#characters'), stateList = document.querySelector('#states');
const follow = document.querySelector('#follow'), reduce = document.querySelector('#reduce');
const demo = document.querySelector('#demo');
const messages = { idle: '我在这里，随时可以开始。', waiting: '正在认真想一想…', success: '做好啦！', warning: '这一步，想和你确认一下。', sleep: '休息一下，轻点就能唤醒。' };
let controller, taskTimer, taskRunning = false;

characterList.innerHTML = Object.entries(characters).map(([id, c]) => `<button class="character" type="button" data-character="${id}" aria-pressed="false" title="${c.note}">${avatarSVG(id)}<span>${c.name}</span></button>`).join('');
stateList.innerHTML = Object.entries(states).map(([id, label]) => `<button type="button" data-state="${id}" aria-pressed="false">${label}</button>`).join('');

function cancelTask() {
  clearTimeout(taskTimer);
  taskRunning = false;
  demo.innerHTML = '演示一次任务 <span aria-hidden="true">↗</span>';
}
function chooseCharacter(id) {
  cancelTask();
  controller?.destroy();
  root.innerHTML = avatarSVG(id);
  root.setAttribute('aria-label', `与${characters[id].name}互动：点击回应，拖动回弹`);
  root.dataset.character = id;
  controller = mountMotion(root);
  controller.setFollow(follow.checked);
  controller.setReduced(reduce.checked);
  characterList.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.character === id)));
  document.querySelector('#character-tag').textContent = `0${Object.keys(characters).indexOf(id) + 1} / 04`;
  document.querySelector('#original').href = characters[id].source;
}
root.addEventListener('avatar-state', event => {
  const state = event.detail.state;
  document.querySelector('#status-text').textContent = messages[state];
  stateList.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.state === state)));
});
root.addEventListener('pointerdown', cancelTask);
root.addEventListener('click', cancelTask);
characterList.addEventListener('click', event => {
  const button = event.target.closest('[data-character]');
  if (button) chooseCharacter(button.dataset.character);
});
stateList.addEventListener('click', event => {
  const button = event.target.closest('[data-state]');
  if (button) { cancelTask(); controller.setState(button.dataset.state); }
});
follow.addEventListener('change', () => controller.setFollow(follow.checked));
reduce.addEventListener('change', () => controller.setReduced(reduce.checked));
demo.addEventListener('click', () => {
  if (taskRunning) { cancelTask(); controller.setState('idle'); return; }
  taskRunning = true;
  demo.innerHTML = '停止演示 <span aria-hidden="true">×</span>';
  controller.setState('waiting');
  taskTimer = setTimeout(() => { cancelTask(); controller.setState('success'); }, 3000);
});
window.addEventListener('pagehide', () => { cancelTask(); controller?.destroy(); });
window.addEventListener('pageshow', event => { if (event.persisted) chooseCharacter(root.dataset.character); });
chooseCharacter('woman');

if (new URLSearchParams(location.search).has('check')) {
  const output = document.querySelector('#checks');
  output.hidden = false;
  const check = (truth, label) => { if (!truth) throw new Error(label); output.textContent += `PASS ${label}\n`; };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (const id of Object.keys(characters)) {
      chooseCharacter(id);
      check(root.querySelectorAll('.open-eye').length === 2, `${id}: separate eye layers`);
    }
    controller.setState('waiting');
    check(root.dataset.state === 'waiting', 'waiting state');
    controller.setState('success');
    controller.setState('sleep');
    await wait(1500);
    check(root.dataset.state === 'sleep', 'interrupted success cannot reset newer state');
    controller.setState('waiting');
    controller.setReduced(true);
    await wait(260);
    check(getComputedStyle(root.querySelector('.action-group')).transform === 'none', 'reduced motion removes head movement');
    check(root.getAnimations({ subtree: true }).length === 0, 'reduced motion stops looping animations');
    let rejected = false;
    try { controller.setState('invalid'); } catch { rejected = true; }
    check(rejected, 'invalid state rejected');
    controller.setState('success');
    controller.destroy();
    await wait(1500);
    check(root.dataset.state === 'success', 'destroy clears delayed callbacks');
    chooseCharacter('woman');
    demo.click();
    chooseCharacter('boy');
    await wait(3100);
    check(root.dataset.state === 'idle', 'character switch cancels simulated request');
    chooseCharacter('woman');
    output.dataset.result = 'pass';
    output.textContent += 'All checks passed.';
  } catch (error) {
    output.dataset.result = 'fail';
    output.textContent += `FAIL ${error.message}`;
    console.error(error);
  }
}
