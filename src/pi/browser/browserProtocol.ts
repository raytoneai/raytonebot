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
};

/** What the host knows about a ref from the last snapshot, to judge an action before it runs. */
export type BrowserElement = {
  role: string;
  name: string;
  inputType?: string;
  autocomplete?: string;
  formMethod?: string;
  submits?: boolean;
  /** Focused in the snapshot (`[active]`): what Enter or Space would act on. */
  active?: boolean;
};

export type BrowserInput =
  | { kind: "mouse"; type: "move" | "down" | "up" | "wheel"; x: number; y: number; button?: "left" | "right" | "middle"; deltaX?: number; deltaY?: number }
  | { kind: "key"; type: "down" | "up"; key: string }
  | { kind: "text"; text: string };

export type BrowserRequest =
  | { op: "launch"; options: BrowserLaunch }
  | { op: "open"; url: string }
  | { op: "snapshot" }
  | { op: "click"; ref: string }
  | { op: "type"; ref: string; text: string; submit?: boolean }
  | { op: "press"; key: string; /** Enter/Space: the ref approved as focused; refused if focus moved. */ expectRef?: string }
  | { op: "scroll"; direction: "up" | "down" }
  | { op: "back" }
  | { op: "screencast"; on: boolean }
  | { op: "input"; input: BrowserInput }
  | { op: "close" };

export type BrowserPageSummary = { url: string; title: string; snapshot: string; elements: Record<string, BrowserElement>; notes: string[] };

export type BrowserWorkerMessage =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { event: "frame"; data: string; width: number; height: number }
  | { event: "state"; url: string; title: string }
  | { event: "download"; guid: string; url: string; name: string; size: number; state: "completed" | "canceled" | "too-large" }
  | { event: "exit"; code: number | null };

/** The live view's state, as the Output panel reads it. */
export type BrowserViewState = {
  available: boolean;
  /** Why it is unavailable (no browser installed here). */
  reason?: string;
  running: boolean;
  url?: string;
  title?: string;
  /** Who is driving: an agent, or the user after taking over. */
  controller: "agent" | "user";
  /** An agent asked the user to take over (e.g. to log in). */
  requested?: { reason: string };
};
