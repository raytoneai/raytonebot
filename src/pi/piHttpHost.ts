import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve as resolvePath } from "node:path";
import {
  type PiApprovalDecision
} from "../harness/adapters/piAdapter.ts";
import { isAppLocale } from "../i18n/locales.ts";
import { type PiPermissionMode } from "./approvalGate.ts";
import { ArtifactCatalogError, listArtifactCatalog } from "./artifactCatalog.ts";
import { BotConfigError, BotConfigStore } from "./botConfig.ts";
import { createBotSkillsService, SkillsError } from "./botSkills.ts";
import { browserLoginUrl } from "./browser/browserPolicy.ts";
import type { BrowserInput } from "./browser/browserProtocol.ts";
import { createBrowserService, type BrowserService } from "./browser/browserService.ts";
import { ConversationBranchError } from "./conversationBranch.ts";
import { ConversationRequestError } from "./conversationRequestError.ts";
import { conversationSearchPage, SearchPageError } from "./conversationSearchPage.ts";
import {
  createConversationStore,
  defaultDataDir
} from "./conversationStore.ts";
import {
  isAgentPresetId
} from "./harnessCatalog.ts";
import { runtimeLogger, type RunLimits } from "./hostOperations.ts";
import { createChannelManager, type ConnectorFactories } from "./imChannels/channelManager.ts";
import { ChannelSetupError, createChannelSetup } from "./imChannels/channelSetup.ts";
import { CHANNEL_PLATFORMS, type ChannelPatch, type ChannelPlatform } from "./imChannels/types.ts";
import { LearningError } from "./learning/service.ts";
import { createMcpService, McpError } from "./mcpServers.ts";
import { createMemoryService, MemoryError } from "./memories.ts";
import { normalizeModelOptions } from "./modelMetadata.ts";
import {
  PI_API_PREFIX,
  type PiPromptInput,
  type PiProviderDefinition
} from "./piClient.ts";
import { piErrorTurnEvents, PROMPT_REJECTED } from "./piErrorTurn.ts";
import { ProviderStore, ProviderStoreError } from "./providerStore.ts";
import { sameOriginRequestAllowed } from "./requestOrigin.ts";
import { createRoutineService, RoutineError, type RoutineService } from "./routines.ts";
import { requireAgentIsolation } from "./runtime/agentProcess.ts";
import { VaultError, VaultStore } from "./vault.ts";
import { VaultRequestError } from "./vaultRequests.ts";
import { sendWorkspaceFile } from "./workspaceDownload.ts";
import { createWorkspaceDocument, listWorkspaceFiles, openWorkspaceFile, readWorkspaceDocument, replaceWorkspaceDocument, searchWorkspaceDocuments, uploadWorkspaceFile, WorkspaceFileError } from "./workspaceFiles.ts";
import { resolveWorkspaceLayout, type WorkspaceLayout } from "./workspaceLayout.ts";

import { createPiRuntimeController, type PiBridgeFactory } from "./piRuntimeController.ts";

import { asRecord, errorMessage, normalizeConversationId } from "./piHostUtils.ts";

