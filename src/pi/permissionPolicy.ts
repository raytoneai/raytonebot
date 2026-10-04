import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * What a tool call touches, for the approval gate. Node-only.
 *
 * RaytoneBot runs in a disposable microVM, so work inside the workspace can be generous; what
 * must stay guarded is what outlives or escapes the VM — the bot's own secrets and code, and
 * actions that publish or reach other machines. As in the sandboxed agents we follow (Claude
 * Code's sandbox, OpenBot's policy gateway), credentials are refused outright rather than asked
 * about: no task needs them, and a prompt for them only trains a reflexive "allow".
 *
 * - `secret`: reads or writes credentials, or dumps the environment. Refused in every mode.
 * - `protected`: changes agent config, hooks or persona files, or the bot's own code (or rebuilds
 *   it). Asks in every mode; "always allow" cannot cover it. Reading any of them is ordinary:
 *   they hold no secrets, and an approval for a read only trains a reflexive "allow".
 * - `outward`: publishes, deploys, reaches remote hosts, uploads, or destroys history and trees
 *   that existed before the turn. Asks unless the mode is "allow all". Inside the sandbox the
 *   agent's egress firewall already stops pushes, deploys, ssh and uploads, and it holds no
 *   credentials for them, so those run and fail there instead of asking (as OpenAgentCore,
 *   nightly openbot and CopilotKit OpenBot treat their own sandboxes); publishing to the
 *   allowlisted package registries and destroying data still ask.
 * - `mutating`: changes the workspace (shell, edit, write). Asks only under "request".
 * - `read`: everything else.
 */
export type ToolCallClass = "secret" | "protected" | "outward" | "mutating" | "read";

export type PermissionPolicy = {
  cwd: string;
  /** Credentials: any access is refused. */
  secretPaths?: readonly string[];
  protectedPaths: readonly string[];
  /** Readable freely; any change to them is `protected`. The bot's own code. */
  readOnlyPaths?: readonly string[];
  /** Agents run behind the sandbox's egress firewall: only the model proxy and package registries. */
  egressContained?: boolean;
};

const MUTATING_TOOLS = new Set(["bash", "edit", "write", "powershell", "codex"]);
/** File tools that change what they point at. */
const WRITING_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

