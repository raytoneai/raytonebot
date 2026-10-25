/** Messages between the bot and its browser worker (ADR-040). No Node imports: types only. */

export type BrowserLaunch = {
  executable: string;
  /** Prefix that starts the browser as its own UID in the sandbox, e.g. sudo … setpriv. */
  launcher?: string[];
  profileDir: string;
  downloadDir: string;
  proxyPort: number;
  /** Fixed in the sandbox so the firewall can let only its replies out. */
  cdpPort?: number;
  env?: Record<string, string>;
  /** Explicit local Chromium test hook; never enabled by the host in production. */
  testOnlyAllowHttpLoopbackVault?: boolean;
  /** Test-only exact SHA256 SPKI certificate pin; never a general TLS bypass. */
  testOnlyCertificateSpki?: string;
};

/** What the host knows about a ref from the last snapshot, to judge an action before it runs. */
export type BrowserElement = {
  role: string;
  name: string;
  inputType?: string;
  autocomplete?: string;
  formMethod?: string;
  submits?: boolean;
  /** The page never reported this element's facts (it went away, or the read timed out):
   *  approval treats it as an element it does not know rather than as an ordinary click. */
  unresolved?: boolean;
  /** Focused in the snapshot (`[active]`): what Enter or Space would act on. */
  active?: boolean;
  /** Actual document origin, including cross-origin frames; used for site-scoped approval. */
  origin?: string;
};

export type BrowserInput =
  | { kind: "mouse"; type: "move" | "down" | "up" | "wheel"; x: number; y: number; button?: "left" | "right" | "middle"; deltaX?: number; deltaY?: number }
  | { kind: "key"; type: "down" | "up"; key: string }
  | { kind: "text"; text: string };

/** Host-only approval target. The opaque token binds the actual DOM nodes in the worker. */
export type BrowserVaultTarget = {
  conversationId: string; pageId: string; snapshotId: string; origin: string;
  usernameRef?: string; passwordRef: string; controlEpoch: number; token: string;
};

export type BrowserRequest =
  (
  | { op: "launch"; options: BrowserLaunch }
  | { op: "open"; url: string }
  | { op: "vault-capture"; snapshotId: string; pageId: string; origin: string; passwordRef: string; usernameRef?: string }
  | { op: "vault-validate"; token: string }
  | { op: "vault-fill-field"; token: string; field: "username" | "password"; value: string }
  | { op: "vault-finish"; token: string }
  | { op: "snapshot"; scope?: string; frameRef?: string; snapshotId?: string; mode?: "full" | "interactive" | "content" }
  | { op: "screenshot"; snapshotId: string }
  | { op: "tabs"; pageId?: string }
  | { op: "wait"; text: string; hidden: boolean; timeout: number }
  | { op: "click"; ref: string; snapshotId?: string }
  | { op: "type"; ref: string; text: string; submit?: boolean; snapshotId?: string }
  | { op: "press"; key: string; snapshotId?: string; /** Enter/Space: the ref approved as focused; refused if focus moved. */ expectRef?: string }
  | { op: "scroll"; direction: "up" | "down" }
  | { op: "back" }
  | { op: "screencast"; on: boolean }
  | { op: "input"; input: BrowserInput; pageId?: string; inputId?: string }
  | { op: "reset-input" }
  | { op: "clear-download-owners" }
  | { op: "close" }) & { downloadOwner?: string };

export type BrowserTab = { id: string; title: string; url: string };
export type BrowserPageSummary = { url: string; title: string; pageId: string; snapshotId: string; snapshot: string; content?: string; elements: Record<string, BrowserElement>; notes: string[] };

export type BrowserWorkerMessage =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { event: "frame"; data: string; width: number; height: number; seq: number; capturedAt: number; pageId: string; inputId?: string }
  | { event: "state"; url: string; title: string; pageId: string; revision: number; tabs: BrowserTab[] }
  | { event: "download"; guid: string; url: string; name: string; size: number; owner?: string; state: "started" | "completed" | "canceled" | "too-large" }
  | { event: "download-owner-released"; owner: string }
  | { event: "exit"; code: number | null };

/** The live view's state, as the Output panel reads it. */
export type BrowserViewState = {
  available: boolean;
  /** Why it is unavailable (no browser installed here). */
  reason?: string;
  running: boolean;
  url?: string;
  title?: string;
  pageId?: string;
  tabs?: BrowserTab[];
  controlEpoch?: number;
  /** Who is driving: an agent, or the user after taking over. */
  controller: "agent" | "user";
  /** An agent asked the user to take over (e.g. to log in). */
  requested?: { reason: string };
};
