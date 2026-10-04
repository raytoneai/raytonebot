import type { AgentUXToolTimelineItem } from "@agent-ux/render-core";
import { chatCopy } from "../i18n/copy/chat.ts";
import { APP_LOCALES, type AppLocale } from "../i18n/locales.ts";
import { resolveToolConcept } from "./eventNormalizer.ts";

const actionKeys = {
  "read-file": "readFile", "read-image": "readImage", "modify-file": "modifyFile",
  "edit-file": "editFile", validate: "validate", search: "search", "run-command": "runCommand",
} as const;
export type ToolAction = keyof typeof actionKeys;

export function toolAction(tool: AgentUXToolTimelineItem): ToolAction | undefined {
  const concept = resolveToolConcept(tool.name);
  if (concept === "write-file") return "modify-file";
  return concept && concept in actionKeys ? concept as ToolAction : undefined;
}

export const isRunningTool = (tool: AgentUXToolTimelineItem) =>
  tool.status === "running" || tool.status === "args_streaming";

const runningTitles = APP_LOCALES.flatMap((locale) => Object.values(chatCopy[locale].toolCard.runningAction));

export function toolHeaderTitle(tool: AgentUXToolTimelineItem, locale: AppLocale): string {
  const copy = chatCopy[locale].toolCard;
  const action = toolAction(tool);
  if (action && tool.status === "running") return copy.runningAction[actionKeys[action]];
  // An old running title is not evidence that a finished or refused call is still executing.
  const staleTitle = tool.title && (runningTitles.some((label) => tool.title!.startsWith(label))
    || /^(正在|取消|Reading\b|Modifying\b|Editing\b|Validating\b|Searching\b|Running\b|Cancelled\b)/.test(tool.title));
  const label = action ? copy.action[actionKeys[action]] : staleTitle ? tool.name : tool.title || tool.name;
  const status = copy.state[tool.status as keyof typeof copy.state];
  return status ? `${label} · ${status}` : label;
}
