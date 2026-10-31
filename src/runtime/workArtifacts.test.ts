import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentUXTimelineItem } from "@agent-ux/render-core";
import { workArtifacts } from "./workArtifacts.ts";
const artifact = (id: string, title: string, uri?: string, artifactKind = "code") => ({ kind: "artifact", id, title, uri, artifactKind, status: "success" }) as AgentUXTimelineItem;

test("deliverables exclude plans, source, directory snapshots and unsaved diffs; latest file wins", () => {
  const files = workArtifacts([
    artifact('plan_run', 'Plan.md'), artifact('["r","artifactId","plan_run"]', 'Plan.md'),
    artifact('code', 'src/App.tsx', 'file:///src/App.tsx'), artifact('listing', 'workspace', undefined, 'data'),
    artifact('old', 'report.md', 'file:///report.md'), artifact('html', 'page.html', 'file:///page.html'),
    artifact('audio', 'demo.wav', 'file:///demo.wav'), artifact('new', 'report.md', 'file:///report.md', 'diff'),
    artifact('diff', 'preview.md', undefined, 'diff'),
  ]);
  assert.deepEqual(files.map((item) => item.id), ['new', 'html', 'audio']);
});

test("saved versions keep same-path A/B deliveries instead of path de-duplicating them", () => {
  const versionA = artifact("published_version_11111111-1111-1111-1111-111111111111", "report.md", "file:///report.md");
  const versionB = artifact("published_version_22222222-2222-2222-2222-222222222222", "report.md", "file:///report.md");
  const current = artifact("current", "report.md", "file:///report.md");
  assert.deepEqual(workArtifacts([versionA, versionB, current]).map(item => item.id), [versionA.id, versionB.id, current.id]);
});
