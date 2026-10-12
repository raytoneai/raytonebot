import assert from "node:assert/strict";
import test from "node:test";
import { ARTIFACT_PROMPT_LIMIT, ARTIFACT_BRIDGE_SCRIPT, parseArtifactRequest } from "./artifactBridge.ts";
import { htmlPreviewDocument } from "../components/agent-preview/outputframe/htmlPreview.ts";

const msg = (type: unknown, value: unknown) => ({ raytoneArtifact: 1, type, value });

test("artifact requests: only tagged messages, trimmed bounded prompts and https links", () => {
  assert.equal(parseArtifactRequest({ type: "prompt", value: "hi" }), undefined);
  assert.equal(parseArtifactRequest("prompt"), undefined);
  assert.deepEqual(parseArtifactRequest(msg("prompt", "  compare plan B  ")), { kind: "prompt", text: "compare plan B" });
  assert.ok("error" in parseArtifactRequest(msg("prompt", "   "))!);
  assert.ok("error" in parseArtifactRequest(msg("prompt", "x".repeat(ARTIFACT_PROMPT_LIMIT + 1)))!);
  assert.ok("error" in parseArtifactRequest(msg("prompt", { text: "hi" }))!);
  assert.deepEqual(parseArtifactRequest(msg("link", "https://example.com/a")), { kind: "link", url: "https://example.com/a" });
  for (const url of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "not a url"]) {
    assert.ok("error" in parseArtifactRequest(msg("link", url))!, url);
  }
  assert.ok("error" in parseArtifactRequest(msg("eval", "x"))!);
});

test("the bridge runs after the policy and before the artifact's own scripts", () => {
  const document = htmlPreviewDocument("<script>raytone.sendPrompt('x')</script>");
  const policy = document.indexOf("Content-Security-Policy");
  const bridge = document.indexOf(ARTIFACT_BRIDGE_SCRIPT);
  assert.ok(policy > 0 && bridge > policy && bridge < document.indexOf("raytone.sendPrompt('x')"));
  assert.doesNotThrow(() => new Function(ARTIFACT_BRIDGE_SCRIPT));
});
