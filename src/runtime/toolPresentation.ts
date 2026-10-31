import type { AgentUXToolTimelineItem } from "@agent-ux/render-core";
import { chatCopy } from "../i18n/copy/chat.ts";
import { APP_LOCALES, type AppLocale } from "../i18n/locales.ts";
import { resolveToolConcept } from "./eventNormalizer.ts";
import { buildToolDisplaySpec } from "./toolDisplaySpec.ts";

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
  return status ? `${label}${locale === "en" ? ": " : "："}${status}` : label;
}

export type ToolFileReference = {
  fileName: string;
  filePath?: string;
  language: string;
  /** Missing file text stays undefined; explicit image rows use a preview marker. */
  content?: string;
  imageSrc?: string;
  meta?: string;
  statusText: string;
  active: boolean;
};

type ToolFileAction = "read" | "modify" | "edit";
type ToolTitleParts = { action: string; fileName: string; filePath?: string; suffix: string };

const FILE_TOKEN_PATTERN = /(.+?)([\w@./-]+\.(?:tsx?|jsx?|mjs|cjs|json|mdx?|css|scss|html?|py|sh|ya?ml|toml|txt|diff|patch))(.*)$/i;

export function toolFilePresentation(tool: AgentUXToolTimelineItem, locale: AppLocale): {
  action?: ToolAction;
  fileReferences: ToolFileReference[];
  actionPreview?: string;
} {
  const titleParts = splitToolTitle(tool.title ?? tool.name, pathFromTool(tool));
  const action = toolAction(tool);
  const fileAction = resolveToolFileAction(tool, titleParts);
  const fileReferences = fileAction ? buildToolFileReferences(tool, fileAction, locale, titleParts) : [];
  return { action, fileReferences, actionPreview: action ? toolActionPreview(tool, action) : undefined };
}

function toolActionPreview(tool: AgentUXToolTimelineItem, action: ToolAction): string {
  const args = toRecord(tool.args) ?? tryParseRecord(tool.argsText ?? "") ?? toRecord(tool.approval?.argsPreview);
  const path = getString(args, "path") || getString(args, "file") || getString(args, "filename");
  const command = getString(args, "cmd") || getString(args, "command");
  const pattern = getString(args, "pattern") || getString(args, "query");

  switch (action) {
    case "read-file":
    case "read-image":
    case "modify-file":
    case "edit-file":
      return path || tool.preview || tool.argsText || tool.name;
    case "validate":
    case "run-command":
      return command || tool.preview || tool.argsText || tool.name;
    case "search":
      return pattern || tool.preview || tool.argsText || tool.name;
  }
}

function resolveToolFileAction(tool: AgentUXToolTimelineItem, titleParts?: ToolTitleParts): ToolFileAction | undefined {
  if (!titleParts || !["running", "args_streaming", "success"].includes(tool.status)) return undefined;
  const action = toolAction(tool);
  if (action === "read-file" || action === "read-image") return "read";
  if (action === "edit-file") return "edit";
  if (action === "modify-file") return "modify";
  return undefined;
}

function fileActionRowLabel(action: ToolFileAction, locale: AppLocale, active: boolean): string {
  const c = chatCopy[locale].toolCard.fileRow;
  if (action === "read") {
    return active ? c.readActive : c.readDone;
  }
  if (action === "edit") {
    return active ? c.editActive : c.editDone;
  }
  return active ? c.modifyActive : c.modifyDone;
}

