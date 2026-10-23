import { Braces, Check, CircleAlert, Copy, FileCode2, FileText, PanelsTopLeft, TerminalSquare } from "lucide-react";
import { useEffect, useRef } from "react";
import { ToolCallCard } from "../ToolCallCard";
import { useShellExtras } from "../../shell/ShellExtras";
import type { AgentUXToolTimelineItem } from "@agent-ux/render-core";
import type { AgentUXArtifactTimelineItem } from "@agent-ux/render-core";

import type { AgentFrontendProject, OutputSource } from "../../../schema/agentuxConfig";
import type { ConcreteArtifactRenderer, OutputFrameCopy } from "./types";
import type { OutputPanelItem } from "./panelItem";
import { outputItemRenderKind } from "./renderKind";
import { renderMarkdownPreview } from "./openedItemBody";
import { OpenedOutputItem, OutputTabs } from "./OutputTabs";
import { HtmlStreamPreview } from "./HtmlStreamPreview";
import type { LiveHtmlWrite } from "../../../runtime/liveHtmlWrite";
import { useClipboardFeedback } from "../../../runtime/useClipboardFeedback";
import { useCopy } from "../../../i18n/LocaleContext";
import {
  artifactCodePreview,
  artifactDataPreview,
  artifactDiffPreview,
  artifactText,
  firstMeaningfulLine,
  outputPanelItemFromRenderedArtifact,
} from "./artifactPreview";

export function OutputContent({
  project,
  source,
  artifact,
  renderer,
  copy,
  openItems,
  activeOpenItemId,
  onSelectOpenItem,
  onCloseOpenItem,
  tools, artifacts, onOpenArtifact,
  liveHtml,
}: {
  project: AgentFrontendProject;
  source: OutputSource;
  artifact?: AgentUXArtifactTimelineItem;
  renderer: ConcreteArtifactRenderer;
  copy: OutputFrameCopy;
  tools: readonly AgentUXToolTimelineItem[];
  artifacts: readonly AgentUXArtifactTimelineItem[];
  onOpenArtifact: (item: AgentUXArtifactTimelineItem) => void;
  openItems: readonly OutputPanelItem[];
  activeOpenItemId?: string;
  onSelectOpenItem?: (id: string) => void;
  onCloseOpenItem?: (id: string) => void;
  /** An HTML file being written; shown instead of the default view until it is saved. */
  liveHtml?: LiveHtmlWrite;
}) {
  const code = artifact && renderer === "code" ? artifactCodePreview(artifact, copy) : undefined;
  const clipboard = useClipboardFeedback(source === "artifact" && !openItems.length ? code?.code ?? "" : "");
  const labels = useCopy().chat.message.actions;
  const feedback = clipboard.status === "copied" ? labels.copied : clipboard.status === "failed" ? labels.copyFailedText : undefined;
  if (source === "console") {
    return <ConsoleOutput copy={copy} tools={tools} project={project} />;
  }

  if (liveHtml) {
    return (
      <div className="artifact-content opened-output">
        <HtmlStreamPreview key={liveHtml.toolCallId} live={liveHtml} copy={copy} />
      </div>
    );
  }

  const artifactList = artifacts.length ? <ul className="workspace-file-list output-artifact-list">{artifacts.map((item) => <li key={item.id}>
    <button type="button" title={item.title ?? item.id} onClick={() => onOpenArtifact(item)}><FileText size={14} /><span>{(item.title ?? item.id).split("/").pop()}</span></button>
  </li>)}</ul> : null;

  if (openItems.length > 0) {
    const active = openItems.find((item) => item.id === activeOpenItemId) ?? openItems[openItems.length - 1];
    return (
      <div className="artifact-content opened-output">
        {openItems.length > 1 ? (
          <OutputTabs
            items={openItems}
            activeId={active.id}
            onSelectOpenItem={onSelectOpenItem}
            onCloseOpenItem={onCloseOpenItem}
          />
        ) : null}
        {artifactList}
        <OpenedOutputItem item={active} copy={copy} />
      </div>
    );
  }

  if (artifacts.length) {
    return <div className="artifact-content">{artifactList}</div>;
  }

  if (!artifact) {
    return <div className="empty-state">{copy.emptyNoArtifact}</div>;
  }

  if (code) {
    return (
      <div className="artifact-content code-output">
        <div className="artifact-title">
          <FileCode2 size={16} />
          <span>{artifact.title ?? artifact.id}</span>
          <code>{code.lang}</code>
          <button
            className="code-copy-button"
            type="button"
            aria-label={feedback ?? copy.copyCode}
            title={feedback ?? copy.copyCode}
            disabled={!code.code}
            onClick={(event) => void clipboard.copy(event.currentTarget.closest(".code-output")?.querySelector("pre"))}
          >
            {clipboard.status === "copied" ? <Check size={14} /> : clipboard.status === "failed" ? <CircleAlert size={14} /> : <Copy size={14} />}
          </button>
        </div>
        {feedback ? <span className="clipboard-feedback" role="status">{feedback}</span> : null}
        <pre data-language={code.lang}>{code.code}</pre>
      </div>
    );
  }

  if (renderer === "markdown") {
    return (
      <div className="artifact-content markdown-output">
        <div className="artifact-title">
          <FileText size={16} />
          <span>{artifact.title ?? artifact.id}</span>
          <code>{copy.rendererLabels.markdown}</code>
        </div>
        <div className="markdown-preview">{renderMarkdownPreview(artifactText(artifact, copy), copy)}</div>
      </div>
    );
  }

  if (renderer === "preview") {
    const artifactItem = outputPanelItemFromRenderedArtifact(artifact, project);
    const artifactRenderKind = outputItemRenderKind(artifactItem);
    if (artifactRenderKind === "image" || artifactRenderKind === "audio" || artifactRenderKind === "video" || artifactRenderKind === "html" || artifactRenderKind === "pdf") {
      return (
        <div className="artifact-content preview-output media-preview-output" data-render-kind={artifactRenderKind}>
          <OpenedOutputItem item={artifactItem} copy={copy} />
        </div>
      );
    }
    return (
      <div className="artifact-content preview-output">
        <div className="artifact-title">
          <PanelsTopLeft size={16} />
          <span>{copy.renderedPreview}</span>
          <code>{artifact.artifactKind}</code>
        </div>
        <div className="rendered-preview">
          <strong>{artifact.title ?? artifact.id}</strong>
          <p>{firstMeaningfulLine(artifactText(artifact, copy))}</p>
        </div>
      </div>
    );
  }

  if (renderer === "data") {
    return (
      <div className="artifact-content data-output">
        <div className="artifact-title">
          <Braces size={16} />
          <span>{artifact.title ?? artifact.id}</span>
          <code>{copy.rendererLabels.data}</code>
        </div>
        <pre>{artifactDataPreview(artifact)}</pre>
      </div>
    );
  }

  return (
    <div className="artifact-content diff-output">
      <div className="artifact-title">
        <FileCode2 size={16} />
        <span>{artifact.title ?? artifact.id}{copy.diffSuffix}</span>
        <code>{copy.rendererLabels.diff}</code>
      </div>
      <pre>{artifactDiffPreview(artifact, copy)}</pre>
    </div>
  );
}

