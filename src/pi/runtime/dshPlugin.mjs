import { connect } from "node:net";
import { pathToFileURL } from "node:url";

export const name = "raytone-bridge";
export const inject = ["tools", "approval"];

function hostCall(path, request, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Task stopped.")); return; }
    const socket = connect(path);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error("Task stopped."));
    signal.addEventListener("abort", abort, { once: true });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 12 * 1024 * 1024) { finish(new Error("Host tool output exceeded its limit.")); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const result = JSON.parse(buffer.slice(0, end));
        if (result.isError) finish(new Error(result.text)); else finish(undefined, result);
      } catch (error) { finish(error); }
    });
    socket.on("error", error => finish(error));
    socket.on("close", () => { if (!settled) finish(new Error("Host tool connection closed.")); });
  });
}

/** All tool dispatches, including native tools, require a host authorization. */
export async function apply(ctx, config) {
  const allowed = new Set();
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!exec.agent) return { kind: "deny", reason: "Missing RaytoneBot session." };
    const decision = await next();
    if (decision.kind === "deny" || decision.kind === "cancel") return decision;
    if (exec.signal.aborted) return { kind: "cancel" };
    const outcome = await ctx.approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId,
      signal: exec.signal, reason: "RaytoneBot tool authorization" });
    if (outcome === "allowed-once") { allowed.add(exec.token); return { kind: "allow" }; }
    return outcome === "cancelled" ? { kind: "cancel" } : { kind: "deny", reason: "RaytoneBot denied this operation." };
  }, { prepend: true });
  ctx.tools.guard(exec => allowed.has(exec.token) ? undefined : "Missing RaytoneBot authorization.");
  ctx.on("tools/result", exec => { allowed.delete(exec.token); });
  for (const spec of config.tools) {
    const call = (args, exec) => hostCall(config.socketPath, { sessionId: exec.agent.session.id, callId: exec.callId, name: spec.name, args }, exec.signal);
    if (spec.name === "browser_screenshot") {
      // The pinned DSH installation owns image capability checks and durable attachments.
      const { createMcpToolDefinition } = await import(pathToFileURL(config.mcpClientModule).href);
      ctx.tools.register(createMcpToolDefinition(ctx, { name: spec.name, rawName: spec.name,
        description: spec.description, inputSchema: spec.inputSchema,
        async call(args, exec) {
          const result = await call(args, exec);
          return { content: [{ type: "text", text: result.text }, ...(result.images ?? []).map(image => ({ type: "image", ...image }))] };
        },
      }));
      continue;
    }
    ctx.tools.register({
      name: spec.name, description: spec.description, parameters: spec.inputSchema,
      output: { schema: { type: "string" }, render: (_args, text) => [{ type: "text", text }] },
      async execute(args, exec) {
        return (await call(args, exec)).text;
      },
    });
  }
  ctx.provide("raytoneBridge", true);
}
