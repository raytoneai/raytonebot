import assert from "node:assert/strict";
import { test } from "node:test";
import { sameOutputPanelItem } from "./useOutputPanel.ts";

const live = (id: string) => ({ id, kind: "file" as const, title: "report.md", workspacePath: "/work/report.md" });
const saved = (id: string) => ({ ...live("artifact:" + id), artifactId: id, versionSelection: "version" as const });

test("output tabs merge ordinary live paths but keep distinct saved versions", () => {
  assert.equal(sameOutputPanelItem(live("file:report.md"), live("file:report.md")), true);
  assert.equal(sameOutputPanelItem(live("file:old"), live("file:new")), true);
  assert.equal(sameOutputPanelItem(saved("published_version_11111111-1111-1111-1111-111111111111"), saved("published_version_11111111-1111-1111-1111-111111111111")), true);
  assert.equal(sameOutputPanelItem(saved("published_version_11111111-1111-1111-1111-111111111111"), saved("published_version_22222222-2222-2222-2222-222222222222")), false);
  assert.equal(sameOutputPanelItem(saved("published_version_11111111-1111-1111-1111-111111111111"), live("file:current")), false);
});

test("a current revision keeps its saved origin separate from an ordinary path tab", () => {
  const origin = "published_version_11111111-1111-1111-1111-111111111111";
  const current = {
    ...live("artifact:" + origin),
    artifactId: "ordinary_write",
    versionOriginArtifactId: origin,
    versionSelection: "current" as const,
  };
  assert.equal(sameOutputPanelItem(current, live("file:report.md")), false);
  assert.equal(sameOutputPanelItem(current, { ...current, artifactId: "ordinary_write-2" }), true);
});
