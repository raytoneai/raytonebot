import { ArrowLeft, Download, File, Folder, Maximize2, Minimize2, PanelRight, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentUXArtifactTimelineItem, AgentUXViewModel } from "@agent-ux/render-core";

import type { AgentFrontendProject, OutputSource } from "../../schema/agentuxConfig";
import { useLocale } from "../../i18n/LocaleContext";
import { useCopy } from "../../i18n/LocaleContext";
import { listPiFiles, piFileDownloadUrl, type PiWorkspaceFile, type PiFileScope } from "../../pi/piClient";
import { useShellExtras } from "../shell/ShellExtras";
import { SelectMenu } from "../ui";
import { workArtifacts } from "../../runtime/workArtifacts";
import { outputPanelItemFromRenderedArtifact } from "./outputframe/artifactPreview";
import { OutputContent } from "./outputframe/OutputContent";
import { OpenedOutputItem } from "./outputframe/OutputTabs";
import type { OutputPanelSource } from "./outputframe/types";
import { ExpandOutputIcon, OutputSourceSwitch, RightSidebarIcon } from "./outputframe/OutputSourceSwitch";
import { outputTitle } from "./outputframe/labels";
import { resolveArtifactRenderer } from "./outputframe/artifactPreview";
import type { OutputPanelItem, OutputPanelOpenRequest } from "./outputframe/panelItem";
import { languageFromFileName, fallbackOutputPanelBody, normalizeOutputPanelRequest } from "./outputframe/panelItem";
import { OutputPanelModal } from "./outputframe/OutputPanelModal";
import { BrowserView } from "./outputframe/BrowserView";
import { liveHtmlWrite, type LiveHtmlWrite } from "../../runtime/liveHtmlWrite";

// The panel-item helpers stay re-exported from this module: App, ToolCallCard and ChatFrame
// import them from "./components/agent-preview/OutputFrame", and the scaffold export asserts
// on that path.
export type { OutputPanelItem, OutputPanelOpenRequest } from "./outputframe/panelItem";
export { languageFromFileName, fallbackOutputPanelBody, normalizeOutputPanelRequest } from "./outputframe/panelItem";
export { OutputPanelModal } from "./outputframe/OutputPanelModal";

