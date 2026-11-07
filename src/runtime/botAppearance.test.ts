import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_OPTIONS, DEFAULT_BOT, PROVIDER_MASCOTS, parseBotAppearance, parseBotAppearances } from './botAppearance.ts';
import { BotConfigStore } from '../pi/botConfig.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botAvatarSVG, botPartSVG } from '../avatars/botAvatar.ts';
import { harnessMarkSVG } from '../avatars/harnessArtwork.ts';

test('saved bot appearances round trip independently and reject damaged data', () => {
  const bob = { ...DEFAULT_BOT, hair: 'bob' as const, hairColor: '#9B91A8' };
  assert.deepEqual(parseBotAppearances(JSON.stringify({ woman: DEFAULT_BOT, boy: bob })), { woman: DEFAULT_BOT, boy: bob });
  assert.deepEqual(parseBotAppearances('{broken'), {});
  assert.deepEqual(parseBotAppearances('null'), {});
  assert.deepEqual(parseBotAppearances(JSON.stringify({ woman: { ...bob, hair: 'unknown' }, boy: bob })), { boy: bob });
});
test('provider characters survive host save and restart without changing model, engine or custom parts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rtb-mascot-'));
  try {
    const file = join(dir, 'bots.json');
    for (const mascot of PROVIDER_MASCOTS) {
      const store = new BotConfigStore(file);
      const original = { ...store.require('assistant'), model: { provider: 'chosen-provider', model: 'chosen-model' } };
      const appearance = { ...original.appearance, mascot };
      store.save({ ...original, appearance }, store.view().revision);
      const reloaded = new BotConfigStore(file).require(original.id);
      assert.deepEqual(reloaded, { ...original, appearance });
      const { mascot: _mascot, ...custom } = reloaded.appearance;
      const { mascot: _previous, ...expected } = original.appearance;
      assert.deepEqual(parseBotAppearance(custom), expected);
      const svg = botAvatarSVG(reloaded.appearance, { id: mascot });
      assert.ok(svg.includes(`data-mascot="${mascot}"`));
      assert.equal(svg.match(/class="open-eye"/g)?.length, 2);
      for (const layer of ['drag-group', 'follow-group', 'action-group', 'gesture-group', 'breath', 'gaze', 'thinking-gaze']) assert.ok(svg.includes(`class="${layer}"`));
      const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
      for (const reference of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(reference[1]));
      assert.ok(!svg.includes('<image') && !svg.includes('undefined') && !svg.includes('NaN'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('unknown and injected character identities are rejected at the appearance boundary', () => {
  for (const mascot of ['__proto__', 'unknown', '<svg onload="alert(1)">', null, 1, {}]) {
    const value = { ...DEFAULT_BOT, mascot };
    assert.equal(parseBotAppearance(value), undefined);
    assert.ok(!botAvatarSVG(value as typeof DEFAULT_BOT).includes('data-mascot'));
  }
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
    assert.deepEqual(parseBotAppearance({ ...DEFAULT_BOT, face, hair, accessory }), { ...DEFAULT_BOT, face, hair, accessory });
    for (const layer of ['drag-group', 'follow-group', 'action-group', 'gesture-group', 'breath', 'gaze', 'thinking-gaze']) assert.ok(svg.includes(`class="${layer}"`));
    assert.equal(svg.match(/class="blink"/g)?.length, 2);
    assert.equal(svg.match(/<rect class="open-eye"/g)?.length, 2);
    assert.ok(!svg.includes('undefined'));
  }
});

test('face thumbnails show the chosen shaded shape without hair, accessories or animated eyes', () => {
  for (const face of BOT_OPTIONS.face) {
    const svg = botPartSVG('face', { ...DEFAULT_BOT, face, faceColor: '#E5CFAA' });
    assert.ok(svg.includes('radialGradient') && svg.includes('#E5CFAA'));
    assert.ok(!svg.includes('open-eye') && !svg.includes('blink') && !svg.includes('drag-group'));
    assert.match(svg, /<(ellipse|rect|path)\b/);
    assert.ok(!svg.includes('undefined') && !svg.includes('NaN'));
  }
});

test('hats clip every hair crown while keeping the face and eye motion intact', () => {
  for (const hair of BOT_OPTIONS.hair) for (const accessory of ['cap', 'beanie'] as const) {
    const svg = botAvatarSVG({ ...DEFAULT_BOT, hair, accessory }, { id: 'hat-preview' });
    assert.ok(svg.includes('clip-path="url(#hat-preview-under-hat)"'));
    assert.ok(svg.includes('<clipPath id="hat-preview-under-hat">'));
    assert.equal(svg.match(/class="open-eye"/g)?.length, 2);
    assert.ok(svg.includes('class="gaze"') && svg.includes('class="thinking-gaze"'));
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

test('retired flag settings are ignored without losing the saved 3D avatar or head accessory', () => {
  for (const harnessFlag of [true, false]) {
    const appearance = { ...DEFAULT_BOT, hair: 'quiff' as const, accessory: 'cap' as const, faceColor: '#E9D4AA' };
    const legacy = { ...appearance, harnessFlag };
    assert.deepEqual(parseBotAppearance(legacy), appearance);
    assert.deepEqual(parseBotAppearances(JSON.stringify({ boy: legacy })).boy, appearance);
    const svg = botAvatarSVG(legacy);
    assert.ok(!svg.includes('harness-flag') && !svg.includes('/brand/harness/'));
    assert.match(svg, /viewBox="0 0 400 400"/);
    assert.ok(svg.includes('radialGradient') && svg.includes('fill="#E9D4AA"'));
    assert.equal(svg.match(/class="open-eye"/g)?.length, 2);
  }
});

test('each instance owns its material IDs and every paint reference resolves locally', () => {
  const drawings = ['first', 'second'].map(id => botAvatarSVG({ ...DEFAULT_BOT, accessory: 'sunglasses' }, { id, harness: 'codex' }));
  const ids = drawings.map(svg => [...svg.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  assert.equal(ids[0].some(id => ids[1].includes(id)), false);
  for (let i = 0; i < drawings.length; i++) {
    for (const reference of drawings[i].matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids[i].includes(reference[1]), reference[1]);
    assert.ok(!drawings[i].includes('NaN') && !drawings[i].includes('undefined'));
  }
});

test('standalone Harness marks retain official artwork on the 3D tile', () => {
  for (const [harness, file] of [['pi', 'pi.svg'], ['claude-code', 'claude-code.svg'], ['codex', 'codex.png'], ['dsh', 'dsh.svg']] as const) {
    const svg = harnessMarkSVG(harness, `mark-${harness}`);
    assert.ok(svg.includes(`/brand/harness/${file}`));
    assert.ok(svg.includes('radialGradient') && svg.includes('feDropShadow'));
    assert.ok(!svg.includes('harness-flag'));
  }
});

test('oversized sunglasses use only the current engine artwork on one lens in avatars and thumbnails', () => {
  const appearance = { ...DEFAULT_BOT, accessory: 'sunglasses' as const, accessoryColor: '#7799AA' };
  for (const [harness, file] of [['pi', 'pi.svg'], ['claude-code', 'claude-code.svg'], ['codex', 'codex-lens.svg'], ['dsh', 'dsh-lens.svg']] as const) {
    for (const svg of [botAvatarSVG(appearance, { harness }), botPartSVG('accessory', appearance, undefined, harness)]) {
      assert.equal(svg.match(/<image /g)?.length, 1);
      assert.ok(svg.includes(`/brand/harness/${file}`));
      assert.ok(svg.includes(`data-harness="${harness}"`) && svg.includes('#7799AA'));
      assert.ok(svg.includes('x="55.5" y="45.5" width="24" height="20"'));
      assert.match(svg, /clip-path="url\(#[^)]+-lens\)"/);
      assert.ok(!svg.includes('#f5efdf') && !svg.includes('translate(62 48)'));
    }
    for (const accessory of BOT_OPTIONS.accessory.filter(value => value !== 'sunglasses')) {
      assert.ok(!botAvatarSVG({ ...appearance, accessory }, { harness }).includes('<image '));
    }
  }
  assert.ok(!botAvatarSVG(appearance).includes('<image '));
  assert.ok(!botAvatarSVG(appearance, { harness: 'x" onload="alert(1)' as 'pi' }).includes('onload'));
});
