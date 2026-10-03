import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * "Always allow" decisions, per agent, kept across conversations and restarts. Node-only.
 *
 * Scoped to the agent rather than the conversation (as openbot keeps its grants): a new chat with
 * the same agent should not ask again for a tool the user already allowed it. Protected and
 * secret calls never consult this. The file lives in the bot's data directory, which agents
 * cannot read or write.
 */
export class ApprovalMemory {
  private readonly allowed = new Map<string, Set<string>>();
  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [agent, tools] of Object.entries(parsed)) {
        if (Array.isArray(tools)) this.allowed.set(agent, new Set(tools.filter((tool): tool is string => typeof tool === "string")));
      }
    } catch {
      // Missing or unreadable: start empty. Nothing is lost that the user cannot grant again.
    }
  }

  has(agent: string, toolName: string): boolean {
    return this.allowed.get(agent)?.has(toolName) ?? false;
  }

  add(agent: string, toolName: string) {
    const tools = this.allowed.get(agent) ?? new Set<string>();
    if (tools.has(toolName)) return;
    tools.add(toolName);
    this.allowed.set(agent, tools);
    this.save();
  }

  /** Forget one agent's grants, or every agent's. */
  clear(agent?: string) {
    if (agent === undefined) this.allowed.clear();
    else this.allowed.delete(agent);
    this.save();
  }

  list(): Record<string, string[]> {
    return Object.fromEntries([...this.allowed].filter(([, tools]) => tools.size > 0).map(([agent, tools]) => [agent, [...tools].sort()]));
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.list(), null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
