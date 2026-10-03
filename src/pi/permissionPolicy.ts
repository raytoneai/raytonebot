import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * What a tool call touches, for the approval gate. Node-only.
 *
 * RaytoneBot runs in a disposable microVM, so work inside the workspace can be generous; what
 * must stay guarded is what outlives or escapes the VM — the bot's own secrets and code, and
 * actions that publish or reach other machines. The levels follow the shape of openbot's
 * access model (workspace work runs, outward and credential access asks), reimplemented here.
 *
 * - `protected`: reads or writes credentials, the bot's own code, or dumps the environment.
 *   Asks in every mode; "always allow" cannot cover it.
 * - `outward`: publishes, deploys, reaches remote hosts, uploads, or destroys outside the
 *   workspace. Asks unless the mode is "allow all".
 * - `mutating`: changes the workspace (shell, edit, write). Asks only under "request".
 * - `read`: everything else.
 */
export type ToolCallClass = "protected" | "outward" | "mutating" | "read";

export type PermissionPolicy = {
  cwd: string;
  protectedPaths: readonly string[];
};

const MUTATING_TOOLS = new Set(["bash", "edit", "write", "powershell", "codex"]);

/** Credential locations every harness may otherwise read. */
export function defaultProtectedPaths(options: { appRoot: string; workspaces: readonly string[]; home?: string }): string[] {
  const home = options.home ?? homedir();
  const paths = [
    ".raytonebot",
    ".ssh",
    ".aws",
    ".netrc",
    ".git-credentials",
    ".config/gh",
    ".codex/auth.json",
    ".claude.json",
    ".claude/.credentials.json",
  ].map((entry) => resolve(home, entry));
  // Agent config inside the workspace would let one run plant hooks or settings for the next.
  for (const workspace of options.workspaces) {
    paths.push(...[".claude", ".codex", ".agents"].map((entry) => resolve(workspace, entry)));
  }
  // The app protects its own code only when the agents work elsewhere; in local development the
  // workspace *is* the app and editing it is the point.
  if (!options.workspaces.some((workspace) => isWithin(resolve(workspace), resolve(options.appRoot)))) {
    paths.push(resolve(options.appRoot));
  }
  const extra = process.env.RAYTONEBOT_PROTECTED_PATHS?.split(":").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return [...paths, ...extra.map((entry) => resolve(entry))];
}

export function classifyToolCall(toolName: string, args: unknown, policy: PermissionPolicy): ToolCallClass {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  if (toolName === "bash" || toolName === "powershell") {
    const command = typeof record.command === "string" ? record.command : "";
    if (commandTouchesProtected(command, policy)) return "protected";
    if (isOutwardCommand(command)) return "outward";
    return "mutating";
  }
  for (const key of ["path", "file_path", "notebook_path"]) {
    const value = record[key];
    if (typeof value === "string" && pathIsProtected(value, policy)) return "protected";
  }
  return MUTATING_TOOLS.has(toolName) ? "mutating" : "read";
}

export function pathIsProtected(path: string, policy: PermissionPolicy): boolean {
  const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  const absolute = resolve(policy.cwd, expanded);
  return policy.protectedPaths.some((protectedPath) => isWithin(absolute, protectedPath));
}

function isWithin(path: string, root: string): boolean {
  const offset = relative(root, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

/** Environment dumps reveal whatever credentials the host process holds. */
const ENV_DUMP = /(^|[;&|(`\s])(env|printenv|export\s+-p|declare\s+-x|set)\s*($|[;&|)>`])|\/proc\/[^\s]*\/environ/;

function commandTouchesProtected(command: string, policy: PermissionPolicy): boolean {
  if (ENV_DUMP.test(command)) return true;
  const home = homedir();
  return policy.protectedPaths.some((protectedPath) => {
    const tilde = protectedPath.startsWith(`${home}/`) ? `~/${protectedPath.slice(home.length + 1)}` : undefined;
    const homeVar = tilde ? `$HOME/${protectedPath.slice(home.length + 1)}` : undefined;
    return [protectedPath, tilde, homeVar].some((form) => form && command.includes(form));
  });
}

const OUTWARD_COMMANDS: readonly RegExp[] = [
  /\bgit\s+push\b/,
  /\bgit\s+remote\s+(add|set-url)\b/,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\b(cargo|gem|twine|poetry)\s+publish\b|\btwine\s+upload\b/,
  /\bdocker\s+(push|login)\b/,
  /\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+(create|delete)|secret|api)\b/,
  /\b(vercel|netlify|flyctl|fly|wrangler|firebase|heroku)\b[^|;&]*\b(deploy|publish|--prod)\b/,
  /\b(ssh|scp|sftp|rsync)\b[^|;&]*\S+@\S+|\b(scp|rsync)\b[^|;&]*\s\S+:\S*/,
  /\bcurl\b[^|;&]*(\s-T\b|--upload-file|\s-F\b|--form|--data-binary\s+@|-d\s+@)/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|~|\$HOME|\.\.)(\s|\/?$|\/\*)/,
  /\b(shutdown|reboot|halt|poweroff|mkfs(\.\w+)?)\b|\bdd\b[^|;&]*\bof=\/dev\//,
  /\bcrontab\s+-r\b|\bkill\s+-9\s+-1\b/,
];

function isOutwardCommand(command: string): boolean {
  return OUTWARD_COMMANDS.some((pattern) => pattern.test(command));
}
