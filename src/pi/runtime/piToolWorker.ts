/** One unprivileged process per Pi tool call. The model loop and credentials stay in the bot. */
import * as pi from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();
process.umask(0o007);
const tools = [pi.createReadToolDefinition(cwd), pi.createBashToolDefinition(cwd, { exposeSessionEnvironment: false }),
  pi.createEditToolDefinition(cwd), pi.createWriteToolDefinition(cwd), pi.createGrepToolDefinition(cwd),
  pi.createFindToolDefinition(cwd), pi.createLsToolDefinition(cwd)];
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const { name, id, params, model } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error("Unknown Pi tool.");
  const result = await (tool.execute as (...args: any[]) => Promise<unknown>)(id, params, controller.signal,
    (result: unknown) => write({ update: result }), { model });
  write({ result });
} catch (error) {
  write({ error: error instanceof Error ? error.message : "Tool failed." });
  process.exitCode = 1;
}
