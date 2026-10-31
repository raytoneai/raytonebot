import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createMemoryService } from "./memories.ts";
import { exportMemories, restoreMemories } from "./memoryBackup.ts";

const cliPath = fileURLToPath(new URL("../../scripts/memory-backup.mjs", import.meta.url));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const cli = (...args: string[]) => spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", timeout: 5000 });

function fixture(t: TestContext, enabled = false) {
  const root = mkdtempSync(join(tmpdir(), "rtb-memory-backup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "source");
  mkdirSync(dataDir);
  const data = { version: 37, enabled, memories: [
    { id: "mlegacy", text: "Legacy shared preference.", createdAt: 1, updatedAt: 2 },
    { id: "mglobal", text: "Literal <img src=x> and [reference](https://example.com/a).", createdAt: 3, updatedAt: 4, scope: { kind: "global" } },
    { id: "mbot", text: "Assistant preference.", createdAt: 5, updatedAt: 6, scope: { kind: "bot", id: "assistant" },
      evidence: { url: "https://example.com/source?edition=2&lang=zh", checkedAt: "2024-02-29" }, source: { conversationId: "source-chat", agent: "assistant", botId: "assistant" } },
    { id: "mprivate", text: "Builder private preference.", createdAt: 7, updatedAt: 8, scope: { kind: "bot", id: "builder" } },
    { id: "mgroup", text: "Team group preference.", createdAt: 9, updatedAt: 10, scope: { kind: "group", id: "team" }, evidence: { url: "http://example.com/undated" } },
  ] };
  const raw = Buffer.from(`\n${JSON.stringify(data, null, 2).replaceAll("\n", "\r\n")}\n`);
  const file = join(dataDir, "memories.json");
  writeFileSync(file, raw, { mode: 0o600 });
  return { root, dataDir, file, data, raw, backupDir: join(root, "backup"), restoredDir: join(root, "restored") };
}

function privateFiles(directory: string, files: string[]) {
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const file of files) assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600, file);
}

test("memory backup preserves exact bytes and all scopes, with private durable receipts and a cold reload", async t => {
  for (const enabled of [false, true]) {
    const f = fixture(t, enabled);
    const exported = exportMemories({ dataDir: f.dataDir, outputDir: f.backupDir });
    assert.equal(exported.status, "completed");
    assert.equal(exported.operation, "export");
    assert.deepEqual(readdirSync(f.backupDir).sort(), ["manifest.json", "memories.json", "memories.md"]);
    assert.deepEqual(readFileSync(join(f.backupDir, "memories.json")), f.raw);
    const manifest = json(join(f.backupDir, "manifest.json"));
    assert.equal(manifest.format, "raytonebot-memory-backup");
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.version, 37);
    assert.equal(manifest.enabled, enabled);
    assert.equal(manifest.count, f.data.memories.length);
    assert.ok(Number.isFinite(Date.parse(manifest.createdAt)));
    for (const name of ["memories.json", "memories.md"]) {
      const bytes = readFileSync(join(f.backupDir, name));
      assert.deepEqual(manifest.files[name], { sha256: hash(bytes), bytes: bytes.length });
    }
    const markdown = readFileSync(join(f.backupDir, "memories.md"), "utf8");
    assert.match(markdown, /Legacy shared preference/);
    assert.match(markdown, /2024-02-29/);
    assert.doesNotMatch(markdown, /(?<!\\)<img|(?<!\\)\[reference\]\(https:/, "memory text must not become active Markdown or HTML");
    privateFiles(f.backupDir, ["manifest.json", "memories.json", "memories.md"]);

    const restored = restoreMemories({ backupDir: f.backupDir, dataDir: f.restoredDir });
    assert.equal(restored.operation, "restore");
    assert.equal(restored.status, "completed");
    assert.deepEqual(readFileSync(join(f.restoredDir, "memories.json")), f.raw);
    assert.deepEqual(readFileSync(f.file), f.raw);
    const receipt = json(join(f.restoredDir, "memory-restore.json"));
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.sha256, hash(f.raw));
    assert.equal(receipt.bytes, f.raw.length);
    assert.equal(receipt.count, f.data.memories.length);
    assert.equal(receipt.version, 37);
    assert.equal(receipt.enabled, enabled);
    privateFiles(f.restoredDir, ["memories.json", "memory-restore.json"]);
    const service = createMemoryService({ dataDir: f.restoredDir });
    assert.deepEqual(service.state(), { enabled, memories: f.data.memories });
    if (!enabled) {
      assert.equal(service.noteFor("fresh", { botId: "assistant", groupId: "team" })?.text, undefined);
      assert.equal(service.toolsFor({ conversationId: "fresh", agent: "assistant" }), undefined);
      service.setEnabled(true);
    }
    const tools = service.toolsFor({ conversationId: "fresh", agent: "assistant", botId: "assistant", groupId: "team" })!;
    const recalled = JSON.parse((await tools.run("recall_memories", { limit: 20 })).text);
    assert.deepEqual(recalled.memories.map((memory: { id: string }) => memory.id).sort(), ["mbot", "mglobal", "mgroup", "mlegacy"]);
    assert.deepEqual(recalled.memories.find((memory: { id: string }) => memory.id === "mbot").evidence, f.data.memories[2].evidence);
    assert.deepEqual(readFileSync(join(f.backupDir, "memories.json")), f.raw, "using a restored store must not rewrite its backup");
  }
});

