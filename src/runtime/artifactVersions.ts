import type { PiFileScope } from "../pi/piClient.ts";

/** Public metadata only; stored bytes and storage paths remain host-owned. */
export type ArtifactVersion = {
  versionId: string;
  /** The source conversation's projected artifact identity. */
  artifactId: string;
  createdAt: number;
  size: number;
  sha256: string;
};

export type ArtifactVersionsResponse = {
  versions: ArtifactVersion[];
  selectedVersionId: string;
  /** Host-validated workspace location, independent of local filesystem aliases. */
  source?: { scope: PiFileScope; path: string };
};

/** A display hint only. The host must verify the persisted event and version record. */
export function isVersionedArtifactId(id: string): boolean {
  return /(?:^|["~])published_version_[a-f0-9-]{36}(?:"|$)/.test(id);
}
