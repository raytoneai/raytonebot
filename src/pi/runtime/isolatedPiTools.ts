import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { agentIsolationEnabled, spawnAgentProcess } from "./agentProcess.ts";
import { scrubSecretEnv } from "./childEnv.ts";
import { appendRecentStderr, createChildProcessTerminator } from "./process.ts";
import { runLimits } from "../hostOperations.ts";

/** Keep Pi's schema/rendering and approval wrapper; replace only the filesystem/shell execution. */
export function isolatePiTool<T extends { name: string; execute: (...args: any[]) => Promise<any> }>(definition: T, cwd: string): T {
  if (!agentIsolationEnabled()) return definition;
  return { ...definition, async execute(id: string, params: unknown, signal?: AbortSignal, onUpdate?: (result: unknown) => void, ctx?: { model?: { input?: unknown } }) {
    if (signal?.aborted) throw new Error("Operation aborted");
    const child = spawnAgentProcess(process.execPath, [fileURLToPath(new URL("./piToolWorker.ts", import.meta.url))], {
      cwd, env: scrubSecretEnv(process.env), detached: true,
    });
    let exited = false;
    let stderr = "";
    let result: unknown;
    let error: string | undefined;
    const terminate = createChildProcessTerminator(child, () => exited, undefined, { processGroup: true });
    const abort = () => terminate("abort");
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = appendRecentStderr(stderr, chunk); });
    let outputBytes = 0;
    const maxOutputBytes = runLimits().outputBytes;
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        error = "Isolated tool exceeded its output limit.";
        child.stdout.destroy();
        terminate("abort");
      }
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if ("update" in message) onUpdate?.(message.update);
        if ("result" in message) result = message.result;
        if (typeof message.error === "string") error = message.error;
      } catch { error = "Invalid isolated tool response."; terminate("abort"); }
    });
    child.stdin.on("error", () => terminate("abort"));
    child.stdin.end(JSON.stringify({ name: definition.name, id, params, model: ctx?.model ? { input: ctx.model.input } : undefined }));
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      if (signal?.aborted) throw new Error("Operation aborted");
      if (error || code !== 0 || result === undefined) throw new Error(error || stderr || "Isolated tool failed.");
      return result;
    } finally {
      exited = true;
      signal?.removeEventListener("abort", abort);
      lines.close();
      terminate("abort");
    }
  } } as T;
}
