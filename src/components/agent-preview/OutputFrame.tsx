import { ArrowLeft, Download, File, Folder, FolderOpen, Maximize2, Minimize2, PanelRight, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentUXArtifactTimelineItem, AgentUXViewModel } from "@agent-ux/render-core";

import type { AgentFrontendProject, OutputSource } from "../../schema/agentuxConfig";
import { useCopy } from "../../i18n/LocaleContext";
import { listPiFiles, piFileDownloadUrl, type PiWorkspaceFile, type PiFileScope } from "../../pi/piClient";
import { useShellExtras } from "../shell/ShellExtras";
import { SelectMenu } from "../ui";
import { consoleLogEntries } from "../../runtime/toolDisplaySpec";
import { OutputContent } from "./outputframe/OutputContent";
import { ExpandOutputIcon, OutputSourceSwitch, RightSidebarIcon } from "./outputframe/OutputSourceSwitch";
import { outputTitle } from "./outputframe/labels";
import { resolveArtifactRenderer } from "./outputframe/artifactPreview";
import type { OutputPanelItem, OutputPanelOpenRequest } from "./outputframe/panelItem";
import { languageFromFileName, fallbackOutputPanelBody, normalizeOutputPanelRequest } from "./outputframe/panelItem";
import { OutputPanelModal } from "./outputframe/OutputPanelModal";

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
  const c = copy.workspace.outputFrame;
  const { workspaceScope, workspaceRevision, workspaceSharedAvailable, onOpenFile } = useShellExtras();
  const [expandedState, setExpanded] = useState(false);
  const expanded = fullscreen || expandedState;
  // The phone's workspace entry opens files; the desktop output keeps its artifact by default.
  const [showFiles, setShowFiles] = useState(fullscreen);
  const [shared, setShared] = useState(false);
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<PiWorkspaceFile[]>([]);
  const [fileError, setFileError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const scope: PiFileScope = shared ? "shared" : workspaceScope ?? "assistant";
  const panelRef = useRef<HTMLElement>(null);
  const closeExpanded = () => fullscreen ? onCollapse?.() : setExpanded(false);
  useEffect(() => { setPath(""); }, [scope]);
  useEffect(() => { if (activeOpenItemId) setShowFiles(false); }, [activeOpenItemId]);
  useEffect(() => {
    if (!showFiles || !workspaceScope) return;
    const controller = new AbortController();
    setLoading(true);
    setFileError("");
    setFiles([]);
    void listPiFiles(scope, path, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setFiles(result.files); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setFileError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [showFiles, workspaceScope, scope, path, revision, workspaceRevision]);
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
  const artifact = [...viewModel.timeline].reverse().find((item): item is AgentUXArtifactTimelineItem => item.kind === "artifact");
  const artifactRenderer = resolveArtifactRenderer(artifact, project.output.artifactRenderer);

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
        data-output-source={project.output.source}
        data-artifact-renderer={project.output.artifactRenderer}
        data-output-surface={project.output.surface}
        data-view={`${project.output.source}:${artifactRenderer}`}
        role={fullscreen ? "dialog" : undefined}
        aria-modal={fullscreen || undefined}
        aria-label={fullscreen ? c.files : undefined}
      >
        <header className="utility-header output-header" aria-label={outputTitle(project.output.source, artifactRenderer, c)}>
          <div className="utility-header-leading">
            {onSourceChange ? (
              <OutputSourceSwitch source={project.output.source} copy={c} onChange={(source) => { setShowFiles(false); onSourceChange(source); }} />
            ) : null}
          </div>
          <div className="utility-header-actions">
            {workspaceScope ? (
              <button className="rail-icon-btn" type="button" aria-label={c.files} title={c.files} aria-pressed={showFiles} onClick={() => setShowFiles((current) => !current)}><FolderOpen size={16} /></button>
            ) : null}
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
        {showFiles && workspaceScope ? (
          <div className="artifact-content workspace-files" aria-busy={loading}>
            <div className="artifact-title">
              <FolderOpen size={16} />
              <span>{c.files}</span>
              <SelectMenu size="sm" value={shared ? "shared" : "agent"} onValueChange={(value) => { setPath(""); setShared(value === "shared"); }} ariaLabel={c.files} options={[{ value: "agent", label: copy.composer.agentSettings.presets[workspaceScope].name }, ...(workspaceSharedAvailable ? [{ value: "shared", label: c.sharedFiles }] : [])]} />
              <button className="rail-icon-btn" type="button" aria-label={c.refreshFiles} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={15} /></button>
            </div>
            <div className="workspace-files-path">
              <button className="rail-icon-btn" type="button" disabled={!path} aria-label={c.parentFolder} onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}><ArrowLeft size={15} /></button>
              <code>/{path}</code>
            </div>
            {fileError ? <p role="alert">{fileError}</p> : loading ? <p role="status">{c.loadingFiles}</p> : files.length === 0 ? <p>{c.emptyFiles}</p> : (
              <ul className="workspace-file-list">
                {files.map((file) => (
                  <li key={file.path}>
                    {file.directory ? (
                      <button type="button" onClick={() => setPath(file.path)}><Folder size={16} /><span>{file.name}</span></button>
                    ) : (
                      <>
                        <button type="button" onClick={() => { setShowFiles(false); onOpenFile?.({ id: `workspace:${scope}:${file.path}`, kind: "file", title: file.name, subtitle: file.path, downloadUrl: piFileDownloadUrl(scope, file.path) }); }}><File size={16} /><span>{file.name}</span><small>{file.size.toLocaleString()} B</small></button>
                        <a className="workspace-file-download" href={piFileDownloadUrl(scope, file.path)} download={file.name} aria-label={`${c.download} ${file.name}`} title={`${c.download} ${file.name}`}><Download size={16} /></a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : <OutputContent
          project={project}
          source={project.output.source}
          artifact={artifact}
          renderer={artifactRenderer}
          copy={c}
          openItems={openItems}
          activeOpenItemId={activeOpenItemId}
          onSelectOpenItem={onSelectOpenItem}
          onCloseOpenItem={onCloseOpenItem}
          consoleEntries={consoleLogEntries(viewModel.timeline)}
        />}
      </section>
    </>
  );
}
