// Boot the installed DSH library without the CLI's automatic .env discovery.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(process.argv[2]);
const { runProfile } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh/profile-boot")).href);
const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-launch-environment")).href);
await runProfile({ profile: "acp", patchFiles: [process.argv[3]], args: [],
  environment: createLaunchEnvironmentSnapshot([{ source: "process", values: process.env }]) });
