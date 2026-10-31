import { looksLikeUnifiedDiff, replacementDiff } from "../../runtime/unifiedDiff";
import { renderDiffPreview } from "./outputframe/diffPreview";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { AgentUXToolTimelineItem } from "@agent-ux/render-core";

import { StateIcon, type IconSlot } from "../../agentmatrix";
import { useCopy, useLocale } from "../../i18n/LocaleContext";
import type { AppLocale } from "../../i18n/locales";
import { isRunningTool, toolFilePresentation, toolHeaderTitle, type ToolAction, type ToolFileReference } from "../../runtime/toolPresentation";
import { buildToolDisplaySpec, type DisplayBlock } from "../../runtime/toolDisplaySpec";
import type { AgentFrontendProject } from "../../schema/agentuxConfig";
import { deriveDisclosureOpen } from "./disclosureState";
import type { OutputPanelItem, OutputPanelOpenRequest } from "./OutputFrame";

export function ToolCallCard({
  project,
  tool,
  showDebugBadges = false,
  onOpenArtifact,
  forceOpen = false,
  collapseSignal = 0,
}: {
  project: AgentFrontendProject;
  tool: AgentUXToolTimelineItem;
  showDebugBadges?: boolean;
  onOpenArtifact?: (artifact: OutputPanelOpenRequest) => void;
  forceOpen?: boolean;
  collapseSignal?: number;
}) {
  const copy = useCopy();
  const { locale } = useLocale();
  const desiredOpen = tool.open || tool.status === "running" || tool.status === "awaiting_approval";
  const [open, setOpen] = useState(desiredOpen);
  const userToggledRef = useRef(false);
  const spec = useMemo(() => buildToolDisplaySpec(tool), [tool]);
  const toolStyle = project.theme.motion.toolCall;
  const hasTimelineRail = project.toolCalls.timelineRail;
  const detailMode = project.toolCalls.detail;
  const filePresentation = toolFilePresentation(tool, locale);
  const toolAction = filePresentation.action;
  const fileReferences = filePresentation.fileReferences;
  const hasFileReferences = fileReferences.length > 0;
  const inputBlock = (!hasFileReferences || spec.inputBlock?.kind === "diff") && detailMode === "full" ? spec.inputBlock : undefined;
  const outputBlock = !hasFileReferences && (detailMode === "full" || detailMode === "output-only") ? spec.outputBlock : undefined;
  const shouldForceOpen = forceOpen || toolStyle === "expanded" || hasTimelineRail;
  const hideDisclosure = toolStyle === "expanded";
  const bodyHasContent = detailMode !== "summary" && Boolean(inputBlock || outputBlock || hasFileReferences);
  const renderedOpen = shouldForceOpen || open;
  const showProgress = project.toolCalls.progress === "bar";
  const showHeaderPreview = !hasFileReferences;
  const headerPreview = toolAction
    ? filePresentation.actionPreview
    : tool.status === "awaiting_approval" && spec.inputBlock
      ? displayBlockSummary(spec.inputBlock, copy.chat.toolCard.fallbackTitle)
    : tool.preview ?? tool.argsText ?? copy.chat.toolCard.fallbackTitle;
  const headerTitle = toolHeaderTitle(tool, locale);

  useEffect(() => {
    userToggledRef.current = false;
    setOpen(desiredOpen);
  }, [tool.id, desiredOpen]);

  useEffect(() => {
    setOpen((currentOpen) =>
      deriveDisclosureOpen({
        desiredOpen,
        currentOpen,
        userToggled: userToggledRef.current,
      }),
    );
  }, [desiredOpen]);

  useEffect(() => {
    if (forceOpen) {
      userToggledRef.current = false;
      setOpen(true);
    }
  }, [forceOpen, tool.id]);

  useEffect(() => {
    if (collapseSignal > 0) {
      userToggledRef.current = true;
      setOpen(false);
    }
  }, [collapseSignal, tool.id]);

  function toggleOpen() {
    if (!bodyHasContent) {
      return;
    }
    userToggledRef.current = true;
    setOpen((value) => !value);
  }

  function openArtifact(event: MouseEvent<HTMLButtonElement>, file: ToolFileReference) {
    event.stopPropagation();
    onOpenArtifact?.({
      id: `file:${file.filePath ?? file.fileName}`,
      kind: "file",
      title: file.fileName,
      subtitle: file.filePath ?? file.fileName,
      workspacePath: file.filePath ?? file.fileName,
      language: file.language,
      body: file.content,
      imageSrc: file.imageSrc,
    });
  }

  return (
    <section
      className="tool-card"
      data-preview-anchor="tool-call"
      data-detail={detailMode}
      data-progress={project.toolCalls.progress}
      data-status={tool.status}
      data-style={toolStyle}
      data-timeline-rail={hasTimelineRail}
      data-action={toolAction}
      data-file-tool={hasFileReferences}
      data-running-title={isRunningTool(tool) || undefined}
    >
      <div
        className="tool-card-header"
        data-clickable={bodyHasContent && !hideDisclosure}
        onClick={bodyHasContent && !hideDisclosure ? toggleOpen : undefined}
      >
        <span className="tool-status-icon" data-status={tool.status} aria-hidden="true">
          <ToolStatusIcon status={tool.status} action={toolAction} />
        </span>
        <span className="tool-title" data-has-file-link={hasFileReferences}>{headerTitle}</span>
        {showHeaderPreview ? <span className="tool-preview">{headerPreview}</span> : null}
        {showDebugBadges ? <span className="tool-style-badge">{toolStyle}</span> : null}
        {bodyHasContent && !hideDisclosure ? (
          <button
            className="tool-disclosure-button"
            type="button"
            aria-label={renderedOpen ? "Collapse tool" : "Expand tool"}
            aria-expanded={renderedOpen}
            onClick={(event) => {
              event.stopPropagation();
              toggleOpen();
            }}
          >
            <ChevronDown size={14} className="chevron" data-open={renderedOpen} />
          </button>
        ) : null}
      </div>
      {showProgress ? <ToolProgress status={tool.status} /> : null}
      <AnimatePresence initial={false}>
        {renderedOpen && bodyHasContent ? (
          <motion.div
            key="tool-card-body"
            className="tool-card-body"
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16 }}
          >
            {hasFileReferences ? (
              <ToolFileReferenceList
                files={fileReferences}
                onOpenArtifact={(event, file) => openArtifact(event, file)}
              />
            ) : null}
            {inputBlock ? <DisplayBlockView title={inputBlock.kind === "diff" ? copy.chat.toolCard.inputDiffTitle : copy.chat.toolCard.inputTitle} block={inputBlock} /> : null}
            {outputBlock ? <DisplayBlockView title={copy.chat.toolCard.outputTitle} block={outputBlock} tail={project.blocks.toolLogTail} /> : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

export function outputPanelItemsFromTool(tool: AgentUXToolTimelineItem, locale: AppLocale = "en"): OutputPanelItem[] {
  if (tool.status === "error" || tool.status === "cancelled" || tool.status === "awaiting_approval") {
    return [];
  }
  return toolFilePresentation(tool, locale).fileReferences.map((file) => ({
    id: `file:${file.filePath ?? file.fileName}`,
    kind: "file",
    title: file.fileName,
    subtitle: file.filePath ?? file.fileName,
    language: file.language,
    body: file.content,
    imageSrc: file.imageSrc,
  }));
}

function ToolFileReferenceList({
  files,
  onOpenArtifact,
}: {
  files: ToolFileReference[];
  onOpenArtifact: (event: MouseEvent<HTMLButtonElement>, file: ToolFileReference) => void;
}) {
  return (
    <div className="tool-file-list">
      {files.map((file) => (
        <div className="tool-file-row" key={file.filePath ?? file.fileName}>
          <span className="tool-file-row-status" data-active={file.active}>{file.statusText}</span>
          <button
            className="tool-title-file tool-file-row-name"
            type="button"
            data-artifact-ref={file.filePath ?? file.fileName}
            onClick={(event) => onOpenArtifact(event, file)}
          >
            {file.fileName}
          </button>
          {file.meta ? <span className="tool-file-row-meta">{file.meta}</span> : null}
        </div>
      ))}
    </div>
  );
}

export type ApprovalDecision = "yes" | "always" | "no";

function isMcpTool(tool: AgentUXToolTimelineItem): boolean {
  return /\(mcp\)/i.test(tool.title ?? "") || /mcp/i.test(tool.name ?? "");
}

function ToolProgress({ status }: { status: AgentUXToolTimelineItem["status"] }) {
  const progress = status === "running" || status === "args_streaming" ? 58 : status === "awaiting_approval" ? 36 : 100;

  return (
    <div className="tool-progress" aria-hidden="true" data-status={status}>
      <span style={{ width: `${progress}%` }} />
    </div>
  );
}

function ToolStatusIcon({
  status,
  action,
}: {
  status: AgentUXToolTimelineItem["status"];
  action?: ToolAction;
}) {
  if ((status === "running" || status === "args_streaming" || status === "success") && action) {
    return <StateIcon slot={toolActionIconSlot(action)} size={13} />;
  }
  if (status === "error") {
    return <StateIcon slot="tool.failed" size={15} />;
  }
  if (status === "cancelled") {
    return <StateIcon slot="tool.cancelled" size={15} />;
  }
  if (status === "awaiting_approval") {
    return <StateIcon slot="tool.pending_approval" size={15} />;
  }
  return <StateIcon slot="tool.completed" size={15} />;
}

function toolActionIconSlot(action?: ToolAction): IconSlot {
  switch (action) {
    case "read-file":
      return "tool.file_read";
    case "read-image":
      return "content.image";
    case "modify-file":
      return "tool.file_modified";
    case "edit-file":
      return "tool.file_edit";
    case "search":
      return "tool.search";
    case "run-command":
      return "content.terminal";
    case "validate":
    default:
      return "tool.validate";
  }
}

function displayBlockSummary(block: DisplayBlock, fallbackTitle: string): string {
  if (block.kind === "diff") {
    return block.path ?? "Patch";
  }

  const text = block.kind === "code" ? block.code : block.text;
  return text.split(/\r?\n/)[0] || fallbackTitle;
}

function DisplayBlockView({ title, block, tail = false }: { title: string; block: DisplayBlock; tail?: boolean }) {
  if (block.kind === "diff") {
    return (
      <div className="display-block">
        <span>{title}</span>
        {renderDiffPreview(replacementDiff(block.oldCode, block.newCode, block.path))}
      </div>
    );
  }

  const text = block.kind === "code" ? block.code : block.text;
  if (looksLikeUnifiedDiff(text)) {
    return <div className="display-block"><span>{title}</span>{renderDiffPreview(text)}</div>;
  }
  return (
    <div className="display-block">
      <span>{title}</span>
      <pre data-language={block.kind === "code" ? block.lang : "plain"}>
        {tail ? tailText(block.kind === "code" ? block.code : block.text) : block.kind === "code" ? block.code : block.text}
      </pre>
    </div>
  );
}

function tailText(text: string, lineCount = 3): string {
  const lines = text.split(/\r?\n/);
  return lines.length > lineCount ? lines.slice(-lineCount).join("\n") : text;
}
