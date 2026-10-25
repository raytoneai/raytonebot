/** Public request metadata only. Secret answers travel only through the dedicated POST. */
export type VaultRequestView = {
  requestId: string;
  runId: string;
  origin: string;
  expiresAt: number;
  items: { id: string; label: string }[];
};
export type VaultRequestAnswer =
  | { action: "cancel" }
  | { action: "use"; itemId: string }
  | { action: "fill"; username: string; password: string; save: boolean; label?: string };
export type VaultUseResult = {
  status: "filled" | "denied" | "expired" | "unavailable" | "unknown";
  saved?: boolean;
  message?: string;
};
