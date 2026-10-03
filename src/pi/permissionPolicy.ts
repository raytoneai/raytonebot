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
 * - `protected`: reads or writes credentials, writes the bot's own code (or rebuilds it), or
 *   dumps the environment. Asks in every mode; "always allow" cannot cover it. Reading the
 *   bot's code is ordinary: it holds no secrets, and reviewing it is a normal request.
 * - `outward`: publishes, deploys, reaches remote hosts, uploads, or destroys outside the
 *   workspace. Asks unless the mode is "allow all".
 * - `mutating`: changes the workspace (shell, edit, write). Asks only under "request".
 * - `read`: everything else.
 */
export type ToolCallClass = "protected" | "outward" | "mutating" | "read";

export type PermissionPolicy = {
  cwd: string;
  protectedPaths: readonly string[];
  /** Readable freely; any change to them is `protected`. The bot's own code. */
  readOnlyPaths?: readonly string[];
};

const MUTATING_TOOLS = new Set(["bash", "edit", "write", "powershell", "codex"]);
/** File tools that change what they point at. */
const WRITING_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

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
  const extra = process.env.RAYTONEBOT_PROTECTED_PATHS?.split(":").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return [...paths, ...extra.map((entry) => resolve(entry))];
}

/**
 * The bot's own code, read-only to agents: only when they work elsewhere. In local development
 * the workspace *is* the app and editing it is the point.
 */
export function defaultReadOnlyPaths(options: { appRoot: string; workspaces: readonly string[] }): string[] {
  const appRoot = resolve(options.appRoot);
  return options.workspaces.some((workspace) => isWithin(resolve(workspace), appRoot)) ? [] : [appRoot];
}

export function classifyToolCall(toolName: string, args: unknown, policy: PermissionPolicy): ToolCallClass {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "powershell") {
    const command = typeof record.command === "string" ? record.command : "";
    if (commandTouchesProtected(command, policy)) return "protected";
    if (commandMentions(command, policy.readOnlyPaths ?? []) && commandMayWrite(command)) return "protected";
    if (isOutwardCommand(command)) return "outward";
    return "mutating";
  }
  for (const key of ["path", "file_path", "notebook_path"]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    if (pathIsProtected(value, policy)) return "protected";
    if (WRITING_TOOLS.has(name) && pathIsWithin(value, policy.readOnlyPaths ?? [], policy.cwd)) return "protected";
  }
  return MUTATING_TOOLS.has(name) ? "mutating" : "read";
}

export function pathIsProtected(path: string, policy: PermissionPolicy): boolean {
  return pathIsWithin(path, policy.protectedPaths, policy.cwd);
}

function pathIsWithin(path: string, roots: readonly string[], cwd: string): boolean {
  const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  const absolute = resolve(cwd, expanded);
  return roots.some((root) => isWithin(absolute, root));
}

function isWithin(path: string, root: string): boolean {
  const offset = relative(root, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

/** Environment dumps reveal whatever credentials the host process holds. */
const ENV_DUMP = /(^|[;&|(`\s])(env|printenv|export\s+-p|declare\s+-x|set)\s*($|[;&|)>`])|\/proc\/[^\s]*\/environ/;

function commandTouchesProtected(command: string, policy: PermissionPolicy): boolean {
  if (ENV_DUMP.test(command)) return true;
  return commandMentions(command, policy.protectedPaths);
}

function commandMentions(command: string, paths: readonly string[]): boolean {
  const home = homedir();
  return paths.some((path) => {
    const tilde = path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : undefined;
    const homeVar = tilde ? `$HOME/${path.slice(home.length + 1)}` : undefined;
    return [path, tilde, homeVar].some((form) => form && command.includes(form));
  });
}

/**
 * Could this shell command change files? Deliberately broad (anything that redirects, moves,
 * installs, rebuilds or rewrites in place), because a "yes" only means one more question. Reads,
 * searches, `git status/log/diff`, type checks and tests stay a "no".
 */
const WRITE_HINTS: readonly RegExp[] = [
  /(^|[^<>&\d])\d?>>?\s*(?!&)/,
  /\btee\b/,
  /\b(rm|mv|cp|ln|touch|mkdir|rmdir|chmod|chown|truncate|install|patch|unzip|rsync|dd)\b/,
  /\btar\b[^|;&]*\s-?[a-zA-Z]*x/,
  /\bsed\b[^|;&]*\s-[a-zA-Z]*i/,
  /\bperl\b[^|;&]*\s-[a-zA-Z]*i/,
  /\bgit\s+(checkout|reset|restore|clean|commit|apply|am|merge|rebase|pull|stash|switch|rm|mv|add)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|rm|uninstall|update|upgrade|link|exec|x|dlx|run\s+(build|preview|dev|deploy))\b/,
  /\b(npx|bunx|pnpx)\b/,
  /\bvite\s+build\b/,
  /\b(python3?|node|ruby|perl|deno|bun)\s+(-[a-zA-Z]*[ce]\b|[^-\s])/,
  /\b(bash|sh|zsh)\s+-[a-zA-Z]*c\b|\beval\b|\s-delete\b/,
];

function commandMayWrite(command: string): boolean {
  // Quoted text is data (`grep -E '=>'`, `echo "=== a ==="`); a quoted script still trips the
  // `sh -c` / `eval` / interpreter hints. Discarding output is not writing: `2>/dev/null`, `2>&1`.
  const stripped = command
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/\d?>>?\s*\/dev\/null/g, " ")
    .replace(/\d?>&\d/g, " ");
  return WRITE_HINTS.some((pattern) => pattern.test(stripped));
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