/** Credential locations every harness may otherwise read, and the bot's own data. */
export function defaultSecretPaths(options: { home?: string } = {}): string[] {
  const home = options.home ?? homedir();
  return [
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
}

/**
 * Files that keep acting after the turn: agent config and hooks in the workspace, the agent's
 * shell startup and package-manager config, plus RAYTONEBOT_PROTECTED_PATHS.
 */
export function defaultProtectedPaths(options: { workspaces: readonly string[]; agentHome?: string }): string[] {
  const paths: string[] = [];
  // Agent config inside the workspace would let one run plant hooks or settings for the next.
  for (const workspace of options.workspaces) {
    paths.push(...[".claude", ".codex", ".agents", ".git/hooks", ".mcp.json", ".npmrc"].map((entry) => resolve(workspace, entry)));
  }
  const home = options.agentHome ?? homedir();
  paths.push(...[".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".npmrc"].map((entry) => resolve(home, entry)));
  const extra = process.env.RAYTONEBOT_PROTECTED_PATHS?.split(":").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return [...paths, ...extra.map((entry) => resolve(entry))];
}

/**
 * Readable freely, changed only with approval. The bot's own code, when agents work elsewhere (in
 * local development the workspace *is* the app and editing it is the point), and the persona
 * files: they reach every later prompt, so an agent must not rewrite them unasked.
 */
export function defaultReadOnlyPaths(options: { appRoot: string; workspaces: readonly string[] }): string[] {
  const appRoot = resolve(options.appRoot);
  const personas = options.workspaces.flatMap((workspace) => ["SOUL.md", "USER.md"].map((entry) => resolve(workspace, entry)));
  return [...(options.workspaces.some((workspace) => isWithin(resolve(workspace), appRoot)) ? [] : [appRoot]), ...personas];
}

export function classifyToolCall(toolName: string, args: unknown, policy: PermissionPolicy): ToolCallClass {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const name = toolName.toLowerCase();
  const callCwd = typeof record.cwd === "string" ? resolve(policy.cwd, record.cwd) : policy.cwd;
  if (name === "bash" || name === "powershell") {
    const command = typeof record.command === "string" ? record.command : "";
    if (ENV_DUMP.test(command) || pathIsWithin(callCwd, policy.secretPaths ?? [], policy.cwd) || commandMentions(command, policy.secretPaths ?? [])) return "secret";
    const guarded = [...policy.protectedPaths, ...(policy.readOnlyPaths ?? [])];
    if ((pathIsWithin(callCwd, guarded, policy.cwd) || commandMentions(command, guarded, callCwd)) && commandMayWrite(command)) return "protected";
    if (DESTRUCTIVE_COMMANDS.some((pattern) => pattern.test(command))) return "outward";
    if (!policy.egressContained && NETWORK_COMMANDS.some((pattern) => pattern.test(command))) return "outward";
    return "mutating";
  }
  const paths = [record.path, record.file_path, record.notebook_path, ...(Array.isArray(record.paths) ? record.paths : [])];
  // Check every target before returning a lesser classification: one native Codex patch can
  // contain both ordinary files and a credential path (including rename destinations).
  const targets = paths.filter((value): value is string => typeof value === "string");
  if (targets.some((value) => pathIsWithin(value, policy.secretPaths ?? [], callCwd))) return "secret";
  for (const value of targets) {
    if (typeof value !== "string") continue;
    if (WRITING_TOOLS.has(name) && pathIsWithin(value, [...policy.protectedPaths, ...(policy.readOnlyPaths ?? [])], callCwd)) return "protected";
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

/** With `cwd`, a path written relative to it (`SOUL.md`, `../shared/USER.md`) counts too. */
function commandMentions(command: string, paths: readonly string[], cwd?: string): boolean {
  const home = homedir();
  return paths.some((path) => {
    const tilde = path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : undefined;
    const homeVar = tilde ? `$HOME/${path.slice(home.length + 1)}` : undefined;
    const local = cwd && relative(cwd, path);
    return [path, tilde, homeVar, local].some((form) => form && command.includes(form));
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
  /\b(npx|bunx|pnpx)\b/,
  /\bvite\s+build\b/,
  /\b(python3?|node|ruby|perl|deno|bun)\s+(-[a-zA-Z]*[ce]\b|[^-\s])/,
  /\b(bash|sh|zsh)\s+-[a-zA-Z]*c\b|\beval\b|\s-delete\b/,
];

/** Inspect the subcommand, not words in paths or trailing arguments such as `log --grep=reset`. */
function cliMayWrite(command: string): boolean {
  // Retain quoted option values as one token, including paths with spaces. This is a write
  // heuristic, not a shell parser; unknown global options remain conservative.
  // Subshells and command substitution start a new command too: `(git …)`, `$(git …)`, `` `git …` ``.
  const tokens = command.match(/(?:[^\s'"|;&()`]+|'[^']*'|"(?:[^"\\]|\\.)*")+|[|;&()`\n]/g) ?? [];
  const words = tokens.map((token) => token.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_match, single, double) => single ?? double));
  for (let index = 0; index < words.length; index++) {
    // `/usr/bin/git` is still git.
    const cli = words[index].split("/").pop();
    if (!/^(git|npm|pnpm|yarn|bun)$/.test(cli ?? "")) continue;
    let cursor = index + 1;
    while (words[cursor]?.startsWith("-")) {
      const option = words[cursor++];
      if (option === "--") break;
      if (/^--[^=]+=/.test(option)) continue;
      if (/^(-C|-c|-w|--git-dir|--work-tree|--namespace|--config-env|--prefix|--dir|--cwd|--filter|--workspace)$/.test(option)) {
        if (!words[cursor] || /^[|;&()`\n]$/.test(words[cursor])) return true;
        cursor++;
      } else if (!/^(--no-pager|--paginate|--bare|--literal-pathspecs|--no-optional-locks|--global|-g|--silent|--offline)$/.test(option)) {
        return true;
      }
    }
    const verb = words[cursor];
    if (cli === "git") {
      if (/^(checkout|reset|restore|clean|commit|apply|am|merge|rebase|pull|stash|switch|rm|mv|add)$/.test(verb)) return true;
    } else if (/^(i|install|ci|add|remove|rm|uninstall|update|upgrade|link|exec|x|dlx)$/.test(verb)
      || (verb === "run" && /^(build|preview|dev|deploy)$/.test(words[cursor + 1]))) return true;
  }
  // Double quotes still run substitutions inside them: `echo "$(git checkout .)"`.
  for (const [, inner] of command.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    if (/\$\(|`/.test(inner) && cliMayWrite(inner)) return true;
  }
  return false;
}

function commandMayWrite(command: string): boolean {
  // Quoted text is data (`grep -E '=>'`, `echo "=== a ==="`); a quoted script still trips the
  // `sh -c` / `eval` / interpreter hints. Discarding output is not writing: `2>/dev/null`, `2>&1`.
  const stripped = command
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/\d?>>?\s*\/dev\/null/g, " ")
    .replace(/\d?>&\d/g, " ");
  return cliMayWrite(command) || WRITE_HINTS.some((pattern) => pattern.test(stripped));
}

/** Reach other machines; outward only where nothing stops them (outside the sandbox). */
const NETWORK_COMMANDS: readonly RegExp[] = [
  /\bgit\s+push\b/,
  /\bgit\s+remote\s+(add|set-url)\b/,
  /\bdocker\s+(push|login)\b/,
  /\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+(create|delete)|secret|api)\b/,
  /\b(vercel|netlify|flyctl|fly|wrangler|firebase|heroku)\b[^|;&]*\b(deploy|publish|--prod)\b/,
  /\b(ssh|scp|sftp|rsync)\b[^|;&]*\S+@\S+|\b(scp|rsync)\b[^|;&]*\s\S+:\S*/,
  /\bcurl\b[^|;&]*(\s-T\b|--upload-file|\s-F\b|--form|--data-binary\s+@|-d\s+@)/,
];

/** Outward everywhere: package registries are reachable from the sandbox, and lost data is lost. */
const DESTRUCTIVE_COMMANDS: readonly RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\b(cargo|gem|twine|poetry)\s+publish\b|\btwine\s+upload\b/,
  /\bgit\s+reset\b[^|;&]*--hard\b|\bgit\s+clean\b[^|;&]*\s-[a-zA-Z]*f/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|~|\$HOME|\.\.)(\s|\/?$|\/\*)/,
  /\b(shutdown|reboot|halt|poweroff|mkfs(\.\w+)?)\b|\bdd\b[^|;&]*\bof=\/dev\//,
  /\bcrontab\s+-r\b|\bkill\s+-9\s+-1\b/,
];