/**
 * The console surface, driven by the shell commands the run actually issued.
 *
 * It used to print four fixed lines regardless of the session, so switching to this tab
 * changed nothing recognisable and read as a dead control. A run with no shell commands now
 * says so instead of inventing a transcript.
 */
function ConsoleOutput({ copy, tools, project }: {
  copy: OutputFrameCopy;
  tools: readonly AgentUXToolTimelineItem[];
  project: AgentFrontendProject;
}) {
  const { toolLog, onOpenFile } = useShellExtras();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-log-tool]") ?? [])
      .find((element) => element.dataset.logTool === toolLog?.targetId);
    if (target && list.current) list.current.scrollTop += target.getBoundingClientRect().top - list.current.getBoundingClientRect().top;
    target?.focus({ preventScroll: true });
  }, [toolLog?.targetId, toolLog?.revision]);
  return (
    <div ref={list} className="artifact-content terminal-output">
      <div className="artifact-title"><TerminalSquare size={16} /><span>{copy.consoleLogs}</span><code>{copy.consoleCode}</code></div>
      {tools.length === 0 ? <p className="artifact-empty">{copy.emptyNoConsole}</p> : tools.map((tool) => (
        <div key={tool.id} data-log-tool={tool.id} tabIndex={-1}>
          <ToolCallCard key={tool.id === toolLog?.targetId ? toolLog.revision : undefined} project={{ ...project, toolCalls: { ...project.toolCalls, detail: "full" } }} tool={{ ...tool, open: tool.id === toolLog?.targetId || tool.open }} onOpenArtifact={onOpenFile} />
        </div>
      ))}
    </div>
  );
}
