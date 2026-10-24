import assert from "node:assert/strict";
import { test } from "node:test";
import { providerErrorMessage } from "./runtime/providerError.ts";

test("provider JSON errors retain actionable details without credentials or unrelated fields", async () => {
  const secret = "private-provider-key", lease = "private-lease-key";
  const response = new Response(JSON.stringify({ error: { message: `Invalid tools: unsupported type in parameters. ${secret} ${lease}`, headers: { authorization: "unrelated-secret" } } }), { status: 400 });
  const message = await providerErrorMessage(response, [secret, lease]);
  assert.match(message, /HTTP 400.*Invalid tools: unsupported type/);
  assert.doesNotMatch(message, /private-provider-key|private-lease-key|unrelated-secret/);
  const encoded = new Response(JSON.stringify({ error: { message: `bad ${encodeURIComponent('key+/=')} ${Buffer.from('key+/=').toString('base64')}` } }), { status: 400 });
  assert.doesNotMatch(await providerErrorMessage(encoded, ['key+/=']), /key%2B%2F%3D|a2V5Ky89/);
});

test("provider errors reject HTML, oversized and stalled bodies and hide auth details", async () => {
  for (const body of ['<html>private proxy page</html>', JSON.stringify({ error: { message: 'a'.repeat(20_000) } }), JSON.stringify({ error: { message: 123 } })]) {
    assert.equal(await providerErrorMessage(new Response(body, {status:400}), []), 'Model provider returned HTTP 400.');
  }
  const auth = await providerErrorMessage(new Response(JSON.stringify({error:{message:'private credentials'}}), {status:401}), []);
  assert.doesNotMatch(auth, /private credentials/);
  let canceled = false;
  const stream = new ReadableStream({ cancel() { canceled = true; } });
  assert.equal(await providerErrorMessage(new Response(stream, {status:400}), [], 15), 'Model provider returned HTTP 400.');
  assert.equal(canceled, true);
  const long = await providerErrorMessage(new Response(JSON.stringify({error:{message:'x'.repeat(900)}}), {status:400}), []);
  assert.ok(long.length < 700);
});

test("model gateway forwards sanitized upstream reasons with the original HTTP status", async () => {
  const { createModelGateway } = await import('./runtime/modelGateway.ts');
  const gateway = await createModelGateway({ port: 0, fetcher: (async () => new Response(JSON.stringify({
    error: { message: 'Unknown field store. Credential: private-upstream-key', status: 'INVALID_ARGUMENT' },
  }), { status: 400, headers: { 'content-type': 'application/json', 'set-cookie': 'private-cookie' } })) as typeof fetch });
  try {
    const lease = gateway.issue({baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai', apiKey:'private-upstream-key', model:'gemini-3.8-flash', protocol:'openai'});
    const response = await fetch(`${lease.baseUrl}/chat/completions`, {method:'POST', headers:{authorization:`Bearer ${lease.apiKey}`}, body:JSON.stringify({model:'gemini-3.8-flash'})});
    assert.equal(response.status, 400);
    assert.equal(response.headers.has('set-cookie'), false);
    const message = (await response.json()).error.message;
    assert.match(message, /Unknown field store/);
    assert.doesNotMatch(message, /private-upstream-key|private-cookie/);
  } finally { await gateway.close(); }
});

test("Google OpenAI compatibility array errors retain the upstream diagnostic", async () => {
  const response = new Response(JSON.stringify([{error:{code:400,message:'Missing or invalid Authorization header.',status:'INVALID_ARGUMENT'}}]), {status:400});
  assert.match(await providerErrorMessage(response, []), /Missing or invalid Authorization header/);
});
