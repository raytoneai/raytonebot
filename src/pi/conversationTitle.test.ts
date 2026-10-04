import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanTitle, summarizeConversationTitle } from "./conversationTitle.ts";

test("titles lose quotes, labels, trailing punctuation and extra lines", () => {
  assert.equal(cleanTitle("「季度销售报告分析」。\n解释"), "季度销售报告分析");
  assert.equal(cleanTitle('Title: "Fix the login bug."'), "Fix the login bug");
  assert.equal(cleanTitle("**部署检查**"), "部署检查");
  assert.equal(cleanTitle("  \n  "), undefined);
  assert.equal(cleanTitle("x".repeat(60))?.length, 43);
});

test("OpenAI-compatible and Anthropic services are asked once with the first message", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (body: unknown, status = 200): typeof fetch => async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify(body), { status });
  };
  assert.equal(await summarizeConversationTitle({ baseUrl: "https://api.example.com/v1/", protocol: "openai-compatible" }, "k1", "m1",
    "帮我分析季度销售", reply({ choices: [{ message: { content: "季度销售分析" } }] })), "季度销售分析");
  assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer k1");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "m1");
  assert.equal(body.messages[1].content, "帮我分析季度销售");

  assert.equal(await summarizeConversationTitle({ baseUrl: "https://api.anthropic.example/v1", protocol: "anthropic" }, "k2", "m2",
    "fix login", reply({ content: [{ type: "text", text: "Fix login" }] })), "Fix login");
  assert.equal(calls[1].url, "https://api.anthropic.example/v1/messages");
  assert.equal((calls[1].init.headers as Record<string, string>)["x-api-key"], "k2");

  assert.equal(await summarizeConversationTitle({ baseUrl: "https://api.example.com/v1", protocol: "openai-compatible" }, "k", "m",
    "hi", reply({ error: "no" }, 401)), undefined);
  assert.equal(await summarizeConversationTitle({ baseUrl: "http://localhost:11434", protocol: "ollama-native" }, undefined, "m",
    "hi", reply({})), undefined);
  assert.equal(calls.length, 3);
});
