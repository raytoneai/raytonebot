import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrowserInputQueue, framePoint, keyInput, mouseButton } from "./browserView.ts";

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

test("slow links coalesce motion and text without queuing one RTT per event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: Array<import("../pi/browser/browserProtocol.ts").BrowserInput[]> = [];
  const complete: Array<() => void> = [];
  const errors: unknown[] = [];
  const queue = createBrowserInputQueue((batch) => { sent.push(batch); return new Promise((resolve) => complete.push(resolve)); }, (error) => errors.push(error));
  queue.input({ kind: "mouse", type: "move", x: 1, y: 1 });
  t.mock.timers.tick(16);
  for (let x = 2; x <= 100; x++) queue.input({ kind: "mouse", type: "move", x, y: 20 });
  queue.input({ kind: "mouse", type: "down", x: 100, y: 20, button: "left" });
  queue.input({ kind: "mouse", type: "up", x: 100, y: 20, button: "left" });
  for (const text of "hello") queue.input({ kind: "text", text });
  queue.input({ kind: "key", type: "down", key: "Enter" });
  queue.input({ kind: "key", type: "up", key: "Enter" });
  assert.equal(sent.length, 1, "only one request may be in flight");
  complete.shift()!(); await Promise.resolve(); t.mock.timers.tick(16);
  assert.deepEqual(sent[1], [
    { kind: "mouse", type: "move", x: 100, y: 20 },
    { kind: "mouse", type: "down", x: 100, y: 20, button: "left" },
    { kind: "mouse", type: "up", x: 100, y: 20, button: "left" },
    { kind: "text", text: "hello" },
    { kind: "key", type: "down", key: "Enter" },
    { kind: "key", type: "up", key: "Enter" },
  ]);
  assert.deepEqual(errors, []);
  queue.reset();
});

test("reset aborts in-flight input and failed input is never silently replayed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors: unknown[] = [];
  let signal: AbortSignal | undefined;
  let reject: (error: Error) => void = () => {};
  let calls = 0;
  const queue = createBrowserInputQueue((_batch, next) => { signal = next; calls++; return new Promise((_resolve, fail) => { reject = fail; }); }, (error) => errors.push(error));
  queue.input({ kind: "text", text: "a" }); t.mock.timers.tick(16);
  queue.input({ kind: "text", text: "b" });
  reject(new Error("connection lost")); await Promise.resolve(); t.mock.timers.tick(1000);
  assert.equal(calls, 1); assert.equal(errors.length, 1);
  queue.input({ kind: "text", text: "c" }); t.mock.timers.tick(16);
  queue.reset(); assert.equal(signal?.aborted, true);
  t.mock.timers.tick(1000); assert.equal(calls, 2);
});
