import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_OPTIONS, DEFAULT_BOT, parseBotAppearance, parseBotAppearances } from './botAppearance.ts';
import { botAvatarSVG } from '../avatars/botAvatar.ts';

test('saved bot appearances round trip independently and reject damaged data', () => {
  const bob = { ...DEFAULT_BOT, hair: 'bob' as const, hairColor: '#9B91A8' };
  assert.deepEqual(parseBotAppearances(JSON.stringify({ woman: DEFAULT_BOT, boy: bob })), { woman: DEFAULT_BOT, boy: bob });
  assert.deepEqual(parseBotAppearances('{broken'), {});
  assert.deepEqual(parseBotAppearances('null'), {});
  assert.deepEqual(parseBotAppearances(JSON.stringify({ woman: { ...bob, hair: 'unknown' }, boy: bob })), { boy: bob });
});
test('SVG rejects injected colours and unknown options, strips surplus data', () => {
  for (const key of ['faceColor', 'eyeColor', 'hairColor', 'accessoryColor']) {
    const value = { ...DEFAULT_BOT, [key]: '#fff\" onload=\"alert(1)' };
    assert.equal(parseBotAppearance(value), undefined);
    assert.ok(!botAvatarSVG(value).includes('onload'));
  }
  assert.equal(parseBotAppearance({ ...DEFAULT_BOT, hair: '__proto__' }), undefined);
  assert.deepEqual(parseBotAppearance({ ...DEFAULT_BOT, svg: '<script/>' }), DEFAULT_BOT);
});
test('every combination retains existing motion layers and two eyes', () => {
  for (const face of BOT_OPTIONS.face) for (const eyes of BOT_OPTIONS.eyes) for (const hair of BOT_OPTIONS.hair) for (const accessory of BOT_OPTIONS.accessory) {
    const svg = botAvatarSVG({ ...DEFAULT_BOT, face, eyes, hair, accessory });
    for (const layer of ['drag-group', 'follow-group', 'action-group', 'gesture-group', 'breath', 'gaze', 'thinking-gaze']) assert.ok(svg.includes(`class="${layer}"`));
    assert.equal(svg.match(/class="blink"/g)?.length, 2);
    assert.ok(!svg.includes('undefined'));
  }
});

test('universal accessories persist, render their colour and keep eyes unobstructed by quiff', () => {
  for (const accessory of ['headphones', 'headset', 'cap', 'beanie'] as const) {
    const appearance = { ...DEFAULT_BOT, hair: 'quiff' as const, accessory, accessoryColor: '#ABCDEF' };
    assert.deepEqual(parseBotAppearances(JSON.stringify({ boy: appearance })).boy, appearance);
    const svg = botAvatarSVG(appearance);
    assert.ok(svg.includes('fill="#ABCDEF"'));
    assert.ok(!svg.includes('${'));
    assert.equal(svg.match(/class="open-eye"/g)?.length, 2);
    assert.equal(svg.includes('M17 37Q19 15'), accessory === 'headphones' || accessory === 'headset');
  }
});
