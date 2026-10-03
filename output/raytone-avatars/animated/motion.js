import { animate } from 'motion';

export const states = { idle: '待机', waiting: '思考中', success: '完成', warning: '需要确认', sleep: '休息' };
const clamp = (n, limit) => Math.max(-limit, Math.min(limit, n));
const spring = { type: 'spring', duration: .5, bounce: .2 };

export function mountMotion(root) {
  const abort = new AbortController(), options = { signal: abort.signal };
  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const fineQuery = matchMedia('(hover: hover) and (pointer: fine)');
  const head = root.querySelector('.drag-group'), follow = root.querySelector('.follow-group');
  const gaze = root.querySelector('.gaze'), lids = [...root.querySelectorAll('.blink')];
  let state = 'idle', reduced = reduceQuery.matches, manualReduce = false, following = true;
  let blinkTimer, resetTimer, drag = null, releaseAnimation, destroyed = false;
  const stopTimers = () => { clearTimeout(blinkTimer); clearTimeout(resetTimer); };
  function centerGaze() {
    gaze.style.transform = 'translate(0px, 0px)';
    follow.style.transform = 'rotate(0deg)';
  }
  function queueBlink() {
    clearTimeout(blinkTimer);
    if (destroyed || reduced || document.hidden || state === 'sleep') return;
    blinkTimer = setTimeout(() => {
      if (state !== 'success') lids.forEach(lid => lid.animate(
        [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.08)' }, { transform: 'scaleY(1)' }],
        { duration: 180, easing: 'cubic-bezier(.45,0,.25,1)' },
      ));
      queueBlink();
    }, 2800 + Math.random() * 2600);
  }
  function endDrag(cancelled = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    root.dataset.dragging = 'false';
    if (root.hasPointerCapture(previous.id)) root.releasePointerCapture(previous.id);
    releaseAnimation?.stop();
    if (reduced || document.hidden || destroyed) head.style.transform = 'none';
    else releaseAnimation = animate(head, { transform: 'translate(0px, 0px) rotate(0deg) scale(1, 1)' }, spring);
    if (!cancelled && !previous.moved) setState('success');
  }
  function setState(next) {
    if (!Object.hasOwn(states, next)) throw new RangeError('Unknown avatar state');
    if (destroyed) return;
    stopTimers();
    endDrag(true);
    state = next;
    root.dataset.state = next;
    centerGaze();
    root.dispatchEvent(new CustomEvent('avatar-state', { detail: { state: next }, bubbles: true }));
    queueBlink();
    if (next === 'success') resetTimer = setTimeout(() => setState('idle'), 1400);
  }
  function syncReduced() {
    reduced = manualReduce || reduceQuery.matches;
    root.dataset.reduced = String(reduced);
    if (reduced) {
      endDrag(true);
      releaseAnimation?.stop();
      head.style.transform = 'none';
      root.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
      centerGaze();
    }
    queueBlink();
  }
  function move(event) {
    if (reduced || document.hidden) return;
    if (drag) {
      if (event.pointerId !== drag.id) return;
      const dx = clamp((event.clientX - drag.x) * 400 / drag.width, 30);
      const dy = clamp((event.clientY - drag.y) * 400 / drag.width, 22);
      drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4;
      head.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 5}deg) scale(${1 + Math.abs(dx) / 500}, ${1 - Math.abs(dx) / 800})`;
      return;
    }
    if (!following || !fineQuery.matches || event.pointerType === 'touch' || state !== 'idle') return;
    const bounds = root.getBoundingClientRect();
    const x = clamp((event.clientX - bounds.left - bounds.width / 2) / (bounds.width / 2), 1);
    const y = clamp((event.clientY - bounds.top - bounds.height / 2) / (bounds.height / 2), 1);
    gaze.style.transform = `translate(${x * 7}px, ${y * 5}px)`;
    follow.style.transform = `rotate(${x * 3}deg)`;
  }
  root.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || reduced) return;
    setState('idle');
    releaseAnimation?.stop();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width: root.getBoundingClientRect().width, moved: false };
    root.dataset.dragging = 'true';
    root.setPointerCapture(event.pointerId);
    head.style.transform = 'translate(0px, 0px) rotate(0deg) scale(1.025, .97)';
  }, options);
  window.addEventListener('pointermove', move, { ...options, passive: true });
  root.addEventListener('pointerup', event => { if (drag?.id === event.pointerId) endDrag(); }, options);
  root.addEventListener('pointercancel', () => endDrag(true), options);
  root.addEventListener('lostpointercapture', () => endDrag(true), options);
  root.addEventListener('click', event => { if (event.detail === 0 || reduced) setState('success'); }, options);
  document.documentElement.addEventListener('pointerleave', centerGaze, options);
  window.addEventListener('blur', () => { endDrag(true); centerGaze(); }, options);
  document.addEventListener('visibilitychange', () => {
    root.dataset.hidden = String(document.hidden);
    if (document.hidden) { endDrag(true); centerGaze(); }
    queueBlink();
  }, options);
  reduceQuery.addEventListener('change', syncReduced, options);
  fineQuery.addEventListener('change', centerGaze, options);
  root.dataset.hidden = String(document.hidden);
  syncReduced();
  setState('idle');
  return {
    setState,
    setReduced(value) { manualReduce = Boolean(value); syncReduced(); },
    setFollow(value) { following = Boolean(value); if (!following) centerGaze(); },
    destroy() {
      destroyed = true;
      stopTimers();
      endDrag(true);
      abort.abort();
      releaseAnimation?.stop();
      root.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
    },
  };
}
