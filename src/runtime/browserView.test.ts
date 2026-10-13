import assert from "node:assert/strict";
import { test } from "node:test";

import { framePoint, keyInput, mouseButton } from "./browserView.ts";

test("a click on the live view maps through the letterbox into page pixels", () => {
  const frame = { width: 1280, height: 800 };
  // 640×600 box: the frame is drawn 640×400, with 100 px bars above and below.
  const box = { left: 10, top: 20, width: 640, height: 600 };
  assert.deepEqual(framePoint(10, 120, box, frame), { x: 0, y: 0 });
  assert.deepEqual(framePoint(330, 320, box, frame), { x: 640, y: 400 });
  assert.deepEqual(framePoint(650, 520, box, frame), { x: 1280, y: 800 });
  assert.equal(framePoint(330, 60, box, frame), undefined, "the bar above the frame");
  assert.equal(framePoint(330, 320, box, { width: 0, height: 0 }), undefined, "no frame yet");
});

test("named keys are pressed, text goes through input, composition waits", () => {
  assert.deepEqual(keyInput("down", { key: "Enter" }), { kind: "key", type: "down", key: "Enter" });
  assert.equal(keyInput("down", { key: "a" }), undefined);
  assert.equal(keyInput("down", { key: "Enter", isComposing: true }), undefined);
  assert.deepEqual([0, 1, 2].map(mouseButton), ["left", "middle", "right"]);
});