export function OutputFrame({
  project,
  viewModel,
  onCollapse,
  openItems = [],
  activeOpenItemId,
  onSelectOpenItem,
  onCloseOpenItem,
  onSourceChange,
  fullscreen = false,
}: {
  project: AgentFrontendProject;
  viewModel: AgentUXViewModel;
  onCollapse?: () => void;
  openItems?: readonly OutputPanelItem[];
  activeOpenItemId?: string;
  onSelectOpenItem?: (id: string) => void;
  onCloseOpenItem?: (id: string) => void;
  onSourceChange?: (source: OutputSource) => void;
  fullscreen?: boolean;
}) {
  const copy = useCopy();
  const { locale } = useLocale();
  const [query, setQuery] = useState("");
  const [truncated, setTruncated] = useState(false);
  const c = copy.workspace.outputFrame;
  const { workspaceScope, workspaceBotName, workspaceRevision, workspaceSharedAvailable, onOpenFile, outputPanel, toolLog } = useShellExtras();
  const [expandedState, setExpanded] = useState(false);
  const expanded = fullscreen || expandedState;
  const [localSource, setLocalSource] = useState<OutputPanelSource>(project.output.source);
  const source = outputPanel?.source ?? localSource;
  const showFiles = source === "workspace";
  const [workspacePreview, setWorkspacePreview] = useState<OutputPanelItem>();
  const selectSource = (next: OutputPanelSource) => {
    if (outputPanel) outputPanel.select(next);
    else setLocalSource(next);
    if (next === "artifact" || next === "console") onSourceChange?.(next);
  };
  const [shared, setShared] = useState(false);
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<PiWorkspaceFile[]>([]);
  const [fileError, setFileError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const scope: PiFileScope = shared ? "shared" : workspaceScope ?? "assistant";
  const panelRef = useRef<HTMLElement>(null);
  const closeExpanded = () => fullscreen ? onCollapse?.() : setExpanded(false);
  useEffect(() => { setPath(""); setQuery(""); setWorkspacePreview(undefined); }, [scope]);
  useEffect(() => { setLocalSource(project.output.source); }, [project.output.source]);
  useEffect(() => {
    if (!showFiles || !workspaceScope || workspacePreview) return;
    const controller = new AbortController();
    setLoading(true);
    setFileError("");
    setFiles([]);
    void listPiFiles(scope, path, controller.signal, query.trim() || undefined)
      .then((result) => { if (!controller.signal.aborted) { setFiles(result.files); setTruncated(Boolean(result.truncated)); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) setFileError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [showFiles, workspaceScope, scope, path, revision, workspaceRevision, query, workspacePreview]);
  useEffect(() => {
    if (!expanded) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]') ?? []);
    controls()[0]?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExpanded();
      if (event.key !== "Tab") return;
      const focusable = controls();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("keydown", close); previouslyFocused?.focus(); };
  }, [expanded, fullscreen]);
  const artifacts = toolLog ? workArtifacts(viewModel.timeline) : [];
  const artifact: AgentUXArtifactTimelineItem | undefined = toolLog ? artifacts.at(-1)
    : [...viewModel.timeline].reverse().find((item): item is AgentUXArtifactTimelineItem => item.kind === "artifact");
  const artifactRenderer = resolveArtifactRenderer(artifact, project.output.artifactRenderer);
  // A page being written shows here unless the user is looking at something else; once the
  // write succeeds, the file it watched opens as itself, scripts and all.
  const writing = liveHtmlWrite(viewModel.timeline);
  const liveHtml = writing && source === "artifact"
    && (!openItems.length || (activeOpenItemId ?? openItems[openItems.length - 1].id) === `file:${writing.path}`) ? writing : undefined;
  const watched = useRef<LiveHtmlWrite | undefined>(undefined);
  useEffect(() => {
    if (liveHtml) { watched.current = liveHtml; return; }
    const last = watched.current;
    if (!last) return;
    watched.current = undefined;
    // Still writing but no longer shown: the user turned to something else; leave them there.
    if (writing?.toolCallId === last.toolCallId) return;
    const tool = viewModel.timeline.find((item) => item.kind === "tool" && item.id === last.toolCallId);
    if (tool?.status === "success") onOpenFile?.({ id: `file:${last.path}`, kind: "file", title: last.title, subtitle: last.path, workspacePath: last.path, revision: last.toolCallId });
  }, [liveHtml, writing, viewModel.timeline, onOpenFile]);

  return (
    <>
      {expanded ? (
        <div className="artifact-expand-backdrop" aria-hidden="true" onClick={closeExpanded} />
      ) : null}
      <section
        ref={panelRef}
        className="utility-card artifact-frame"
        data-preview-anchor="output"
        data-expanded={expanded}
        data-output-source={source}
        data-artifact-renderer={project.output.artifactRenderer}
        data-output-surface={project.output.surface}
        data-view={`${source}:${artifactRenderer}`}
        role={fullscreen ? "dialog" : undefined}
        aria-modal={fullscreen || undefined}
        aria-label={fullscreen ? c.sourceLabel : undefined}
      >
        <header className="utility-header output-header" aria-label={source === "workspace" ? c.files : source === "browser" ? c.sourceBrowser : toolLog && source === "artifact" ? c.sourceArtifact : outputTitle(source, artifactRenderer, c)}>
          <div className="utility-header-leading">
            {onSourceChange || outputPanel ? (
              <OutputSourceSwitch source={source} copy={c} onChange={selectSource}
                browser={outputPanel?.browserAvailable} workspace={Boolean(workspaceScope)} />
            ) : null}
          </div>
          <div className="utility-header-actions">
            <button
              className="rail-icon-btn"
              type="button"
              aria-label={expanded ? c.collapseOutput : c.expandOutput}
              aria-expanded={expanded}
              onClick={() => expanded ? closeExpanded() : setExpanded(true)}
            >
              {fullscreen ? <X size={15} /> : expanded ? (
                <Minimize2 size={15} />
              ) : (
                <>
                  <span className="native-rail-icon"><ExpandOutputIcon size={15} /></span>
                  <span className="legacy-rail-icon"><Maximize2 size={15} /></span>
                </>
              )}
            </button>
            {onCollapse && !expanded ? (
              <button
                className="rail-icon-btn"
                type="button"
                aria-label={c.collapseOutput}
                onClick={onCollapse}
              >
                <span className="native-rail-icon"><RightSidebarIcon size={15} /></span>
                <span className="legacy-rail-icon"><PanelRight size={15} /></span>
              </button>
            ) : null}
          </div>
        </header>
        {source === "browser" ? <BrowserView copy={c} onLoginOpen={() => setExpanded(true)} /> : showFiles && workspaceScope ? workspacePreview ? (
          <div className="artifact-content opened-output">
            <button type="button" className="workspace-preview-back" onClick={() => setWorkspacePreview(undefined)}><ArrowLeft size={15} />{c.files}</button>
            <OpenedOutputItem item={workspacePreview} copy={c} />
          </div>
        ) : (
          <div className="artifact-content workspace-files" aria-busy={loading}>
            <div className="workspace-files-toolbar">
              <SelectMenu className="workspace-scope-select" size="md" value={shared ? "shared" : "agent"} onValueChange={(value) => { setPath(""); setShared(value === "shared"); }} ariaLabel={c.files} options={[{ value: "agent", label: workspaceBotName ?? copy.composer.agentSettings.presets[workspaceScope].name }, ...(workspaceSharedAvailable ? [{ value: "shared", label: c.sharedFiles }] : [])]} />
              <label className="workspace-search-field">
                <Search size={15} aria-hidden="true" />
                <input className="workspace-document-search" type="search" maxLength={100} aria-label={locale === "zh" ? "按路径或关键词找文档" : "Find documents by path or keyword"} placeholder={locale === "zh" ? "按路径或关键词找文档" : "Find documents by path or keyword"} value={query} onChange={e => setQuery(e.target.value)} />
              </label>
              <button className="rail-icon-btn" type="button" aria-label={c.refreshFiles} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={15} /></button>
            </div>
            <div className="workspace-files-path">
              <button className="rail-icon-btn" type="button" disabled={!path} aria-label={c.parentFolder} onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}><ArrowLeft size={15} /></button>
              <code title={`/${path}`}>/{path}</code>
            </div>
            <div className="workspace-files-results">
              {truncated ? <p role="status">{locale === "zh" ? "结果已达到扫描上限，请缩小搜索范围" : "Search limit reached; narrow the query"}</p> : null}
              {fileError ? <p role="alert">{fileError}</p> : loading ? <p role="status">{c.loadingFiles}</p> : files.length === 0 ? <p>{c.emptyFiles}</p> : (
                <ul className="workspace-file-list">
                  {files.map((file) => (
                    <li key={file.path}>
                      {file.directory ? (
                        <button type="button" title={file.path} onClick={() => setPath(file.path)}><Folder size={16} /><span className="workspace-file-name">{file.name}</span></button>
                      ) : (
                        <>
                          <button type="button" title={file.path} onClick={() => setWorkspacePreview(normalizeOutputPanelRequest({ id: `workspace:${scope}:${file.path}`, kind: "file", title: file.name, subtitle: file.path, downloadUrl: piFileDownloadUrl(scope, file.path) }))}><File size={16} /><span><span className="workspace-file-name">{query ? file.path : file.name}</span>{file.snippet ? <small className="workspace-file-snippet">{file.snippet}</small> : null}</span><small className="workspace-file-size">{file.size.toLocaleString()} B</small></button>
                          <a className="workspace-file-download" href={piFileDownloadUrl(scope, file.path)} download={file.name} aria-label={`${c.download} ${file.name}`} title={`${c.download} ${file.name}`}><Download size={16} /></a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : <OutputContent
          project={project}
          source={source === "console" ? "console" : "artifact"}
          artifact={artifact}
          renderer={artifactRenderer}
          copy={c}
          openItems={openItems}
          activeOpenItemId={activeOpenItemId}
          onSelectOpenItem={onSelectOpenItem}
          onCloseOpenItem={onCloseOpenItem}
          tools={viewModel.timeline.filter((item) => item.kind === "tool")}
          artifacts={artifacts}
          onOpenArtifact={(item) => onOpenFile?.(outputPanelItemFromRenderedArtifact(item, project))}
          liveHtml={liveHtml}
        />}
      </section>
    </>
  );
}
