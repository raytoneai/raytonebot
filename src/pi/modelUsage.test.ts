import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createModelUsageTap, createModelUsageTracker } from "./modelUsage.ts";
import { createModelGateway } from "./runtime/modelGateway.ts";
import type { ModelUsage } from "./usageTypes.ts";

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const split = (value: string, size = 3): Buffer[] => {
  const bytes = Buffer.from(value);
  return Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => bytes.subarray(index * size, (index + 1) * size));
};
const parse = (value: string, protocol: "openai" | "anthropic" = "openai", streaming = true, complete = true) => {
  const parser = createModelUsageTracker({ protocol, contentType: streaming ? "text/event-stream" : "application/json" });
  for (const chunk of split(value)) parser.write(chunk);
  return parser.finish(complete);
};

test("chat and Responses split SSE usage replaces cumulative totals and preserves explicit zero", () => {
  const chat = event({ choices: [{ delta: { content: "你好 usage: not metadata" } }] })
    + event({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 } } })
    + event({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 } } }) + "data: [DONE]\n\n";
  assert.deepEqual(parse(chat), { source: "gateway", complete: true, inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 });
  const responses = event({ type: "response.completed", response: { usage: { input_tokens: 80, output_tokens: 0, input_tokens_details: { cached_tokens: 40 } } } });
  assert.deepEqual(parse(responses), { source: "gateway", complete: true, inputTokens: 80, outputTokens: 0, cacheReadTokens: 40 });
  assert.deepEqual(parse(event({ usage: { prompt_tokens: 40, completion_tokens: 5, prompt_cache_hit_tokens: 10 } })),
    { source: "gateway", complete: true, inputTokens: 40, outputTokens: 5, cacheReadTokens: 10 });
});

test("Anthropic start and delta use cumulative replacement and include cache subsets once", () => {
  const start = event({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 } } });
  const stream = start + event({ type: "message_delta", usage: { output_tokens: 8 } })
    + event({ type: "message_delta", usage: { output_tokens: 12 } }) + event({ type: "message_stop" });
  assert.deepEqual(parse(stream, "anthropic"), { source: "gateway", complete: true, inputTokens: 110, outputTokens: 12, cacheReadTokens: 80, cacheWriteTokens: 20 });
  assert.deepEqual(parse(start, "anthropic", true, false), { source: "gateway", complete: false, inputTokens: 110, outputTokens: 0, cacheReadTokens: 80, cacheWriteTokens: 20 });
  assert.deepEqual(parse(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2 } }), "anthropic", false),
    { source: "gateway", complete: false, inputTokens: 10, outputTokens: 2 }, "unreported Anthropic cache components cannot make a complete input total");
});

test("plain JSON extracts usage after large content without retaining response content or nested tool usage", () => {
  const response = JSON.stringify({ choices: [{ message: { content: "private response text ".repeat(100_000), tool_calls: [{ usage: { prompt_tokens: 999 } }] } }],
    usage: { prompt_tokens: 42, completion_tokens: 9 } });
  const parser = createModelUsageTracker({ protocol: "openai", contentType: "application/json" });
  for (const chunk of split(response, 16_384)) parser.write(chunk);
  assert.deepEqual(parser.finish(true), { source: "gateway", complete: true, inputTokens: 42, outputTokens: 9 });
  assert.deepEqual(parse(JSON.stringify({ type: "message", content: [], usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } }), "anthropic", false),
    { source: "gateway", complete: true, inputTokens: 6, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 });
});

test("missing, invalid, oversized and truncated usage stays unknown or partial", () => {
  for (const payload of [event({ choices: [] }), event({ usage: { prompt_tokens: -1, completion_tokens: "5" } }), event({ usage: { prompt_tokens: null } }), "data: invalid\n\n"]) {
    assert.deepEqual(parse(payload), { source: "gateway", complete: false });
  }
  const huge = event({ content: "x".repeat(300_000), usage: { prompt_tokens: 4, completion_tokens: 2 } });
  assert.deepEqual(parse(huge), { source: "gateway", complete: false });
  assert.deepEqual(parse(huge + event({ usage: { prompt_tokens: 20, completion_tokens: 7 } })), { source: "gateway", complete: true, inputTokens: 20, outputTokens: 7 });
  assert.deepEqual(parse(event({ usage: { prompt_tokens: 4 } })), { source: "gateway", complete: false, inputTokens: 4 });
  assert.deepEqual(parse(event({ usage: { prompt_tokens: 4, completion_tokens: 2 } }), "openai", true, false),
    { source: "gateway", complete: false, inputTokens: 4, outputTokens: 2 });
});

test("SSE CRLF boundaries and multiline data survive arbitrary chunk splits", () => {
  assert.deepEqual(parse('event: response.completed\r\ndata: {"usage":\r\ndata: {"prompt_tokens":3,"completion_tokens":4}}\r\n\r\n'),
    { source: "gateway", complete: true, inputTokens: 3, outputTokens: 4 });
});