export function createPiHttpHost(options: {
  cwd: string;
  appRoot?: string;
  sandboxed?: boolean;
  layout?: WorkspaceLayout;
  dataDir?: string;
  bridgeFactory?: PiBridgeFactory;
  limits?: RunLimits;
  channelFactories?: ConnectorFactories;
  /** Runs routines on their schedule (ADR-036); tests that drive runs by hand turn it off. */
  routineClock?: boolean;
  /** The shared browser (ADR-040); tests without one turn it off. */
  browser?: false | BrowserService;
  /** Local testing override; sandbox deployments use the private sibling directory. */
  vaultDir?: string;
}) {
  const layout = options.layout ?? resolveWorkspaceLayout({ fallbackCwd: options.cwd });
  const sandboxed = options.sandboxed ?? process.env.RAYTONEBOT_SANDBOX === "1";
  const vaultDir = resolvePath(sandboxed ? `${options.dataDir ?? defaultDataDir()}.vault` : options.vaultDir ?? process.env.RAYTONEBOT_VAULT_DIR ?? `${options.dataDir ?? defaultDataDir()}.vault`);
  const privatePaths = [options.dataDir ?? defaultDataDir(), `${options.dataDir ?? defaultDataDir()}.provider-secrets`, vaultDir];
  // Bound below: the setup needs the channel manager, which needs the controller.
  let channelSetup: ReturnType<typeof createChannelSetup> | undefined;
  let routines: RoutineService | undefined;
  const dataDir = options.dataDir ?? defaultDataDir();
  const providers = new ProviderStore(join(`${dataDir}.provider-secrets`, "providers.enc"));
  const vault = new VaultStore(join(vaultDir, "logins.enc"));
  const bots = new BotConfigStore(join(dataDir, "bots.json"));
  const skills = createBotSkillsService({ dataDir });
  const store = createConversationStore(dataDir);
  const mcp = createMcpService({ dataDir, log: runtimeLogger(dataDir) });
  const memory = createMemoryService({ dataDir, log: runtimeLogger(dataDir) });
  const browser = options.browser === false ? undefined : options.browser ?? createBrowserService({ dataDir, log: runtimeLogger(dataDir) });
  const controller = createPiRuntimeController({ ...options, layout, store, bots, providers, vault, vaultDir, channelSetup: (run) => channelSetup!.run(run),
    createRoutine: (input) => routines!.create(input), mcpTools: (botId) => mcp.toolkit(botId ? bots.require(botId).mcpServerIds : undefined, serverId => !botId || bots.require(botId).mcpServerIds?.includes(serverId) !== false), memory, skills, browser });
  routines = createRoutineService({ dataDir, bots, runtime: controller, permissionMode: controller.defaultPermissionMode, log: runtimeLogger(dataDir) });
  const stopClock = options.routineClock === false ? undefined : routines.startClock();
  // Starts the enabled channels; the vite plugin creates this host when its server starts.
  const channels = createChannelManager({ bots, runtime: controller, dataDir, defaultPermissionMode: controller.defaultPermissionMode, log: runtimeLogger(dataDir), factories: options.channelFactories });
  channelSetup = createChannelSetup(channels);

  return {
    controller,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith(PI_API_PREFIX)) return false;
      // Defense in depth: the vite plugin guards first; this keeps the controller safe
      // however it is mounted (a cross-origin page must not drive tools in this cwd).
      if (!sameOriginRequestAllowed(req)) {
        sendJson(res, 403, { error: "Cross-origin Pi requests are not allowed." });
        return true;
      }
      setLocalHeaders(res);
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return true;
      }

      try {
        const vaultAnswer = new RegExp(`^${PI_API_PREFIX}/vault/requests/([^/]+)/answer$`).exec(url.pathname);
        if (vaultAnswer) {
          if (req.method !== "POST") { sendJson(res, 405, { error: "Method not allowed." }); return true; }
          if (req.headers["x-raytone-vault"] !== "1" || !req.headers.origin) { sendJson(res, 403, { error: "Confirm Vault use in the RaytoneBot web app." }); return true; }
          if (sandboxed) requireAgentIsolation({ ...process.env, RAYTONEBOT_SANDBOX: "1" });
          let body: Record<string, unknown>;
          try { body = await readJson(req); } catch { throw new VaultRequestError("Invalid Vault request.", 400); }
          const conversationId = stringField(body, "conversationId"), runId = stringField(body, "runId");
          if (!conversationId || !runId) throw new VaultRequestError("Invalid Vault request.", 400);
          if (!controller.resolveVaultInput) throw new VaultRequestError("Vault is unavailable.", 503);
          sendJson(res, 200, await controller.resolveVaultInput(conversationId, vaultAnswer[1], runId, body.answer));
          return true;
        }
        if (url.pathname === `${PI_API_PREFIX}/vault`) {
          // A custom header prevents cross-site simple requests; this is not same-UID isolation.
          if (req.headers["x-raytone-vault"] !== "1") { sendJson(res, 403, { error: "Open Vault in Settings." }); return true; }
          if (sandboxed) requireAgentIsolation({ ...process.env, RAYTONEBOT_SANDBOX: "1" });
          if (req.method === "GET") sendJson(res, 200, vault.view());
          else if (req.method === "POST" || req.method === "DELETE") {
            let body: Record<string, unknown>;
            try { body = await readJson(req); } catch { throw new VaultError("Invalid Vault request."); }
            sendJson(res, 200, req.method === "POST" ? vault.save(body.item, body.revision) : vault.remove(typeof body.id === "string" ? body.id : "", body.revision));
          } else sendJson(res, 405, { error: "Method not allowed." });
          return true;
        }
        if (url.pathname === `${PI_API_PREFIX}/providers`) {
          if (req.method === "GET") sendJson(res, 200, providers.view());
          else if (req.method === "POST") {
            if (controller.health().activeRuns) throw new ProviderStoreError("Stop running tasks before saving model services.", 409);
            if (options.sandboxed ?? process.env.RAYTONEBOT_SANDBOX === "1") requireAgentIsolation({ ...process.env, RAYTONEBOT_SANDBOX: "1" });
            let body: Record<string, unknown>;
            try { body = await readJson(req); } catch { throw new ProviderStoreError("Invalid provider save request."); }
            // A turn may have started while the body was arriving. Keep this guard adjacent
            // to the synchronous save/cache invalidation so no running bridge is disposed.
            if (controller.health().activeRuns) throw new ProviderStoreError("Stop running tasks before saving model services.", 409);
            const saved = providers.save(body.providers, body.keys ?? {}, body.removeKeys ?? [], body.revision);
            controller.refreshProviders?.();
            sendJson(res, 200, saved);
          } else sendJson(res, 405, { error: "Unsupported provider operation." });
          return true;
        }
        if (url.pathname === `${PI_API_PREFIX}/bots` || url.pathname === `${PI_API_PREFIX}/bots/import`) {
          try {
            if (req.method === "GET" && url.pathname.endsWith("/bots")) sendJson(res, 200, bots.view());
            else if (req.method === "POST") {
              const body = await readJson(req);
              if (url.pathname.endsWith("/import")) {
                const view = bots.import(body.profiles);
                // Older browser-only history bindings become durable without changing an existing identity.
                const bindings = body.conversations;
                if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
                  for (const [id, botId] of Object.entries(bindings)) {
                    if (typeof botId !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(id)) continue;
                    const bot = view.profiles.find(bot => bot.id === botId), saved = store.get(id);
                    if (bot && saved && !saved.botId && !controller.getConversation(id)?.activeRunId && saved.agentPreset === bot.presetId)
                      store.setExtra(id, { botId });
                  }
                }
                sendJson(res, 200, view);
              } else { const saved = bots.save(body.bot, body.revision); controller.refreshTools(); sendJson(res, 200, saved); }
            } else sendJson(res, 405, { error: "Unsupported Bot operation." });
          } catch (error) {
            if (!(error instanceof BotConfigError)) throw error;
            sendJson(res, error.status, { error: error.message });
          }
          return true;
        }
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/health`) {
          sendJson(res, 200, controller.health());
          return true;
        }
        if (url.pathname === `${PI_API_PREFIX}/learning`) {
          try {
            if (req.method === "GET") sendJson(res, 200, controller.learning.state());
            else if (req.method === "POST") sendJson(res, 200, controller.learning.update(await readJson(req) as unknown as import("./learning/types.ts").LearningAction));
            else sendJson(res, 405, { error: "Unsupported RSL operation." });
          } catch (error) { if (!(error instanceof LearningError)) throw error; sendJson(res, error.status, { error: error.message }); }
          return true;
        }
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/usage`) {
          sendJson(res, 200, controller.usage());
          return true;
        }
        if (url.pathname === `${PI_API_PREFIX}/skills` || url.pathname === `${PI_API_PREFIX}/skills/remove`) {
          try {
            if (req.method === "GET" && url.pathname.endsWith("/skills")) sendJson(res, 200, skills.state());
            else if (req.method === "POST") {
              const body = await readJson(req);
              const saved = url.pathname.endsWith("/remove") ? skills.remove(typeof body.id === "string" ? body.id : "", body.revision) : skills.save(body.input, body.revision);
              controller.refreshTools();
              sendJson(res, 200, saved);
            } else sendJson(res, 405, { error: "Unsupported Skills operation." });
          } catch (error) { if (!(error instanceof SkillsError)) throw error; sendJson(res, error.status, { error: error.message }); }
          return true;
        }
        if (url.pathname === `${PI_API_PREFIX}/files`) {
          const scope = url.searchParams.get("scope");
          if (req.method === "GET") {
            sendJson(res, 200, await (url.searchParams.get("query") ? searchWorkspaceDocuments(layout, scope, url.searchParams.get("path") ?? "", url.searchParams.get("query"), privatePaths) : listWorkspaceFiles(layout, scope, url.searchParams.get("path") ?? "", privatePaths)));
            return true;
          }
          if (req.method === "POST") {
            sendJson(res, 201, await uploadWorkspaceFile(layout, scope, url.searchParams.get("name"), req, privatePaths));
            return true;
          }
        }
        if (url.pathname === `${PI_API_PREFIX}/documents`) {
          if (req.method === "GET") {
            const document = await readWorkspaceDocument(layout, url.searchParams.get("scope"), url.searchParams.get("path"), privatePaths);
            const source = controller.listConversations().flatMap(c => (c.documents ?? []).filter(d => d.scope === document.scope && d.path === document.path).map(d => ({ conversationId: c.id, title: c.title, artifactId: d.artifactId })))[0];
            sendJson(res, 200, { ...document, source });
          } else if (req.method === "POST" || req.method === "PUT") {
            if (controller.health().activeRuns) throw new WorkspaceFileError(409, "Wait for running tasks to finish before saving a document.");
            const body = await readJson(req), id = stringField(body, "conversationId"), artifactId = stringField(body, "artifactId");
            if (id && !controller.getConversation(id)) throw new WorkspaceFileError(404, "Source conversation is unavailable.");
            if (artifactId && artifactId.length > 1000) throw new WorkspaceFileError(400, "Invalid artifact reference.");
            const document = req.method === "PUT"
              ? await replaceWorkspaceDocument(layout, body.scope, body.path, body.content, body.version, privatePaths)
              : await createWorkspaceDocument(layout, body.scope, body.name, body.content, privatePaths);
            if (req.method === "PUT" && !id) {
              for (const source of controller.listConversations()) for (const reference of source.documents ?? []) {
                if (reference.scope === document.scope && reference.path === document.path) controller.registerDocument(source.id, { ...reference, updatedAt: Date.now() });
              }
            }
            if (id) {
              try { controller.registerDocument(id, { scope: document.scope, path: document.path, name: document.name, artifactId, updatedAt: Date.now() }); }
              catch { throw new WorkspaceFileError(500, `Document saved at ${document.path}, but its source could not be recorded. Check storage before retrying.`); }
            }
            sendJson(res, req.method === "POST" ? 201 : 200, { ...document, ...(id ? { source: { conversationId: id, title: controller.getConversation(id)?.title, artifactId } } : {}) });
          } else sendJson(res, 405, { error: "Unsupported document operation." });
          return true;
        }
        if ((req.method === "GET" || req.method === "HEAD") && url.pathname === `${PI_API_PREFIX}/files/download`) {
          const entry = await openWorkspaceFile(layout, url.searchParams.get("scope"), url.searchParams.get("path"), privatePaths);
          await sendWorkspaceFile(req, res, entry);
          return true;
        }
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/state`) {
          sendJson(res, 200, await controller.state(url.searchParams.get("conversationId") ?? undefined));
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/config`) {
          sendJson(res, 200, await controller.configure(await readJson(req)));
          return true;
        }
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/channels`) {
          sendJson(res, 200, { channels: channels.list() });
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/channels/setup`) {
          // Carries the bot token: answered from the channel store, never logged or put in events.
          const body = await readJson(req);
          const action = body.action;
          const conversationId = stringField(body, "conversationId"), requestId = stringField(body, "requestId");
          if (!conversationId || !requestId || (action !== "submit" && action !== "allow" && action !== "reject" && action !== "skip")) {
            sendJson(res, 400, { error: "conversationId, requestId and a valid action are required." });
          } else {
            try {
              sendJson(res, 200, { state: await channelSetup.answer(normalizeConversationId(conversationId), requestId, action, channelPatch(body).fields) ?? null });
            } catch (error) {
              if (!(error instanceof ChannelSetupError)) throw error;
              sendJson(res, error.status, { error: error.message });
            }
          }
          return true;
        }
        const channelMatch = url.pathname.match(new RegExp(`^${PI_API_PREFIX}/channels/([a-z]+)$`));
        if (req.method === "POST" && channelMatch) {
          const platform = channelMatch[1] as ChannelPlatform;
          if (!CHANNEL_PLATFORMS.includes(platform)) sendJson(res, 404, { error: "Unknown IM channel." });
          else sendJson(res, 200, { channels: channels.update(platform, channelPatch(await readJson(req))) });
          return true;
        }
        if (url.pathname === `${PI_API_PREFIX}/routines` || url.pathname.startsWith(`${PI_API_PREFIX}/routines/`)) {
          const [id, action] = url.pathname.slice(`${PI_API_PREFIX}/routines`.length).split("/").filter(Boolean).map(decodeURIComponent);
          try {
            if (req.method === "GET" && !id) sendJson(res, 200, { routines: routines.list() });
            else if (req.method === "POST" && id && action === "run") sendJson(res, 202, await routines.run(id, (await readJson(req)).occurrenceId));
            else if (req.method === "POST" && id && !action) sendJson(res, 200, routines.update(id, await readJson(req)));
            else if (req.method === "DELETE" && id && !action) { routines.remove(id); sendJson(res, 200, { ok: true }); }
            else sendJson(res, 404, { error: "Unknown routine request." });
          } catch (error) {
            if (!(error instanceof RoutineError)) throw error;
            sendJson(res, error.status, { error: error.message });
          }
          return true;
        }
        if (url.pathname.startsWith(`${PI_API_PREFIX}/browser/`)) {
          const action = url.pathname.slice(`${PI_API_PREFIX}/browser/`.length);
          if (!browser) { sendJson(res, 404, { error: "No browser on this host." }); return true; }
          if (req.method === "GET" && action === "state") { sendJson(res, 200, browser.view()); return true; }
          if (req.method === "GET" && action === "stream") {
            // Frames flow only while this stream is open: the Output panel opens it when visible.
            res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
            const stop = browser.watch((event) => {
              if (res.destroyed) return;
              // A slow viewer drops frames rather than queueing them.
              if (event.type === "frame" && res.writableLength > 1_000_000) return;
              res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.type === "frame" ? { data: event.data, width: event.width, height: event.height, seq: event.seq, capturedAt: event.capturedAt, pageId: event.pageId, inputId: event.inputId } : event.state)}\n\n`);
            });
            const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": keep-alive\n\n"); }, 15_000);
            res.once("close", () => { clearInterval(heartbeat); stop(); });
            return true;
          }
          if (req.method === "POST" && action === "control") {
            const { action: command, site, url: loginAddress, pageId } = await readJson(req);
            try {
              if (command === "login") {
                let destination: string;
                try { destination = browserLoginUrl(site, loginAddress); }
                catch (error) { sendJson(res, 400, { error: errorMessage(error) }); return true; }
                await browser.takeover(destination);
              }
              else if (command === "takeover") await browser.takeover();
              else if (command === "release") await browser.release();
              else if (command === "stop") await browser.stop();
              else if (command === "clear-logins") await browser.clearLogins();
              else if (command === "select-tab" && typeof pageId === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(pageId)) await browser.selectTab(pageId);
              else { sendJson(res, 400, { error: "action must be login, takeover, release, stop, clear-logins or select-tab (pageId required)." }); return true; }
              sendJson(res, 200, browser.view());
            } catch (error) { sendJson(res, 409, { error: errorMessage(error) }); }
            return true;
          }
          if (req.method === "POST" && action === "input") {
            const body = await readJson(req);
            const values = Array.isArray(body.inputs) ? body.inputs : [body.input];
            const inputs = values.map(browserInput);
            if (!inputs.length || inputs.length > 64 || inputs.some((input) => !input)) { sendJson(res, 400, { error: "Invalid browser input." }); return true; }
            if ((body.inputId !== undefined && (typeof body.inputId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(body.inputId))) || (body.pageId !== undefined && (typeof body.pageId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(body.pageId))) ||
              (body.controlEpoch !== undefined && (!Number.isSafeInteger(body.controlEpoch) || Number(body.controlEpoch) < 0))) { sendJson(res, 400, { error: "Invalid browser input target." }); return true; }
            // Freeze even legacy requests once per batch: a tab/control change rejects its remainder.
            const view = browser.view();
            const target = { pageId: typeof body.pageId === "string" ? body.pageId : view.pageId, controlEpoch: typeof body.controlEpoch === "number" ? body.controlEpoch : view.controlEpoch };
            const began = Date.now();
            try {
              for (let index = 0; index < inputs.length; index++) await browser.input(inputs[index]!, target, index === inputs.length - 1 ? body.inputId as string | undefined : undefined);
              runtimeLogger(dataDir)("browser.input_batch", { count: inputs.length, durationMs: Date.now() - began });
              sendJson(res, 200, { ok: true });
            }
            catch (error) { sendJson(res, 409, { error: errorMessage(error) }); }
            return true;
          }
          sendJson(res, 404, { error: "Unknown browser request." });
          return true;
        }
        if (url.pathname === `${PI_API_PREFIX}/memories` || url.pathname.startsWith(`${PI_API_PREFIX}/memories/`)) {
          const [id] = url.pathname.slice(`${PI_API_PREFIX}/memories`.length).split("/").filter(Boolean).map(decodeURIComponent);
          try {
            if (req.method === "GET" && !id) sendJson(res, 200, memory.state());
            else if (req.method === "POST" && id === "settings") {
              const before = memory.enabled;
              sendJson(res, 200, memory.setEnabled((await readJson(req)).enabled));
              // Pi sessions hold their tools: reopen them with or without remember / forget.
              if (memory.enabled !== before) controller.refreshTools();
            }
            else if (req.method === "POST") {
              const body = await readJson(req);
              const scope = body.scope as import("./memoryTypes.ts").MemoryScope | undefined;
              if (scope?.kind === "bot" && !bots.view().profiles.some(bot => bot.id === scope.id)) throw new MemoryError("Memory Bot is unavailable.", 404);
              if (scope?.kind === "group" && (typeof scope.id !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(scope.id) || scope.id.includes(".m.") || !store.get(scope.id)?.group)) throw new MemoryError("Memory group is unavailable.", 404);
              sendJson(res, id ? 200 : 201, { memory: id ? memory.update(id, body.text, scope) : memory.add(body.text, scope) });
            }
            else if (req.method === "DELETE" && id) { memory.remove(id); sendJson(res, 200, { ok: true }); }
            else sendJson(res, 404, { error: "Unknown memory request." });
          } catch (error) {
            if (!(error instanceof MemoryError)) throw error;
            sendJson(res, error.status, { error: error.message });
          }
          return true;
        }
        if (url.pathname === `${PI_API_PREFIX}/mcp` || url.pathname.startsWith(`${PI_API_PREFIX}/mcp/`)) {
          // Carries bearer tokens on save: answered from the MCP store, never logged or echoed.
          const [id, action] = url.pathname.slice(`${PI_API_PREFIX}/mcp`.length).split("/").filter(Boolean).map(decodeURIComponent);
          try {
            if (req.method === "GET" && !id) sendJson(res, 200, { servers: mcp.list() });
            else if (req.method === "POST" && !action) { sendJson(res, id ? 200 : 201, { server: await mcp.save(id, await readJson(req)) }); controller.refreshTools(); }
            else if (req.method === "POST" && id && action === "refresh") { sendJson(res, 200, { server: await mcp.refresh(id) }); controller.refreshTools(); }
            else if (req.method === "DELETE" && id && !action) { mcp.remove(id); sendJson(res, 200, { ok: true }); controller.refreshTools(); }
            else sendJson(res, 404, { error: "Unknown MCP request." });
          } catch (error) {
            if (!(error instanceof McpError)) throw error;
            sendJson(res, error.status, { error: error.message });
          }
          return true;
        }
        const branchMatch = url.pathname.match(new RegExp(`^${PI_API_PREFIX}/conversations/([^/]+)/branch$`));
        if (req.method === "POST" && branchMatch) {
          const body = await readJson(req);
          const result = controller.branchConversation(decodeURIComponent(branchMatch[1]), stringField(body, "beforeRunId") ?? "");
          sendJson(res, 201, { conversationId: result.conversation.id, draft: result.draft });
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/steer`) {
          const body = await readJson(req);
          const conversationId = stringField(body, "conversationId"), runId = stringField(body, "runId");
          const requestId = stringField(body, "requestId"), text = stringField(body, "text")?.trim();
          if (!conversationId || !runId || !requestId || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId) || !text || text.length > 16000 || text.startsWith("/")) {
            sendJson(res, 400, { error: "A conversation, active run, input id and plain text (up to 16000 characters) are required." });
          } else if (!await controller.steer(conversationId, runId, requestId, text)) {
            sendJson(res, 409, { error: "This run cannot accept input now. Keep the draft or add it to the follow-up queue." });
          } else sendJson(res, 200, { ok: true });
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/abort`) {
          const body = await readJson(req);
          const conversationId = stringField(body, "conversationId"), runId = stringField(body, "runId");
          if (body.conversationId !== undefined && !conversationId?.trim() || body.runId !== undefined && (!runId?.trim() || !conversationId?.trim())) {
            sendJson(res, 400, { error: "A targeted stop requires non-empty conversationId and runId strings." });
          } else if (!await controller.abort(conversationId, runId)) {
            sendJson(res, 409, { error: "This run is no longer active; no other run was stopped." });
          } else sendJson(res, 200, { ok: true });
          return true;
        }
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/approval`) {
          res.setHeader("cache-control", "no-store");
          const toolCallId = url.searchParams.get("toolCallId"), conversationId = url.searchParams.get("conversationId"), runId = url.searchParams.get("runId");
          if (!toolCallId || !conversationId || !runId) sendJson(res, 400, { error: "toolCallId, conversationId and runId are required." });
          else sendJson(res, 200, { pending: controller.hasApproval(toolCallId, conversationId, runId) });
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/approval`) {
          const body = await readJson(req);
          const toolCallId = stringField(body, "toolCallId");
          const decision = approvalDecision(body.decision);
          if (body.runId !== undefined && !stringField(body, "runId")) {
            sendJson(res, 400, { error: "runId must be a non-empty string." });
          } else if (!toolCallId || !decision) {
            sendJson(res, 400, { error: "toolCallId and a valid decision are required." });
          } else if (!controller.resolveApproval(toolCallId, decision, stringField(body, "conversationId"), stringField(body, "runId"))) {
            sendJson(res, 409, { error: "This Pi approval is no longer pending." });
          } else {
            sendJson(res, 200, { ok: true });
          }
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/input`) {
          const body = await readJson(req);
          const conversationId = stringField(body, "conversationId"), requestId = stringField(body, "requestId");
          if (!conversationId || !requestId) sendJson(res, 400, { error: "conversationId and requestId are required." });
          else {
            try {
              if (!controller.resolveUserInput(conversationId, requestId, body.answers)) sendJson(res, 409, { error: "This question was already answered or is no longer pending." });
              else sendJson(res, 200, { ok: true });
            } catch (error) { sendJson(res, 400, { error: errorMessage(error) }); }
          }
          return true;
        }
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/artifacts`) {
          sendJson(res, 200, await listArtifactCatalog({ store, layout, excluded: privatePaths, bots: bots.catalog(),
            query: url.searchParams.get("query") ?? undefined, conversationId: url.searchParams.get("conversationId") ?? undefined,
            limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor") ?? undefined }));
          return true;
        }
        if (req.method === "GET" && url.pathname === `${PI_API_PREFIX}/conversations`) {
          const query = url.searchParams.get("query") ?? undefined;
          if (query && query.length > 200) sendJson(res, 400, { error: "Search query must be at most 200 characters." });
          else {
            const conversations = controller.listConversations(query);
            const page = url.searchParams.has("limit") || url.searchParams.has("cursor")
              ? conversationSearchPage(conversations, query ?? "", Number(url.searchParams.get("limit") ?? 100), url.searchParams.get("cursor") ?? undefined)
              : { conversations };
            sendJson(res, 200, { ...page, unreadable: controller.conversationReadErrors() });
          }
          return true;
        }
        if (req.method === "GET" && url.pathname.startsWith(`${PI_API_PREFIX}/conversations/`) && url.pathname.endsWith("/live")) {
          const id = decodeURIComponent(url.pathname.slice(`${PI_API_PREFIX}/conversations/`.length, -"/live".length));
          const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
          res.statusCode = 200;
          res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          const follow = controller.followRun(id, Number.isFinite(after) ? after : 0, (event) => {
            if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
          });
          if (!follow) {
            // Nothing running: the saved conversation is complete; the client reads it instead.
            sendJson(res, 409, { error: "This conversation has no run in progress." });
            return true;
          }
          res.flushHeaders();
          const heartbeat = setInterval(() => {
            if (!res.destroyed) res.write("\n");
          }, 5_000);
          res.once("close", () => {
            clearInterval(heartbeat);
            follow.stop();
          });
          await follow.done;
          clearInterval(heartbeat);
          follow.stop();
          if (!res.destroyed) res.end();
          return true;
        }
        if (url.pathname.startsWith(`${PI_API_PREFIX}/conversations/`)) {
          const id = decodeURIComponent(url.pathname.slice(`${PI_API_PREFIX}/conversations/`.length));
          if (req.method === "GET") {
            const conversation = controller.getConversation(id);
            if (conversation && url.searchParams.get("summary") === "1") {
              const { events, cliSession: _cli, piSessionId: _pi, turns: _turns, branch: _branch, ...summary } = conversation;
              sendJson(res, 200, { ...summary, eventCount: events.length });
            } else if (conversation) sendJson(res, 200, conversation);
            else sendJson(res, 404, { error: "Conversation not found." });
            return true;
          }
          if (req.method === "DELETE") {
            controller.deleteConversation(id);
            sendJson(res, 200, { ok: true });
            return true;
          }
          if (req.method === "PATCH") {
            const raw = (await readJson(req)).title;
            const title = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
            if (!title || title.length > 80) sendJson(res, 400, { error: "A title of 1-80 characters is required." });
            else {
              const saved = controller.renameConversation(id, title);
              if (saved) sendJson(res, 200, { title: saved });
              else sendJson(res, 404, { error: "Conversation not found." });
            }
            return true;
          }
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/provider/test`) {
          const body = await readJson(req);
          const definition = asRecord(body.provider) as unknown as PiProviderDefinition;
          if (typeof definition.id !== "string" || typeof definition.baseUrl !== "string") {
            sendJson(res, 400, { error: "provider.id and provider.baseUrl are required." });
          } else {
            sendJson(res, 200, await controller.testProvider(definition, stringField(body, "apiKey")));
          }
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/approvals/clear`) {
          const body = await readJson(req);
          sendJson(res, 200, { alwaysAllowed: controller.clearApprovals(stringField(body, "agentPreset")) });
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/session/new`) {
          const body = await readJson(req);
          sendJson(res, 200, await controller.newSession(stringField(body, "conversationId")));
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/group/members`) {
          const body = await readJson(req);
          const id = stringField(body, "conversationId");
          if (!id || !Array.isArray(body.members)) sendJson(res, 400, { error: "conversationId and members are required." });
          else sendJson(res, 200, controller.setGroupMembers(id, body.members as string[], body.availableBots as PiPromptInput["availableBots"], stringField(body, "hostId")));
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/group/prompt`) {
          const body = await readJson(req);
          const prompt = stringField(body, "prompt")?.trim();
          const conversationId = stringField(body, "conversationId");
          if (!prompt || !conversationId) {
            sendJson(res, 400, { error: "prompt and conversationId are required." });
            return true;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.flushHeaders();
          const requestId = stringField(body, "requestId");
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write("\n"); }, 5_000);
          res.once("close", () => clearInterval(heartbeat));
          try {
            await controller.runGroupPrompt({
              referencedConversationIds: body.referencedConversationIds as PiPromptInput["referencedConversationIds"],
              conversationId, requestId, prompt, artifactSubmission: body.artifactSubmission as PiPromptInput["artifactSubmission"], attachments: body.attachments as PiPromptInput["attachments"],
              ...(Array.isArray(body.members) ? { members: body.members as string[] } : {}),
              availableBots: body.availableBots as PiPromptInput["availableBots"], botId: stringField(body, "botId"),
              provider: stringField(body, "provider"),
              model: stringField(body, "model"),
              thinkingLevel: stringField(body, "thinkingLevel"),
              permissionMode: permissionMode(body.permissionMode),
              claudeCodeModelSource: body.claudeCodeModelSource === "local-login" ? "local-login" : "provider",
              codexModelSource: body.codexModelSource === "local-login" ? "local-login" : "provider",
              locale: isAppLocale(body.locale) ? body.locale : undefined,
            }, (event) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); });
          } catch (error) {
            for (const event of piErrorTurnEvents({ prompt, message: errorMessage(error), runId: requestId, code: PROMPT_REJECTED })) {
              if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
            }
          } finally {
            clearInterval(heartbeat);
          }
          if (!res.destroyed) res.end();
          return true;
        }
        if (req.method === "POST" && url.pathname === `${PI_API_PREFIX}/prompt`) {
          const body = await readJson(req);
          const prompt = stringField(body, "prompt")?.trim();
          if (!prompt) {
            sendJson(res, 400, { error: "Pi prompt is required." });
            return true;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.flushHeaders();
          const conversationId = stringField(body, "conversationId");
          const requestId = stringField(body, "requestId");
          // A closed tab, reload or dropped connection leaves the run going; the browser can
          // reattach with GET /conversations/:id/live. Only an explicit stop ends it.
          // Proxies in front of the sandbox drop a response that stays silent; a CLI can go quiet
          // for a while (Codex retrying). Blank lines keep it open and are ignored by the client.
          const heartbeat = setInterval(() => {
            if (!res.destroyed) res.write("\n");
          }, 5_000);
          res.once("close", () => clearInterval(heartbeat));
          try {
            await controller.runPrompt({
              referencedConversationIds: body.referencedConversationIds as PiPromptInput["referencedConversationIds"],
              conversationId,
              availableBots: body.availableBots as PiPromptInput["availableBots"], botId: stringField(body, "botId"),
              requestId,
              prompt,
              artifactSubmission: body.artifactSubmission as PiPromptInput["artifactSubmission"],
              attachments: body.attachments as PiPromptInput["attachments"],
              provider: stringField(body, "provider"),
              model: stringField(body, "model"),
              thinkingLevel: stringField(body, "thinkingLevel"),
              permissionMode: permissionMode(body.permissionMode),
              agentPreset: isAgentPresetId(body.agentPreset) ? body.agentPreset : undefined,
              claudeCodeModelSource: body.claudeCodeModelSource === "local-login" ? "local-login" : "provider",
              codexModelSource: body.codexModelSource === "local-login" ? "local-login" : "provider",
              locale: isAppLocale(body.locale) ? body.locale : undefined,
            }, (event) => {
              if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
            });
          } catch (error) {
            // The 200 headers are already sent. Rejections need a terminal in this stream,
            // but must not be appended to (or stop) the conversation's existing active run.
            for (const event of piErrorTurnEvents({ prompt, message: errorMessage(error), runId: requestId, code: PROMPT_REJECTED })) {
              if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
            }
          } finally {
            clearInterval(heartbeat);
          }
          if (!res.destroyed) res.end();
          return true;
        }
        sendJson(res, 404, { error: "Unknown Pi endpoint." });
      } catch (error) {
        if (!res.headersSent) sendJson(res, error instanceof VaultRequestError ? error.statusCode : error instanceof ConversationRequestError || error instanceof VaultError || error instanceof ProviderStoreError || error instanceof BotConfigError || error instanceof WorkspaceFileError || error instanceof ConversationBranchError || error instanceof SearchPageError || error instanceof ArtifactCatalogError ? error.status : errorMessage(error).includes("already active") ? 409 : 500, { error: errorMessage(error) });
        else if (!res.destroyed) res.end();
      }
      return true;
    },
    dispose() {
      stopClock?.();
      void browser?.stop();
      channels.dispose();
      controller.dispose();
    },
  };
}