test("export refuses missing, corrupt or invalid source memory without creating a backup", t => {
  for (const value of [undefined, "not JSON", "null", "[]", '\uFEFF{"enabled":true,"version":0,"memories":[]}', '{"enabled":true,"version":-1,"memories":[]}',
    JSON.stringify({ enabled: true, version: 0, memories: [{ id: "mx", text: "Fact", createdAt: 1, updatedAt: 1, scope: { kind: "bot", id: "unknown" } }] })]) {
    const f = fixture(t);
    if (value === undefined) rmSync(f.file); else writeFileSync(f.file, value);
    assert.throws(() => exportMemories({ dataDir: f.dataDir, outputDir: f.backupDir }));
    assert.equal(existsSync(f.backupDir), false);
    if (value === undefined) assert.equal(existsSync(f.file), false);
    else assert.equal(readFileSync(f.file, "utf8"), value);
  }
  const f = fixture(t);
  const oversized = Buffer.concat([Buffer.alloc(2 * 1024 * 1024 + 1, 0x20), f.raw]);
  writeFileSync(f.file, oversized);
  assert.throws(() => exportMemories({ dataDir: f.dataDir, outputDir: f.backupDir }), /bounded|limit|large/i);
  assert.equal(existsSync(f.backupDir), false);
  assert.deepEqual(readFileSync(f.file), oversized);
});

test("restore validates manifest, hashes, lengths, metadata and memory schema before creating a destination", t => {
  const cases: ((directory: string) => void)[] = [
    directory => rmSync(join(directory, "manifest.json")),
    directory => writeFileSync(join(directory, "manifest.json"), "not JSON"),
    directory => writeFileSync(join(directory, "manifest.json"), "null"),
    directory => rmSync(join(directory, "memories.json")),
    directory => rmSync(join(directory, "memories.md")),
    directory => writeFileSync(join(directory, "memories.md"), "tampered"),
    directory => {
      const path = join(directory, "memories.json");
      writeFileSync(path, readFileSync(path, "utf8").replace("Legacy", "Edited"));
    },
    ...["bytes", "count", "version", "enabled", "status", "file-name"].map(field => (directory: string) => {
      const path = join(directory, "manifest.json"), manifest = json(path);
      if (field === "bytes") manifest.files["memories.json"].bytes++;
      else if (field === "enabled") manifest.enabled = !manifest.enabled;
      else if (field === "status") manifest.status = "failed";
      else if (field === "file-name") { manifest.files["../memories.json"] = manifest.files["memories.json"]; delete manifest.files["memories.json"]; }
      else manifest[field]++;
      writeFileSync(path, JSON.stringify(manifest));
    }),
    directory => {
      const invalid = Buffer.from('{"enabled":true,"version":37,"memories":[{"id":"bad"}]}');
      writeFileSync(join(directory, "memories.json"), invalid);
      const manifest = json(join(directory, "manifest.json"));
      manifest.files["memories.json"] = { sha256: hash(invalid), bytes: invalid.length };
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
    },
  ];
  for (const [index, corrupt] of cases.entries()) {
    const f = fixture(t);
    exportMemories({ dataDir: f.dataDir, outputDir: f.backupDir });
    corrupt(f.backupDir);
    const before = readdirSync(f.backupDir).map(name => [name, readFileSync(join(f.backupDir, name))] as const);
    assert.throws(() => restoreMemories({ backupDir: f.backupDir, dataDir: f.restoredDir }), `corruption case ${index}`);
    assert.equal(existsSync(f.restoredDir), false);
    for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(f.backupDir, name)), bytes);
    assert.deepEqual(readFileSync(f.file), f.raw);
  }
});

