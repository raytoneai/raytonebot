import { randomUUID } from "node:crypto";
import type { HostTools } from "./memories.ts";
import type { VaultStore } from "./vault.ts";
import type { BrowserService } from "./browser/browserService.ts";
import { VaultRequestGate, VaultRequestError } from "./vaultRequests.ts";
import type { VaultRequestView, VaultUseResult } from "./vaultRequestTypes.ts";
import type { AppLocale } from "../i18n/locales.ts";

export type VaultRun = { signal?: AbortSignal; runId: string; botId: string; locale?: AppLocale; fromChannel?: boolean; groupConversation?: boolean };
type Options = {
  store: VaultStore;
  browser: Pick<BrowserService, "captureLoginTarget" | "validateLoginTarget" | "fillLogin">;
  conversationId: string;
  currentRun(): VaultRun | undefined;
  requests: VaultRequestGate;
  announce(toolCallId: string, request: VaultRequestView): void;
  resolved(toolCallId: string, requestId: string, result: VaultUseResult): void;
  /** Test clock/expiry override, never supplied by the model. */
  timeoutMs?: number;
  log?(event: string, fields: Record<string, unknown>): void;
};

/** Model arguments contain refs only. Secrets never pass through a tool call or result. */
export function vaultToolsFor(options: Options): HostTools {
  let busy = false;
  return {
    specs: [{ name: "vault_request_use",
      description: "When the current task requires login, ask the user to select a saved login or securely enter a new login and authorize filling it once on the current HTTPS page. Pass passwordRef and optional usernameRef from the latest browser snapshot, plus snapshotId. The host selects matching logins and fills them without revealing their values to you. Always requires a user answer, even in allow-all mode. Never submits the form. No credentials in arguments. The host displays a secure input card even if no login is saved. Never ask for credentials in chat. User cancellation or expiry ends this login step. Saving is optional and chosen only by the user. Only top-level password fields explicitly marked autocomplete=current-password are supported; other fields, codes, cards, new passwords and embedded frames require browser takeover. After filling, ask the user to take over to inspect and submit the login; do not retry an uncertain fill.",
      inputSchema: { type: "object", additionalProperties: false, properties: {
        snapshotId: { type: "string" }, passwordRef: { type: "string" }, usernameRef: { type: "string" },
        itemId: { type: "string", description: "Optional previously selected login id. Never a password." },
      }, required: ["snapshotId", "passwordRef"] },
    }],
    async run(name, args, signal) {
      const result = (status: VaultUseResult["status"], message?: string, saved?: boolean) => ({ text: JSON.stringify({ status, ...(message ? { message } : {}), ...(saved !== undefined ? { saved } : {}) }), isError: !["filled", "denied"].includes(status) });
      if (name !== "vault_request_use") return result("unavailable");
      if (busy) return result("unavailable", "A Vault request is already pending in this conversation.");
      const run = options.currentRun();
      if (!run || signal?.aborted) return result("expired");
      if (run.fromChannel || run.groupConversation) return result("unavailable", "Use a direct conversation in the RaytoneBot web app. Never send credentials in chat.");
      const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
      if (Object.keys(input).some(key => !["snapshotId", "passwordRef", "usernameRef", "itemId"].includes(key))
        || ![input.snapshotId, input.passwordRef].every(v => typeof v === "string" && v.length > 0 && v.length < 200)
        || [input.usernameRef, input.itemId].some(v => v !== undefined && (typeof v !== "string" || !v || v.length > 200))) return result("unavailable", "Use only current browser refs and snapshotId.");
      busy = true;
      const expiry = new AbortController();
      const expiresAt = Date.now() + (options.timeoutMs ?? 120_000);
      const timer = setTimeout(() => expiry.abort(), Math.max(0, expiresAt - Date.now()));
      timer.unref();
      const combined = AbortSignal.any([expiry.signal, ...(signal ? [signal] : []), ...(run.signal ? [run.signal] : [])]);
      const stillCurrent = () => {
        combined.throwIfAborted();
        const current = options.currentRun();
        if (!current || current.runId !== run.runId || current.botId !== run.botId) throw new Error("Expired Vault request.");
      };
      let executing = false;
      let itemId: string | undefined;
      let origin: string | undefined;
      let status: VaultUseResult["status"] = "unavailable";
      let saved = false;
      let finalOutcome: VaultUseResult = { status: "unavailable" };
      const toolCallId = `vault_${randomUUID()}`;
      let requestId: string | undefined;
      try {
        stillCurrent();
        const target = await options.browser.captureLoginTarget(options.conversationId, {
          snapshotId: input.snapshotId as string, passwordRef: input.passwordRef as string,
          ...(input.usernameRef ? { usernameRef: input.usernameRef as string } : {}),
        });
        stillCurrent();
        origin = target.origin;
        const items = options.store.view().items.filter(item => item.enabled && item.origin === origin && (!input.itemId || item.id === input.itemId));
        const outcome = await options.requests.wait({ conversationId: options.conversationId, runId: run.runId,
          origin, items: items.map(({ id, label }) => ({ id, label })), expiresAt, signal: combined,
          announce(view) { requestId = view.requestId; options.announce(toolCallId, view); },
          interrupted() { return { status: executing ? "unknown" : "expired", saved,
            message: saved ? "Login saved; filling was not confirmed. Inspect the browser before requesting again."
              : executing ? "The fill outcome is uncertain. Inspect the browser; do not retry automatically."
              : "This login request expired or was stopped. Take a new snapshot before requesting again." }; },
          async execute(answer) {
            try {
              stillCurrent();
              await options.browser.validateLoginTarget(target, combined);
              stillCurrent();
              let credentials: { username: string; password: string };
              let selected = answer.action === "use" ? items.find(item => item.id === answer.itemId) : undefined;
              if (answer.action === "use") {
                if (!selected) return { status: "expired" };
                credentials = options.store.resolve(selected.id, selected.version, target.origin);
              } else if (answer.action === "fill") {
                credentials = { username: answer.username, password: answer.password };
                if (answer.save) {
                  // Validate the captured page before persistence. New input never overwrites an existing login.
                  let before: ReturnType<VaultStore["view"]> | undefined;
                  let attemptedSave = false;
                  try {
                    before = options.store.view();
                    attemptedSave = true;
                    const next = options.store.save({ ...credentials, origin: target.origin, label: answer.label?.trim() || new URL(target.origin).hostname.slice(0, 120), enabled: true }, before.revision);
                    selected = next.items.find(item => !before!.items.some(old => old.id === item.id));
                    saved = true;
                    if (!selected) throw new Error("Missing saved login.");
                    credentials = options.store.resolve(selected.id, selected.version, target.origin);
                  } catch {
                    if (saved) return { status: "unknown", saved: true, message: "Login saved; filling was not confirmed. Inspect the browser before requesting again." };
                    if (attemptedSave && before) {
                      // A disk error can happen after rename. Never let a retry duplicate an uncertain write.
                      let unchanged = false;
                      try {
                        const after = options.store.view();
                        unchanged = after.revision === before.revision;
                        if (!unchanged) for (const item of after.items) {
                          if (before.items.some(old => old.id === item.id) || item.origin !== target.origin) continue;
                          const persisted = options.store.resolve(item.id, item.version, target.origin);
                          if (persisted.username === credentials.username && persisted.password === credentials.password) saved = true;
                        }
                      } catch { /* Unreadable storage cannot prove that the write failed. */ }
                      if (!unchanged) return { status: "unknown", ...(saved ? { saved: true } : {}), message: saved
                        ? "Login saved; nothing was filled. Check Vault and the browser before requesting again."
                        : "Saving could not be confirmed; nothing was filled. Check Vault before requesting again." };
                    }
                    throw new VaultRequestError("Login could not be saved. Check Vault storage or try without saving.", 409);
                  }
                }
              } else return { status: "denied" };
              stillCurrent();
              itemId = selected?.id;
              executing = true;
              await options.browser.fillLogin(target, credentials, combined, () => {
                stillCurrent();
                if (selected) options.store.resolve(selected.id, selected.version, target.origin);
              });
              return { status: "filled", saved, message: "Filled only; login has not been submitted. Ask the user to take over to inspect and submit. Never repeat an uncertain fill." };
            } catch (error) {
              if (error instanceof VaultRequestError) throw error;
              return { status: executing ? "unknown" : "expired", saved,
                message: saved ? "Login saved; filling was not confirmed. Inspect the browser before requesting again."
                  : executing ? "The fill outcome is uncertain. Inspect the browser; do not retry automatically."
                  : "The request expired, or its login/page changed. Take a new snapshot before requesting again." };
            }
          },
        });
        finalOutcome = outcome;
        status = outcome.status;
        return result(status, outcome.message, outcome.saved);
      } catch {
        // A worker timeout may follow a partial fill. Never replay and never echo raw errors.
        status = executing ? "unknown" : "expired";
        finalOutcome = { status, ...(saved ? { saved: true } : {}), message: executing ? "The fill outcome is uncertain. Ask the user to inspect the browser; do not retry automatically." : "The request expired, or its login/page changed. Take a new snapshot before making a new request." };
        return result(status, finalOutcome.message, finalOutcome.saved);
      } finally {
        clearTimeout(timer); busy = false;
        if (requestId) options.resolved(toolCallId, requestId, finalOutcome);
        options.log?.("vault.use", { conversationId: options.conversationId, runId: run.runId, botId: run.botId, itemId, origin, status });
      }
    },
  };
}