test("usage tap preserves exact bytes with a slow writable and bounded upstream reads", async () => {
  const payload = event({ choices: [{ delta: { content: "多字节内容" } }] }) + event({ usage: { prompt_tokens: 5, completion_tokens: 6 } });
  const chunks = split(payload, 7), output: Buffer[] = [];
  const tap = createModelUsageTap({ protocol: "openai", contentType: "text/event-stream" });
  await pipeline(Readable.from(chunks, { highWaterMark: 1 }), tap.stream, new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    output.push(Buffer.from(chunk)); setImmediate(callback);
  } }));
  assert.deepEqual(Buffer.concat(output), Buffer.from(payload));
  assert.deepEqual(tap.finish(true), { source: "gateway", complete: true, inputTokens: 5, outputTokens: 6 });
});

test("gateway emits one usage result per generation fetch, never for counting, without changing response bytes", async () => {
  const payload = event({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } } })
    + event({ type: "message_delta", usage: { output_tokens: 3 } }) + event({ type: "message_stop" });
  const received: { id: string; usage: ModelUsage }[] = [];
  const gateway = await createModelGateway({ port: 0, fetcher: (async (url) => String(url).endsWith("count_tokens")
    ? new Response('{"input_tokens":7}', { headers: { "content-type": "application/json" } })
    : new Response(new ReadableStream({ start(controller) { for (const chunk of split(payload, 5)) controller.enqueue(chunk); controller.close(); } }),
      { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
  try {
    const lease = gateway.issue({ baseUrl: "https://model.example", apiKey: "private-key", model: "model", protocol: "anthropic",
      onUsage(id, usage) { received.push({ id, usage }); } });
    const request = (path: string) => fetch(`${lease.baseUrl}${path}`, { method: "POST", headers: { "x-api-key": lease.apiKey }, body: JSON.stringify({ model: "model" }) });
    assert.equal(await (await request("/messages/count_tokens")).text(), '{"input_tokens":7}');
    assert.equal(received.length, 0);
    for (let index = 0; index < 2; index++) assert.equal(await (await request("/messages")).text(), payload);
    assert.equal(received.length, 2);
    assert.notEqual(received[0].id, received[1].id);
    assert.deepEqual(received[0].usage, { source: "gateway", complete: true, inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0 });
    assert.ok(!JSON.stringify(received).includes("private-key"));
    lease.revoke();
  } finally { await gateway.close(); }
});

test("gateway reports unknown failed requests and telemetry callback errors cannot fail a response", async () => {
  let calls = 0;
  const received: ModelUsage[] = [];
  const gateway = await createModelGateway({ port: 0, fetcher: (async () => {
    calls++;
    return calls === 1 ? new Response('{"error":{"message":"failed"}}', { status: 500 }) : new Response('{"usage":{"prompt_tokens":1,"completion_tokens":2}}');
  }) as typeof fetch });
  try {
    const lease = gateway.issue({ baseUrl: "https://model.example", apiKey: "private", model: "model", protocol: "openai",
      onUsage(_id, usage) { received.push(usage); throw new Error("telemetry unavailable"); } });
    const request = () => fetch(`${lease.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${lease.apiKey}` }, body: JSON.stringify({ model: "model" }) });
    assert.equal((await request()).status, 500);
    assert.equal(await (await request()).text(), '{"usage":{"prompt_tokens":1,"completion_tokens":2}}');
    assert.equal(calls, 2);
    assert.deepEqual(received, [{ source: "gateway", complete: false }, { source: "gateway", complete: true, inputTokens: 1, outputTokens: 2 }]);
  } finally { await gateway.close(); }
});

test("an interrupted upstream stream reports its known partial usage once", async () => {
  let disconnect!: () => void;
  const received: ModelUsage[] = [];
  let reported!: () => void;
  const report = new Promise<void>(resolve => { reported = resolve; });
  const payload = event({ type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 } } });
  const gateway = await createModelGateway({ port: 0, fetcher: (async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(payload)); disconnect = () => controller.error(new Error("upstream disconnected"));
  } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
  try {
    const lease = gateway.issue({ baseUrl: "https://model.example", apiKey: "private", model: "model", protocol: "anthropic",
      onUsage(_id, usage) { received.push(usage); reported(); } });
    const response = await fetch(`${lease.baseUrl}/messages`, { method: "POST", headers: { "x-api-key": lease.apiKey }, body: JSON.stringify({ model: "model" }) });
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), payload);
    disconnect();
    await assert.rejects(reader.read()); await report;
    assert.deepEqual(received, [{ source: "gateway", complete: false, inputTokens: 9, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 0 }]);
  } finally { await gateway.close(); }
});
