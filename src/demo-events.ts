import type { AgentUXEvent } from "@agent-ux/protocol";
import { parseAgentUXEventJSONL } from "@agent-ux/runtime";

import { SCENARIOS, toAgentUXEvents } from "./agentmatrix";
import { parsePreviewFixture, previewFixtures } from "./preview/fixtures";

const builtinJsonl = "{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_1\",\"runId\":\"exported_fixture\",\"seq\":1,\"ts\":1,\"type\":\"run.started\",\"payload\":{\"title\":\"Add validation to the search input\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_2\",\"runId\":\"exported_fixture\",\"seq\":2,\"ts\":2,\"type\":\"text.started\",\"payload\":{\"textId\":\"txt_user\",\"role\":\"user\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_3\",\"runId\":\"exported_fixture\",\"seq\":3,\"ts\":3,\"type\":\"text.delta\",\"payload\":{\"textId\":\"txt_user\",\"delta\":\"Add input validation to the search box, then show me the patch.\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_4\",\"runId\":\"exported_fixture\",\"seq\":4,\"ts\":4,\"type\":\"text.finished\",\"payload\":{\"textId\":\"txt_user\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_5\",\"runId\":\"exported_fixture\",\"seq\":5,\"ts\":5,\"type\":\"reasoning.status\",\"payload\":{\"reasoningId\":\"rsn_1\",\"status\":\"planning\",\"label\":\"Thinking\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_6\",\"runId\":\"exported_fixture\",\"seq\":6,\"ts\":6,\"type\":\"reasoning.delta\",\"payload\":{\"reasoningId\":\"rsn_1\",\"kind\":\"summary\",\"delta\":\"Read the current SearchInput, then add a validity check and loading state before wiring the request.\",\"format\":\"plain\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_7\",\"runId\":\"exported_fixture\",\"seq\":7,\"ts\":7,\"type\":\"reasoning.finished\",\"payload\":{\"reasoningId\":\"rsn_1\",\"collapsedByDefault\":true}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_8\",\"runId\":\"exported_fixture\",\"seq\":8,\"ts\":8,\"type\":\"tool.call.started\",\"payload\":{\"toolCallId\":\"tool_edit\",\"name\":\"edit_file\",\"title\":\"Patch SearchInput.tsx\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_9\",\"runId\":\"exported_fixture\",\"seq\":9,\"ts\":9,\"type\":\"tool.call.running\",\"payload\":{\"toolCallId\":\"tool_edit\",\"args\":{\"path\":\"src/components/SearchInput.tsx\"}}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_10\",\"runId\":\"exported_fixture\",\"seq\":10,\"ts\":10,\"type\":\"tool.call.result\",\"payload\":{\"toolCallId\":\"tool_edit\",\"result\":{\"changed\":true,\"insertions\":18,\"deletions\":4},\"resultPreview\":\"+18 -4\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_11\",\"runId\":\"exported_fixture\",\"seq\":11,\"ts\":11,\"type\":\"tool.call.finished\",\"payload\":{\"toolCallId\":\"tool_edit\",\"status\":\"success\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_12\",\"runId\":\"exported_fixture\",\"seq\":12,\"ts\":12,\"type\":\"artifact.created\",\"payload\":{\"artifactId\":\"art_patch\",\"kind\":\"code\",\"title\":\"SearchInput.tsx\",\"mimeType\":\"text/typescript\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_13\",\"runId\":\"exported_fixture\",\"seq\":13,\"ts\":13,\"type\":\"artifact.delta\",\"payload\":{\"artifactId\":\"art_patch\",\"format\":\"text\",\"delta\":\"const isValid = query.trim().length >= 2;\\n\\nasync function handleSearch() {\\n  if (!isValid || loading) return;\\n  setLoading(true);\\n  setError(null);\\n  try {\\n    await fetchResults(query.trim());\\n  } catch {\\n    setError(\\\"Failed to fetch results.\\\");\\n  } finally {\\n    setLoading(false);\\n  }\\n}\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_14\",\"runId\":\"exported_fixture\",\"seq\":14,\"ts\":14,\"type\":\"artifact.finished\",\"payload\":{\"artifactId\":\"art_patch\",\"status\":\"success\",\"uri\":\"memory://search-input\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_15\",\"runId\":\"exported_fixture\",\"seq\":15,\"ts\":15,\"type\":\"text.started\",\"payload\":{\"textId\":\"txt_assistant\",\"role\":\"assistant\",\"format\":\"markdown\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_16\",\"runId\":\"exported_fixture\",\"seq\":16,\"ts\":16,\"type\":\"text.delta\",\"payload\":{\"textId\":\"txt_assistant\",\"delta\":\"Validation and loading state added. The search button is disabled for invalid input and a spinner shows while results load.\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_17\",\"runId\":\"exported_fixture\",\"seq\":17,\"ts\":17,\"type\":\"text.finished\",\"payload\":{\"textId\":\"txt_assistant\"}}\n{\"protocol\":\"agent-ux\",\"version\":\"0.1\",\"id\":\"evt_18\",\"runId\":\"exported_fixture\",\"seq\":18,\"ts\":18,\"type\":\"run.finished\",\"payload\":{\"status\":\"success\"}}";

export type EventStream = {
  id: string;
  label: string;
  load: () => AgentUXEvent[];
};

/**
 * Every event stream bundled with this export, so each UI state (reasoning, tool
 * approval, retry, error, interrupt, artifacts, capabilities…) can actually be seen
 * and checked against the AgentCanvas preview. Use ?stream=<id> directly, or add
 * ?devtools=1 in development to reveal the fixture picker.
 *
 * - "Built-in demo" is the single happy-path run the exporter always ships.
 * - The AgentUX fixtures are the same JSONL the configurator previews.
 * - The AgentMatrix scenarios are converted through the same legacy adapter the
 *   configurator uses (`toAgentUXEvents`).
 */
export const eventStreams: EventStream[] = [
  {
    id: "builtin-demo",
    label: "Built-in demo",
    load: () => parseAgentUXEventJSONL(builtinJsonl),
  },
  ...previewFixtures.map((fixture) => ({
    id: "fixture:" + fixture.id,
    label: fixture.label,
    load: () => parsePreviewFixture(fixture),
  })),
  ...SCENARIOS.map((scenario) => ({
    id: "scenario:" + scenario.id,
    label: scenario.title,
    load: () => toAgentUXEvents(scenario.fixture.events, { title: scenario.title }) as unknown as AgentUXEvent[],
  })),
];

export function demoEvents(): AgentUXEvent[] {
  return eventStreams[0].load();
}
