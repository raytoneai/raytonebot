/**
 * Local deployment state for the AgentMatrix adapter.
 *
 * `.agentmatrix/deployment.json` holds the resource identity (not secrets) so a
 * re-run resumes the same Workspace/Environment/Session instead of creating a
 * second instance. `.agentmatrix/access.json` holds the generated Basic Auth
 * password and is written 0600; both paths are gitignored.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { accessFile, stateFile } from "./config.mjs";

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
}

export function writeJson(file, value, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, file);
}

export function readState(root) {
  return readJson(stateFile(root)) ?? {};
}

export function writeState(root, state) {
  writeJson(stateFile(root), { ...state, updatedAt: new Date().toISOString() }, 0o600);
}

export function readAccess(root) {
  return readJson(accessFile(root)) ?? {};
}

export function writeAccess(root, access) {
  writeJson(accessFile(root), access);
}

export const stateExists = (root) => existsSync(stateFile(root));
