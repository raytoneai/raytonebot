import { useEffect, useState } from "react";

import type { ArtifactVersion, ArtifactVersionsResponse } from "./artifactVersions.ts";
import { isVersionedArtifactId } from "./artifactVersions.ts";
import { getArtifactVersions } from "../pi/piClient.ts";
import type { OutputPanelItem } from "../components/agent-preview/outputframe/panelItem.ts";

export type VersionLoadState = {
  status: "disabled" | "unavailable" | "loading" | "ready" | "failed";
  versions: readonly ArtifactVersion[];
  selectedVersionId?: string;
  source?: OutputPanelItem["versionSource"];
};

function versionSource(value: unknown): OutputPanelItem["versionSource"] {
  if (!value || typeof value !== "object") return undefined;
  const source = value as { scope?: unknown; path?: unknown };
  if (typeof source.path !== "string" || !source.path) return undefined;
  if (source.scope !== "assistant" && source.scope !== "planner" && source.scope !== "builder" && source.scope !== "dsh" && source.scope !== "shared") return undefined;
  return { scope: source.scope, path: source.path };
}

function versionIdentity(item: OutputPanelItem): string {
  const identity = item.versionOriginArtifactId ?? item.artifactId ?? item.id;
  return identity.startsWith("artifact:") ? identity.slice("artifact:".length) : identity;
}

/** Version metadata belongs to an opened historical tab, never to the artifact list. */
export function useOpenedArtifactVersions(item: OutputPanelItem) {
  const identity = versionIdentity(item);
  const versioned = isVersionedArtifactId(identity);
  const canLoad = versioned && Boolean(item.conversationId && identity);
  const requestKey = item.id + "\n" + (item.conversationId ?? "") + "\n" + identity;
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<string>(item.versionSelection === "current" ? "current" : item.selectedVersionId ?? "");
  const [state, setState] = useState<VersionLoadState>(() => item.versions
    ? { status: "ready", versions: item.versions, selectedVersionId: item.selectedVersionId, source: item.versionSource }
    : { status: !versioned ? "disabled" : canLoad ? "loading" : "unavailable", versions: [] });

  useEffect(() => {
    setSelection(item.versionSelection === "current" ? "current" : item.selectedVersionId ?? "");
  }, [requestKey, item.versionSelection, item.selectedVersionId]);

  useEffect(() => {
    let active = true;
    if (!versioned) {
      setState({ status: "disabled", versions: [] });
      return () => { active = false; };
    }
    if (item.versions && attempt === 0) {
      setState({ status: "ready", versions: item.versions, selectedVersionId: item.selectedVersionId, source: item.versionSource });
      return () => { active = false; };
    }
    if (!canLoad) {
      setState({ status: "unavailable", versions: [] });
      return () => { active = false; };
    }
    const controller = new AbortController();
    setState({ status: "loading", versions: [] });
    void getArtifactVersions(item.conversationId!, identity, fetch, controller.signal)
      .then((response) => {
        if (!active || controller.signal.aborted) return;
        setState({ status: "ready", versions: response.versions ?? [], selectedVersionId: response.selectedVersionId,
          // Older hosts omit source; retain an owner-cached source when available.
          source: versionSource((response as ArtifactVersionsResponse & { source?: unknown }).source) ?? item.versionSource });
        setSelection(current => current || response.selectedVersionId || "");
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setState({ status: "failed", versions: [] });
      });
    return () => { active = false; controller.abort(); };
  }, [requestKey, attempt, versioned, canLoad, identity, item.conversationId, item.versions, item.selectedVersionId]);

  const selectedVersionId = selection || state.selectedVersionId || item.selectedVersionId;
  const selectedVersion = selectedVersionId && selectedVersionId !== "current"
    ? state.versions.find(version => version.versionId === selectedVersionId)
    : undefined;
  return {
    versioned,
    canLoad,
    state,
    selectedVersionId,
    selectedVersion,
    select: setSelection,
    retry: () => setAttempt(value => value + 1),
  };
}
