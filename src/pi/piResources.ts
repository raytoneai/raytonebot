import type * as PiSdk from "@earendil-works/pi-coding-agent";
import { agentIsolationEnabled } from "./runtime/agentProcess.ts";

/**
 * Resource loading for Pi sessions hosted in this process.
 *
 * Pi extensions and project settings run as code inside the host, which holds the app's keys.
 * The agent can write to its own cwd, so the project is untrusted (its `.pi/settings.json`,
 * packages and extensions are ignored) and no extensions load from anywhere. Context files
 * (`AGENTS.md`) still load only in local development. Sandbox resources must be read through
 * isolated tools: an agent-controlled symlink must never be followed by bot UID. Skills from the
 * developer's own machine (~/.agents, ~/.pi) never load, so local runs behave like the sandbox.
 * `appendSystemPrompt` is the role prompt (`rolePrompt.ts`), already read safely by the host.
 */
export async function createHostResources(pi: typeof PiSdk, cwd: string, appendSystemPrompt: string[] = []) {
  const agentDir = pi.getAgentDir();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    appendSystemPrompt,
    ...(agentIsolationEnabled() ? { noContextFiles: true, noPromptTemplates: true, noThemes: true, systemPrompt: "" } : {}),
  });
  await resourceLoader.reload();
  return { settingsManager, resourceLoader };
}