/** Only known fields of the right type; anything else is ignored, never stored. */
function channelPatch(body: Record<string, unknown>): ChannelPatch {
  const fields = asRecord(body.fields);
  const definition = asRecord(asRecord(body.model).definition);
  const model = stringField(asRecord(body.model), "model");
  return {
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    fields: Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length <= 4096)),
    ...(body.access === "open" || body.access === "allowlist" ? { access: body.access } : {}),
    ...(Array.isArray(body.allowUsers) ? { allowUsers: body.allowUsers.filter((id): id is string => typeof id === "string" && id.length <= 200) } : {}),
    ...(isAgentPresetId(body.agentPreset) ? { agentPreset: body.agentPreset } : {}),
    ...(typeof body.botId === "string" ? { botId: body.botId } : {}),
    ...(model && typeof definition.id === "string" && typeof definition.baseUrl === "string" && Array.isArray(definition.models)
      ? { model: { model, definition: {
        id: definition.id, name: stringField(definition, "name") ?? definition.id, baseUrl: definition.baseUrl,
        protocol: definition.protocol as PiProviderDefinition["protocol"], models: definition.models.filter((entry): entry is string => typeof entry === "string"),
        authMode: definition.authMode === "none" ? "none" : "required",
        ...(definition.modelOptions === undefined ? {} : { modelOptions: normalizeModelOptions(definition.modelOptions, definition.models as string[]) }),
        ...(stringField(definition, "apiKeyEnvVar") ? { apiKeyEnvVar: stringField(definition, "apiKeyEnvVar") } : {}),
      } } } : {}),
  };
}