test("neither backup operation overwrites an existing empty or occupied destination or creates missing parents", t => {
  const f = fixture(t);
  exportMemories({ dataDir: f.dataDir, outputDir: f.backupDir });
  for (const occupied of [false, true]) {
    const destination = join(f.root, occupied ? "occupied" : "empty");
    mkdirSync(destination);
    if (occupied) writeFileSync(join(destination, "keep.txt"), "User file");
    assert.throws(() => exportMemories({ dataDir: f.dataDir, outputDir: destination }));
    assert.throws(() => restoreMemories({ backupDir: f.backupDir, dataDir: destination }));
    assert.deepEqual(readdirSync(destination), occupied ? ["keep.txt"] : []);
    if (occupied) assert.equal(readFileSync(join(destination, "keep.txt"), "utf8"), "User file");
  }
  const missingParent = join(f.root, "missing-parent");
  assert.throws(() => exportMemories({ dataDir: f.dataDir, outputDir: join(missingParent, "export") }));
  assert.throws(() => restoreMemories({ backupDir: f.backupDir, dataDir: join(missingParent, "restore") }));
  assert.equal(existsSync(missingParent), false);
  assert.deepEqual(readFileSync(f.file), f.raw);
});

test("backup rejects symlinked roots, files and destinations without following or altering them", t => {
  const f = fixture(t);
  exportMemories({ dataDir: f.dataDir, outputDir: f.backupDir });
  const sourceAlias = join(f.root, "source-alias"), backupAlias = join(f.root, "backup-alias"), destinationAlias = join(f.root, "destination-alias");
  symlinkSync(f.dataDir, sourceAlias, "dir");
  symlinkSync(f.backupDir, backupAlias, "dir");
  symlinkSync(f.dataDir, destinationAlias, "dir");
  assert.throws(() => exportMemories({ dataDir: sourceAlias, outputDir: join(f.root, "unsafe-export") }));
  assert.throws(() => restoreMemories({ backupDir: backupAlias, dataDir: f.restoredDir }));
  assert.throws(() => exportMemories({ dataDir: f.dataDir, outputDir: destinationAlias }));
  assert.throws(() => restoreMemories({ backupDir: f.backupDir, dataDir: destinationAlias }));
  for (const name of ["manifest.json", "memories.json", "memories.md"]) {
    const saved = readFileSync(join(f.backupDir, name));
    const target = join(f.root, name);
    writeFileSync(target, saved);
    rmSync(join(f.backupDir, name)); symlinkSync(target, join(f.backupDir, name));
    assert.throws(() => restoreMemories({ backupDir: f.backupDir, dataDir: f.restoredDir }));
    assert.deepEqual(readFileSync(target), saved);
    rmSync(join(f.backupDir, name)); writeFileSync(join(f.backupDir, name), saved);
  }
  const sourceTarget = join(f.root, "source-bytes");
  writeFileSync(sourceTarget, f.raw); rmSync(f.file); symlinkSync(sourceTarget, f.file);
  assert.throws(() => exportMemories({ dataDir: f.dataDir, outputDir: join(f.root, "unsafe-file") }));
  assert.deepEqual(readFileSync(sourceTarget), f.raw);
  assert.equal(existsSync(f.restoredDir), false);
  const linked = fixture(t);
  exportMemories({ dataDir: linked.dataDir, outputDir: linked.backupDir });
  const sourceLink = join(linked.root, "source-hardlink"), backupLink = join(linked.root, "backup-hardlink");
  linkSync(linked.file, sourceLink);
  linkSync(join(linked.backupDir, "memories.json"), backupLink);
  assert.throws(() => exportMemories({ dataDir: linked.dataDir, outputDir: join(linked.root, "linked-export") }));
  assert.throws(() => restoreMemories({ backupDir: linked.backupDir, dataDir: linked.restoredDir }));
  assert.deepEqual(readFileSync(sourceLink), linked.raw);
  assert.deepEqual(readFileSync(backupLink), linked.raw);
});

test("special source files fail promptly instead of blocking or being treated as memory JSON", t => {
  for (const kind of ["directory", "fifo"]) {
    const f = fixture(t);
    exportMemories({ dataDir: f.dataDir, outputDir: f.backupDir });
    for (const file of [f.file, join(f.backupDir, "memories.json")]) {
      rmSync(file);
      if (kind === "directory") mkdirSync(file);
      else {
        const created = spawnSync("mkfifo", [file], { encoding: "utf8" });
        assert.equal(created.status, 0, created.stderr);
      }
    }
    const output = join(f.root, "rejected-export");
    for (const args of [["export", "--data-dir", f.dataDir, "--output", output], ["restore", "--backup", f.backupDir, "--data-dir", f.restoredDir]]) {
      const result = cli(...args);
      assert.notEqual(result.status, 0);
      assert.equal(result.signal, null, "special-file rejection must happen before any blocking read");
    }
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(f.restoredDir), false);
    assert.equal(statSync(f.file).isFIFO(), kind === "fifo");
  }
});

