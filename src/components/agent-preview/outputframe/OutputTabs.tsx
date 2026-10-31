import { featureText } from "../../../i18n/copy/features.ts";
import { useCopy, useLocale } from "../../../i18n/LocaleContext";
import type { ArtifactVersion } from "../../../runtime/artifactVersions.ts";
import { piArtifactVersionDownloadUrl, piFileDownloadUrl } from "../../../pi/piClient";
import { DocumentActions } from "./DocumentActions";
import { StructuredArtifact } from "./StructuredArtifact";
import { parseArtifactForm } from "../../../runtime/artifactForm";
import { Download, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { OutputFrameCopy } from "./types";
import type { OutputPanelItem } from "./panelItem";
import { languageFromTitle, outputItemIcon, outputItemRenderKind } from "./renderKind";
import { renderOpenedOutputBody } from "./openedItemBody";
import { useFilePreview } from "./useFilePreview";
import { workspaceFileUrl } from "../../../runtime/filePreview";
import { useShellExtras } from "../../shell/ShellExtras";
import { useOpenedArtifactVersions, type VersionLoadState } from "../../../runtime/useArtifactVersions.ts";

export function OutputTabs({
  items,
  activeId,
  onSelectOpenItem,
  onCloseOpenItem,
}: {
  items: readonly OutputPanelItem[];
  activeId: string;
  onSelectOpenItem?: (id: string) => void;
  onCloseOpenItem?: (id: string) => void;
}) {
  const copy = useCopy().workspace.outputFrame;
  const activeTabRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [activeId]);

  return (
    <div className="output-tabs" role="tablist" aria-label="Opened output">
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <div
            key={item.id}
            ref={active ? activeTabRef : undefined}
            className="output-tab"
            data-active={active}
          >
            <button
              className="output-tab-main"
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelectOpenItem?.(item.id)}
            >
              {outputItemIcon(item)}
              <span className="output-tab-title">{item.title}</span>
            </button>
            {onCloseOpenItem ? (
              <button
                className="output-tab-close"
                type="button"
                aria-label={copy.closeFile(item.title)}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseOpenItem(item.id);
                }}
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function versionLabel(version: ArtifactVersion, locale: Parameters<typeof featureText>[0], ordinal: number): string {
  const created = Number.isFinite(version.createdAt)
    ? new Date(version.createdAt).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
  const size = Number.isFinite(version.size) ? " · " + version.size.toLocaleString(locale) + " B" : "";
  return featureText(locale, "Delivered version") + " #" + ordinal + (created ? " · " + created : "") + size;
}

function VersionSelector({
  locale,
  state,
  selectedVersionId,
  currentDownloadUrl,
  onSelect,
}: {
  locale: Parameters<typeof featureText>[0];
  state: VersionLoadState;
  selectedVersionId?: string;
  currentDownloadUrl?: string;
  onSelect: (value: string) => void;
}) {
  if (state.status !== "ready" || !state.versions.length) return null;
  const currentAvailable = Boolean(currentDownloadUrl);
  return (
    <div className="document-toolbar" data-version-selector>
      <label style={{ display: "flex", alignItems: "center", gap: "6px", maxWidth: "100%", minWidth: 0, flexWrap: "wrap" }}>
        {featureText(locale, "Delivered version")}{" "}
        <select style={{ maxWidth: "100%", minWidth: 0 }} aria-label={featureText(locale, "Delivered version")} value={selectedVersionId ?? ""} onChange={event => onSelect(event.target.value)}>
          {state.versions.map((version, index) => <option key={version.versionId} value={version.versionId}>{versionLabel(version, locale, index + 1)}</option>)}
          {currentAvailable ? <option value="current">{featureText(locale, "Current workspace file")}</option> : null}
        </select>
      </label>
    </div>
  );
}

export function OpenedOutputItem({ item, copy, onClose }: { item: OutputPanelItem; copy: OutputFrameCopy; onClose?: (id: string) => void }) {
  const { locale } = useLocale();
  const { workspace, workspaceScope, artifactForms, onOpenFile } = useShellExtras();
  const versions = useOpenedArtifactVersions(item);
  const currentDownloadUrl = versions.state.source
    ? piFileDownloadUrl(versions.state.source.scope, versions.state.source.path)
    : item.downloadUrl ?? (item.workspacePath && workspaceScope ? workspaceFileUrl(item.workspacePath, workspaceScope, workspace) : undefined);
  const versionDownloadUrl = versions.versioned && versions.selectedVersion && item.conversationId
    ? piArtifactVersionDownloadUrl(item.conversationId, versions.selectedVersion.artifactId, versions.selectedVersion.versionId)
    : undefined;
  const downloadUrl = versions.versioned
    ? versions.selectedVersionId === "current" ? currentDownloadUrl : versionDownloadUrl
    : currentDownloadUrl;
  const preview = useFilePreview(item, downloadUrl);
  const [failedKey, setFailedKey] = useState<object>();
  const failed = failedKey === preview.key || Boolean(preview.error);
  const language = item.language ?? languageFromTitle(item.title);
  const renderKind = outputItemRenderKind(item);
  const loadingVersion = versions.versioned && versions.state.status === "loading";
  const failedVersion = versions.versioned && (versions.state.status === "failed" || versions.state.status === "unavailable"
    || (versions.state.status === "ready" && !versions.selectedVersion && versions.selectedVersionId !== "current"));
  const readOnlyVersion = versions.versioned && versions.state.status === "ready" && versions.selectedVersionId !== "current";
  const retry = () => {
    if (versions.versioned) versions.retry();
    preview.retry();
  };
  const selectVersion = (value: string) => {
    versions.select(value);
    const selected = value === "current" ? undefined : versions.state.versions.find(version => version.versionId === value);
    // Persist the selection in the existing Output owner when it is available. That lets
    // refreshArtifactItems keep current mode live while historical tabs remain immutable.
    onOpenFile?.({
      ...item,
      id: item.id,
      selectedVersionId: selected?.versionId,
      versionSelection: value === "current" ? "current" : "version",
      artifactId: selected?.artifactId ?? item.artifactId,
      versionOriginArtifactId: item.versionOriginArtifactId ?? item.artifactId,
      versionSource: versions.state.source ?? item.versionSource,
      versions: versions.state.versions,
    });
  };
  let form, formError;
  // A saved delivery is a read-only byte snapshot. Even if its JSON happens to
  // describe a raytone-form, do not turn historical bytes into a submit-capable UI.
  try { form = !readOnlyVersion && preview.body ? parseArtifactForm(preview.body, locale) : undefined; } catch (error) { formError = error instanceof Error ? error.message : String(error); }
  return (
    <div className="opened-output-item" data-kind={item.kind} data-render-kind={renderKind} data-versioned={versions.versioned ? "true" : undefined}>
      <div className="artifact-title">
        {outputItemIcon(item, 16)}
        <span title={item.subtitle ?? item.workspacePath ?? item.title}>{item.title}</span>
        {item.kind !== "file" && item.subtitle ? <em>{item.subtitle}</em> : null}
        {!/\.[a-z0-9]+$/i.test(item.title) ? <code>{language}</code> : null}
        {downloadUrl || preview.contentUrl ? <a className="rail-icon-btn" href={downloadUrl ?? preview.contentUrl} download={item.title} aria-label={copy.download}><Download size={16} /></a> : null}
        {downloadUrl || failed || (failedVersion && versions.canLoad) ? <button className="rail-icon-btn" type="button" aria-label={copy.retryPreview} onClick={retry}><RefreshCw size={16} /></button> : null}
        {onClose ? <button className="rail-icon-btn" type="button" aria-label={copy.closeFile(item.title)} title={copy.closeFile(item.title)} onClick={() => onClose(item.id)}><X size={16} /></button> : null}
      </div>
      {versions.versioned && versions.state.status === "ready" ? <VersionSelector locale={locale} state={versions.state} selectedVersionId={versions.selectedVersionId} currentDownloadUrl={currentDownloadUrl} onSelect={selectVersion} /> : null}
      {readOnlyVersion ? <small role="status">{featureText(locale, "Read-only saved version")}</small> : null}
      {loadingVersion ? <p role="status">{featureText(locale, "Loading saved versions…")}</p>
        : versions.versioned && versions.state.status === "unavailable" ? <p role="alert">{featureText(locale, "Saved version context is unavailable. Open the source conversation to view it.")}</p>
        : versions.versioned && versions.state.status === "failed" ? <p role="alert">{featureText(locale, "Could not load saved versions. Retry to view this delivery.")}</p>
        : failedVersion ? <p role="alert">{featureText(locale, "Saved version is unavailable. Retry to view this delivery.")}</p>
        : !readOnlyVersion && !loadingVersion && !failed && preview.body !== undefined && (/\.(md|txt)$/i.test(item.title) || !downloadUrl && ["markdown", "text"].includes(language)) ? <DocumentActions key={item.id} item={item} body={preview.body} downloadUrl={downloadUrl} /> : null}
      {loadingVersion ? null
        : versions.versioned && (versions.state.status === "unavailable" || versions.state.status === "failed" || failedVersion) ? null
        : preview.loading ? <p role="status">{copy.loadingFiles}</p>
        : failed ? <p role="alert">{preview.error === "too-large" ? copy.previewTooLarge : copy.previewFailed}</p>
        : formError ? <p role="alert">{formError}</p>
        : form ? <StructuredArtifact key={JSON.stringify([artifactForms?.conversationId, item.artifactId ?? item.id, item.revision, preview.body])} artifactId={item.artifactId ?? item.id} source={preview.body!} form={form} />
        : renderOpenedOutputBody({ ...item, body: preview.body, mediaSrc: preview.mediaSrc }, renderKind, language, copy, () => setFailedKey(preview.key))}
    </div>
  );
}
