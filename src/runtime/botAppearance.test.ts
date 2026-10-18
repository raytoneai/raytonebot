import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_OPTIONS, DEFAULT_BOT, parseBotAppearance, parseBotAppearances } from './botAppearance.ts';
import { botAvatarSVG, botPartSVG } from '../avatars/botAvatar.ts';

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
  for (const face of BOT_OPTIONS.face) for (const hair of BOT_OPTIONS.hair) for (const accessory of BOT_OPTIONS.accessory) {
    const svg = botAvatarSVG({ ...DEFAULT_BOT, face, hair, accessory });
    for (const layer of ['drag-group', 'follow-group', 'action-group', 'gesture-group', 'breath', 'gaze', 'thinking-gaze']) assert.ok(svg.includes(`class="${layer}"`));
    assert.equal(svg.match(/class="blink"/g)?.length, 2);
    assert.equal(svg.match(/<rect class="open-eye"/g)?.length, 2);
    assert.ok(!svg.includes('undefined'));
  }
});

test('legacy eye choices use the same animated capsule eyes without losing other customisations', () => {
  for (const eyes of ['round', 'smile']) {
    const saved = { ...DEFAULT_BOT, eyes, hair: 'buns', accessory: 'bow', faceColor: '#123456' };
    const expected = { ...saved, eyes: 'capsule' };
    assert.deepEqual(parseBotAppearance(saved), expected);
    assert.deepEqual(parseBotAppearances(JSON.stringify({ woman: saved })).woman, expected);
  }
  assert.equal(parseBotAppearance({ ...DEFAULT_BOT, eyes: 'unknown' }), undefined);
});

test('hair and accessory previews omit faces, eyes and motion layers, retaining only the chosen piece', () => {
  for (const part of ['hair', 'accessory'] as const) for (const value of BOT_OPTIONS[part]) {
    const svg = botPartSVG(part, { ...DEFAULT_BOT, [part]: value });
    assert.ok(!svg.includes('<ellipse') && !svg.includes('open-eye') && !svg.includes('blink') && !svg.includes('drag-group'));
    assert.ok(svg.includes('fill="currentColor"') && !svg.includes('undefined'));
    if (value === 'none') assert.match(svg, /<svg[^>]*><\/svg>/);
    else assert.match(svg, /<(path|rect|circle)\b/);
  }
  // An accessory thumbnail must not contain the selected hair, or interpolate unvalidated colours.
  const preview = botPartSVG('accessory', { ...DEFAULT_BOT, hair: 'quiff', faceColor: '#fff" onload="alert(1)' });
  assert.ok(!preview.includes('M17 37Q19 15') && !preview.includes('onload'));
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
