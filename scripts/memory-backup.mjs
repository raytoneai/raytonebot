#!/usr/bin/env node
import { exportMemories, MemoryBackupError, restoreMemories } from "../src/pi/memoryBackup.ts";

const [operation, ...args] = process.argv.slice(2);
try {
  const flags = operation === "export" ? ["--data-dir", "--output"] : operation === "restore" ? ["--backup", "--data-dir"] : [];
  if (!flags.length || args.length !== 4) throw new MemoryBackupError("Use export --data-dir PATH --output PATH or restore --backup PATH --data-dir PATH. Restore requires a stopped host and a new target directory.");
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!flags.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]?.trim() || args[i + 1].startsWith("--")) throw new MemoryBackupError("Exactly the required explicit path flags must be supplied; overwrite/force is unsupported.");
    values[args[i]] = args[i + 1];
  }
  const result = operation === "export" ? exportMemories({ dataDir: values["--data-dir"], outputDir: values["--output"] })
    : restoreMemories({ backupDir: values["--backup"], dataDir: values["--data-dir"] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof MemoryBackupError ? error.message : `Memory backup ${operation === "restore" ? "restore" : "export"} failed${typeof error?.code === "string" ? ` (${error.code})` : ""}.`;
  process.stderr.write(`${JSON.stringify({ status: "failed", operation: ["export", "restore"].includes(operation) ? operation : "unknown", error: message })}\n`);
  process.exitCode = 1;
}