test("write failures leave source and existing destinations intact and never publish a completed result", t => {
  const f = fixture(t);
  exportMemories({ dataDir: f.dataDir, outputDir: f.backupDir });
  for (const [operation, interference] of [["export", false], ["restore", false], ["export", true]] as const) {
    const destination = join(f.root, `failed-${operation}-${interference}`);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const operation = process.argv[1], destination = process.argv[2];
      const write = fs.writeFileSync, open = fs.openSync, paths = new Map();
      fs.openSync = (path, ...args) => { const fd = open(path, ...args); paths.set(fd, String(path)); return fd; };
      fs.writeFileSync = (file, ...args) => {
        const path = typeof file === 'number' ? paths.get(file) : String(file);
        if (path?.endsWith(operation === 'export' ? 'memories.md' : 'memory-restore.json')) {
          if (process.argv[5] === 'true') {
            fs.renameSync(destination + '/memories.json', destination + '/moved-original.json');
            write(destination + '/memories.json', 'User replacement');
            write(destination + '/keep.txt', 'User addition');
          }
          throw Object.assign(new Error('Injected disk failure'), {code:'EIO'});
        }
        return write(file, ...args);
      };
      syncBuiltinESMExports();
      const { exportMemories, restoreMemories } = await import(${JSON.stringify(new URL("./memoryBackup.ts", import.meta.url).href)});
      try {
        if (operation === 'export') exportMemories({dataDir:process.argv[3],outputDir:destination});
        else restoreMemories({backupDir:process.argv[4],dataDir:destination});
        process.exitCode = 2;
      } catch (error) { process.stdout.write(error.message); }
    `, operation, destination, f.dataDir, f.backupDir, String(interference)], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Injected disk failure/);
    if (interference) {
      assert.deepEqual(readdirSync(destination).sort(), ["keep.txt", "memories.json", "moved-original.json"]);
      assert.equal(readFileSync(join(destination, "memories.json"), "utf8"), "User replacement");
      assert.equal(readFileSync(join(destination, "keep.txt"), "utf8"), "User addition");
      assert.deepEqual(readFileSync(join(destination, "moved-original.json")), f.raw);
    } else assert.equal(existsSync(destination), false, "failed output must be cleaned up, without a completed marker");
    assert.deepEqual(readFileSync(f.file), f.raw);
    assert.deepEqual(readFileSync(join(f.backupDir, "memories.json")), f.raw);
  }
});

test("the actual CLI requires explicit arguments, reports metadata only and preserves files on failure", t => {
  const f = fixture(t);
  const exported = cli("export", "--data-dir", f.dataDir, "--output", f.backupDir);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).status, "completed");
  assert.doesNotMatch(exported.stdout, /Legacy shared preference/);
  const restored = cli("restore", "--backup", f.backupDir, "--data-dir", f.restoredDir);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).status, "completed");
  assert.deepEqual(readFileSync(join(f.restoredDir, "memories.json")), f.raw);
  assert.equal(json(join(f.restoredDir, "memory-restore.json")).status, "completed");
  const privateInvalid = "RTBprivate dummy memory payload with invalid JSON";
  writeFileSync(f.file, privateInvalid);
  const corrupt = cli("export", "--data-dir", f.dataDir, "--output", join(f.root, "corrupt-export"));
  assert.notEqual(corrupt.status, 0);
  assert.doesNotMatch(corrupt.stdout + corrupt.stderr, /RTBprivate|dummy memory payload/, "parse errors must not echo private memory bytes");
  assert.equal(readFileSync(f.file, "utf8"), privateInvalid);
  assert.equal(existsSync(join(f.root, "corrupt-export")), false);
  writeFileSync(f.file, f.raw);
  for (const args of [[], ["export", "--data-dir", f.dataDir], ["restore", "--backup", f.backupDir],
    ["export", "--data-dir", f.dataDir, "--output", f.backupDir],
    ["restore", "--backup", f.backupDir, "--data-dir", f.restoredDir, "--force"]]) {
    const failed = cli(...args);
    assert.notEqual(failed.status, 0, JSON.stringify(args));
    assert.doesNotMatch(failed.stdout, /"status"\s*:\s*"completed"/);
    assert.deepEqual(readFileSync(f.file), f.raw);
    assert.deepEqual(readFileSync(join(f.restoredDir, "memories.json")), f.raw);
  }
  privateFiles(f.backupDir, ["manifest.json", "memories.json", "memories.md"]);
  privateFiles(f.restoredDir, ["memories.json", "memory-restore.json"]);
});
