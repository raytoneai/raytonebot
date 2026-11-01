import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Reuse the existing isolated browser check, keeping each batch's evidence separate.
const here = dirname(fileURLToPath(import.meta.url));
const destination = resolve(here, process.argv[2] ?? "visual");
mkdirSync(destination, { recursive: true });
const source = readFileSync(join(here, "../memory-improvements-2026-11-01/fixture-browser-check.mjs"), "utf8")
  .replace("const outputDir = dirname(new URL(import.meta.url).pathname);", `const outputDir = ${JSON.stringify(destination)};`);
const generated = join(here, `.fixtures-${randomUUID()}.mjs`);
try {
  writeFileSync(generated, source);
  await import(pathToFileURL(generated).href);
} finally {
  rmSync(generated, { force: true });
}
