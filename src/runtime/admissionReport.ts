import type { AgentUXEvent } from "@agent-ux/protocol";
import {
  formatContractReport,
  inspectAgentUXEvents,
  type ContractReport,
} from "./eventContract.ts";
import {
  normalizeAgentUXEvents,
  summarizeRejections,
  type NormalizeOptions,
  type NormalizeResult,
} from "./eventNormalizer.ts";

/**
 * Read-only admission/contract preview for a replay stream. The shell runs it only for devtools;
 * its returned events are never fed back into replay, storage, or cursors.
 */

export type Admission = {
  /** Events retained by this diagnostic preview; not a replacement for the actual replay. */
  events: AgentUXEvent[];
  normalize: NormalizeResult;
  contract: ContractReport;
};

export type AdmissionSeverity = "ok" | "degraded" | "blocked";

export function admitEvents(
  input: readonly unknown[],
  options: NormalizeOptions = {},
): Admission {
  const normalize = normalizeAgentUXEvents(input, options);
  const contract = inspectAgentUXEvents(normalize.events, {
    extraDiagnosticMarkers: options.diagnosticMarkers,
  });
  return { events: normalize.events, normalize, contract };
}

/**
 * How bad it is.
 *
 * - `blocked` — the preview retained no renderable events.
 * - `degraded` — the preview found an incomplete surface or events it would hold back.
 * - `ok` — nothing to say.
 */
export function admissionSeverity(admission: Admission): AdmissionSeverity {
  const received = admission.normalize.allEvents.length;
  if (received > 0 && admission.events.length === 0) return "blocked";
  if (admission.normalize.rejected.length > 0) return "degraded";
  if (admission.normalize.undesignedTools.length > 0) return "degraded";
  if (admission.contract.issues.some((issue) => issue.severity === "error")) return "degraded";
  return "ok";
}

/** Whether there is anything worth telling a developer about. */
export function hasAdmissionFindings(admission: Admission): boolean {
  return admissionSeverity(admission) !== "ok";
}

/**
 * A readable account of what the diagnostic preview retained, held back, derived, or rewrote.
 */
export function describeAdmission(admission: Admission): string {
  const { normalize, contract } = admission;
  const counts = summarizeRejections(normalize.rejected);
  const lines: string[] = [];

  lines.push(
    `只读诊断预演：收到 ${normalize.allEvents.length} 个事件，预演保留 ${normalize.events.length} 个` +
      (normalize.rejected.length > 0 ? `，标记 ${normalize.rejected.length} 个待适配。` : "。"),
  );

  if (counts["unknown-type"] > 0) {
    lines.push(
      `  ${counts["unknown-type"]} 个事件类型不在协议里 —— 适配器可把它们映射成标准类型。`,
    );
    for (const item of firstFew(normalize.rejected, "unknown-type")) {
      lines.push(`    ${item.detail}`);
    }
  }
  if (normalize.undesignedTools.length > 0) {
    lines.push(`  ${normalize.undesignedTools.length} 个工具调用没有匹配现有呈现概念（预演保留）：`);
    for (const item of normalize.undesignedTools.slice(0, 5)) {
      lines.push(`    ${item.name}`);
    }
    lines.push("    想让它拿到设计过的卡片：在 runtime/eventNormalizer.ts 的 TOOL_CONCEPT_ALIASES 里补别名，");
    lines.push("    或在该厂商的映射表里加 extraAliases。加别名不需要改组件。");
  }
  if (counts["unrenderable-concept"] > 0) {
    lines.push(
      `  ${counts["unrenderable-concept"]} 个原始计划工具事件未纳入诊断副本（计划内容由现有产物投影呈现）。`,
    );
  }
  if (counts.diagnostic > 0) {
    lines.push(`  ${counts.diagnostic} 个事件是后端的记账信息（token 计费、运行时配置等），预演标记为诊断信息。`);
  }

  if (normalize.derivedArtifacts.length > 0) {
    lines.push(`  预演推导出 ${normalize.derivedArtifacts.length} 个产物（后端没发 artifact 事件）：`);
    for (const item of normalize.derivedArtifacts.slice(0, 5)) {
      lines.push(`    ${item.path}`);
    }
  }
  if (normalize.canonicalizedNames.length > 0) {
    lines.push(`  ${normalize.canonicalizedNames.length} 个工具名预演规范为组件认识的拼写：`);
    for (const item of normalize.canonicalizedNames.slice(0, 5)) {
      lines.push(`    ${item.from} → ${item.to}`);
    }
  }
  if (normalize.normalizedTitles.length > 0) {
    lines.push(`  ${normalize.normalizedTitles.length} 个标题预演从原始 args JSON 重建。`);
  }

  lines.push("");
  lines.push(formatContractReport(contract));
  return lines.join("\n");
}

function firstFew(
  rejected: NormalizeResult["rejected"],
  reason: NormalizeResult["rejected"][number]["reason"],
  limit = 5,
) {
  return rejected.filter((item) => item.reason === reason).slice(0, limit);
}
