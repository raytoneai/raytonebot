import assert from "node:assert/strict";
import test from "node:test";
import { revealCurrentSettingsSection } from "./useSettingsNavigation.ts";

function navigation({ itemLeft, itemWidth = 116, width = 357, scrollLeft = 0, scale = 1, current = true, scrollWidth = 1065 }: {
  itemLeft: number; itemWidth?: number; width?: number; scrollLeft?: number; scale?: number; current?: boolean; scrollWidth?: number;
}) {
  const origin = 16.5;
  const rail = {
    clientWidth: width, offsetWidth: width, clientLeft: 0, scrollWidth, scrollLeft, scrollTop: 23,
    getBoundingClientRect: () => ({ left: origin, width: width * scale }),
    querySelector: () => current ? {
      getBoundingClientRect: () => ({ left: origin + (itemLeft - rail.scrollLeft) * scale, right: origin + (itemLeft + itemWidth - rail.scrollLeft) * scale }),
      focus: () => assert.fail("revealing a section must not change focus"),
      scrollIntoView: () => assert.fail("ancestor scrolling must not be used"),
    } : null,
  };
  return rail;
}

test("narrow settings reveal offscreen sections using only the required horizontal rail movement", () => {
  const rail = navigation({ itemLeft: 865 });
  revealCurrentSettingsSection(rail as unknown as HTMLElement);
  assert.equal(rail.scrollLeft, 624);
  assert.equal(rail.scrollTop, 23);
  revealCurrentSettingsSection(rail as unknown as HTMLElement);
  assert.equal(rail.scrollLeft, 624, "already visible sections retain the user's position");

  const earlier = navigation({ itemLeft: 135, scrollLeft: 624 });
  revealCurrentSettingsSection(earlier as unknown as HTMLElement);
  assert.equal(earlier.scrollLeft, 135, "switching to an earlier section reveals its start");
});

test("dialog scale transitions do not leave the selected section clipped", () => {
  const rail = navigation({ itemLeft: 865, scale: 0.98 });
  revealCurrentSettingsSection(rail as unknown as HTMLElement);
  assert.ok(Math.abs(rail.scrollLeft - 624) < 0.001);
});

test("desktop, hidden and unselected navigation need no scrolling", () => {
  for (const rail of [
    navigation({ itemLeft: 0, width: 196, scrollWidth: 196 }),
    navigation({ itemLeft: 865, width: 0 }),
    navigation({ itemLeft: 865, current: false }),
  ]) {
    revealCurrentSettingsSection(rail as unknown as HTMLElement);
    assert.equal(rail.scrollLeft, 0);
    assert.equal(rail.scrollTop, 23);
  }
});