function buildToolFileReferences(
  tool: AgentUXToolTimelineItem,
  action: ToolFileAction,
  locale: AppLocale,
  titleParts?: ToolTitleParts,
): ToolFileReference[] {
  if (!titleParts) {
    return [];
  }

  // Image rows come only from result.images; the first may use the tool preview as fallback meta.
  const uploadedImages = action === "read" && toolAction(tool) === "read-image"
    ? explicitImageFileReferences(tool)
    : [];
  if (uploadedImages.length > 0) {
    return uploadedImages.map((file, index, files) => ({
      fileName: file.fileName,
      filePath: file.filePath ?? file.fileName,
      language: languageFromFileName(file.fileName),
      content: "image preview",
      imageSrc: file.imageSrc,
      meta: file.meta ?? (index === 0 ? tool.preview : undefined),
      statusText: fileActionRowLabel(action, locale, isRunningTool(tool) && index === files.length - 1),
      active: isRunningTool(tool) && index === files.length - 1,
    }));
  }

  // One row per explicitly named file; never invent sibling filenames or diff stats.
  const spec = buildToolDisplaySpec(tool);
  const resultBody = spec.outputBlock?.kind === "plain"
    ? spec.outputBlock.text
    : spec.outputBlock?.kind === "code"
      ? spec.outputBlock.code
      : undefined;
  const writtenBody = spec.inputBlock?.kind === "code" ? spec.inputBlock.code : undefined;
  // Read rows show result content; write rows show input content. Edit diffs are not full files.
  const body = action === "read" ? resultBody : action === "modify" ? writtenBody : undefined;

  // Keep the row label and active flag in sync with the tool's own running status.
  const inProgress = isRunningTool(tool);

  return [{
    fileName: titleParts.fileName,
    filePath: titleParts.filePath ?? titleParts.fileName,
    language: languageFromFileName(titleParts.fileName),
    content: body,
    // The backend preview is the only source for file metadata; never invent line or diff counts.
    meta: tool.preview,
    statusText: fileActionRowLabel(action, locale, inProgress),
    active: inProgress,
  }];
}

type ExplicitImageFileReference = { fileName: string; filePath?: string; imageSrc?: string; meta?: string };

function explicitImageFileReferences(tool: AgentUXToolTimelineItem): ExplicitImageFileReference[] {
  const result = toRecord(tool.result);
  const images = Array.isArray(result?.images) ? result.images : [];
  return images
    .map((image) => toRecord(image))
    .filter((image): image is Record<string, unknown> => Boolean(image))
    .map((image) => {
      const filePath = getString(image, "path") || getString(image, "file") || getString(image, "name");
      const fileName = filePath.split("/").filter(Boolean).pop() ?? filePath;
      return {
        fileName,
        filePath,
        imageSrc: getString(image, "src") || getString(image, "imageSrc") || getString(image, "dataUrl") || getString(image, "uri") || undefined,
        meta: getString(image, "meta") || undefined,
      };
    })
    .filter((image) => Boolean(image.fileName));
}

function languageFromFileName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "ts" || ext === "tsx") {
    return "typescript";
  }
  if (ext === "js" || ext === "jsx") {
    return "javascript";
  }
  return ext || "text";
}

function splitToolTitle(title: string, filePath?: string): ToolTitleParts | undefined {
  const fileNameFromPath = filePath?.split("/").filter(Boolean).pop();
  if (fileNameFromPath) {
    const index = title.indexOf(fileNameFromPath);
    if (index >= 0) {
      return {
        action: title.slice(0, index),
        fileName: fileNameFromPath,
        filePath,
        suffix: title.slice(index + fileNameFromPath.length),
      };
    }
    return {
      action: title ? `${title} ` : "",
      fileName: fileNameFromPath,
      filePath,
      suffix: "",
    };
  }

  const match = title.match(FILE_TOKEN_PATTERN);
  if (!match) {
    return undefined;
  }

  return {
    action: match[1],
    fileName: match[2].split("/").filter(Boolean).pop() ?? match[2],
    filePath: filePath ?? match[2],
    suffix: match[3] ?? "",
  };
}

function pathFromTool(tool: AgentUXToolTimelineItem): string | undefined {
  const args = toRecord(tool.args) ?? tryParseRecord(tool.argsText ?? "");
  const path = getString(args, "path") || getString(args, "file") || getString(args, "filename");
  return path || undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function tryParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    return toRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function getString(obj: Record<string, unknown> | undefined, key: string): string {
  const value = obj?.[key];
  return typeof value === "string" ? value : "";
}