/** The live view's input, checked field by field; anything else is refused. */
function browserInput(value: unknown): BrowserInput | undefined {
  const input = asRecord(value);
  const number = (key: string) => typeof input[key] === "number" && Number.isFinite(input[key]) ? input[key] as number : undefined;
  if (input.kind === "mouse" && ["move", "down", "up", "wheel"].includes(String(input.type))) {
    const x = number("x"), y = number("y");
    if (x === undefined || y === undefined || x < 0 || y < 0 || x > 4000 || y > 4000) return undefined;
    const button = ["left", "right", "middle"].includes(String(input.button)) ? input.button as "left" | "right" | "middle" : undefined;
    return { kind: "mouse", type: input.type as "move", x, y, ...(button ? { button } : {}),
      ...(number("deltaX") !== undefined ? { deltaX: Math.max(-5000, Math.min(5000, number("deltaX")!)) } : {}),
      ...(number("deltaY") !== undefined ? { deltaY: Math.max(-5000, Math.min(5000, number("deltaY")!)) } : {}) };
  }
  if (input.kind === "key" && (input.type === "down" || input.type === "up") && typeof input.key === "string" && input.key.length <= 20) return { kind: "key", type: input.type, key: input.key };
  if (input.kind === "text" && typeof input.text === "string" && input.text.length <= 2000) return { kind: "text", text: input.text };
  return undefined;
}

function permissionMode(value: unknown): PiPermissionMode {
  return value === "auto" || value === "allow-all" ? value : "request";
}

function approvalDecision(value: unknown): PiApprovalDecision | undefined {
  return value === "yes" || value === "always" || value === "no" ? value : undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Pi request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Pi request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function setLocalHeaders(res: ServerResponse) {
  // Intentionally no CORS opt-in. The browser client is same-origin with Vite; allowing another
  // origin to call these endpoints would let an unrelated page drive tools in this cwd.
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}
