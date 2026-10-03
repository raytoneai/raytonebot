import type * as PiSdk from "@earendil-works/pi-coding-agent";

/**
 * Resource loading for Pi sessions hosted in this process.
 *
 * Pi extensions and project settings run as code inside the host, which holds the app's keys.
 * The agent can write to its own cwd, so the project is untrusted (its `.pi/settings.json`,
 * packages and extensions are ignored) and no extensions load from anywhere. Context files
 * (`AGENTS.md`) and skills still load.
 */
export async function createHostResources(pi: typeof PiSdk, cwd: string) {
  const agentDir = pi.getAgentDir();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true });
  await resourceLoader.reload();
  return { settingsManager, resourceLoader };
}
