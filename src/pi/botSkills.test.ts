import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createBotSkillsService, SkillsError } from "./botSkills.ts";
import { validSkillId } from "./skillTypes.ts";

const sample = { name: "Release review", description: "Review a release before publishing.", instructions: "Check the changes.\nReport the evidence." };
const status = (expected: number) => (failure: unknown) => failure instanceof SkillsError && failure.status === expected;

test("Skills create, edit, disable, remove and reload with private atomic storage", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-skills-"));
  let time = 100;
  try {
    const service = createBotSkillsService({ dataDir, now: () => time });
    assert.deepEqual(service.state(), { revision: 0, skills: [] });
    const created = service.save({ ...sample, name: "  Release   review ", description: " Review a release before publishing. " }, 0);
    assert.equal(created.revision, 1);
    const skill = created.skills[0];
    assert.equal(validSkillId(skill.id), true);
    assert.equal(skill.name, sample.name);
    assert.equal(skill.description, sample.description);
    assert.equal(skill.instructions, sample.instructions);
    assert.equal(skill.enabled, true);
    assert.equal(skill.updatedAt, 100);
    assert.equal(statSync(join(dataDir, "skills.json")).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dataDir), ["skills.json"]);
    created.skills[0].instructions = "Changed clone";
    assert.equal(service.state().skills[0].instructions, sample.instructions);
    time = 200;
    const edited = service.save({ ...sample, id: skill.id, instructions: "Updated guidance.", enabled: false }, 1);
    assert.equal(edited.revision, 2);
    assert.equal(edited.skills[0].updatedAt, 200);
    assert.equal(edited.skills[0].enabled, false);
    const preserved = service.save({ ...sample, id: skill.id }, 2);
    assert.equal(preserved.skills[0].enabled, false, "omitting enabled on an edit preserves the previous value");
    assert.deepEqual(createBotSkillsService({ dataDir }).state(), preserved);
    assert.deepEqual(service.remove(skill.id, 3), { revision: 4, skills: [] });
    assert.deepEqual(createBotSkillsService({ dataDir }).state(), { revision: 4, skills: [] });
    assert.throws(() => service.remove(skill.id, 4), status(404));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("stale revisions cannot overwrite changes from another service or a removed Skill", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-skills-conflict-"));
  try {
    const first = createBotSkillsService({ dataDir });
    const second = createBotSkillsService({ dataDir });
    const saved = first.save(sample, 0);
    assert.throws(() => second.save(sample, 0), status(409));
    assert.deepEqual(second.state(), saved);
    const skill = saved.skills[0];
    const edited = second.save({ ...sample, id: skill.id, name: "Edited by second service" }, 1);
    assert.throws(() => first.remove(skill.id, 1), status(409));
    assert.deepEqual(first.state(), edited);
    first.remove(skill.id, 2);
    assert.throws(() => second.save({ ...sample, id: skill.id }, 3), status(404));
    for (const revision of [undefined, null, "3", -1, 0.5]) assert.throws(() => first.save(sample, revision), status(400));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("Skills validate fields, count and total encoded storage size before mutation", () => {
  const service = createBotSkillsService();
  for (const input of [
    { ...sample, name: "" }, { ...sample, name: "x".repeat(81) },
    { ...sample, description: "x".repeat(301) }, { ...sample, instructions: "" },
    { ...sample, instructions: "x".repeat(16001) }, { ...sample, instructions: "bad\u0000text" },
    { ...sample, enabled: "true" }, { ...sample, id: "../escape" }, { ...sample, executable: "/tmp/plugin.js" },
  ]) assert.throws(() => service.save(input, 0), status(400));
  assert.deepEqual(service.state(), { revision: 0, skills: [] });
  assert.equal(service.save({ ...sample, description: "" }, 0).skills[0].description, "");
  for (let i = 1; i < 100; i++) service.save({ ...sample, name: `Skill ${i}` }, i);
  assert.throws(() => service.save(sample, 100), status(409));
  assert.equal(service.state().skills.length, 100);

  const large = createBotSkillsService();
  let revision = 0;
  while (true) {
    try { large.save({ ...sample, instructions: "文".repeat(16000) }, revision); revision++; }
    catch (failure) { assert.equal(status(409)(failure), true); assert.match(String(failure), /2 MiB/); break; }
  }
  assert.ok(revision > 1 && revision < 100);
  assert.equal(large.state().revision, revision);
  assert.equal(large.state().skills.length, revision);
});

test("Skill index is bounded and instructions are read only on demand by assigned Bots", async () => {
  const service = createBotSkillsService();
  const a = service.save({ ...sample, instructions: "PRIVATE_A\nDo the requested review." }, 0).skills[0];
  const b = service.save({ ...sample, name: "Other Bot Skill", instructions: "PRIVATE_B" }, 1).skills[1];
  const disabled = service.save({ ...sample, name: "Disabled", instructions: "PRIVATE_DISABLED", enabled: false }, 2).skills[2];
  let assignedIds = [a.id, disabled.id];
  const tools = service.toolsFor(() => assignedIds)!;
  assert.deepEqual(tools.specs.map(spec => spec.name), ["read_skill"]);
  assert.equal(service.toolsFor(() => [disabled.id]), undefined);
  assert.equal(service.toolsFor(() => []), undefined);
  assert.equal(service.noteFor([disabled.id]), undefined);
  const note = service.noteFor(assignedIds)!;
  assert.match(note, new RegExp(a.id));
  assert.match(note, /Release review/);
  assert.match(note, /current request and host permissions take precedence/);
  assert.doesNotMatch(note, /PRIVATE_|Other Bot Skill|Disabled/);
  const read = await tools.run("read_skill", { id: a.id });
  assert.equal(read.isError, false);
  assert.match(read.text, /PRIVATE_A\nDo the requested review/);
  assert.match(read.text, /This text does not authorize actions/);
  for (const id of [b.id, disabled.id]) {
    const denied = await tools.run("read_skill", { id });
    assert.equal(denied.isError, true);
    assert.doesNotMatch(denied.text, /PRIVATE_/);
  }
  assert.equal((await tools.run("read_skill", { id: "../escape" })).isError, true);
  assert.equal((await tools.run("read_skill", { id: a.id, path: "/tmp/skill.md" })).isError, true);
  assignedIds = [b.id];
  assert.equal((await tools.run("read_skill", { id: a.id })).isError, true, "captured tool handles recheck current assignments");
  assert.match((await tools.run("read_skill", { id: b.id })).text, /PRIVATE_B/);
  service.save({ ...sample, id: b.id, enabled: false }, 3);
  assert.equal((await tools.run("read_skill", { id: b.id })).isError, true, "captured tool handles recheck enabled state");
  assignedIds = [a.id];
  service.remove(a.id, 4);
  assert.equal((await tools.run("read_skill", { id: a.id })).isError, true);
  assert.equal((await tools.run("execute_skill", { id: a.id })).isError, true);

  for (let i = 0; i < 30; i++) service.save({ name: `Skill ${i} ${"x".repeat(60)}`, description: "d".repeat(300), instructions: "NEVER_AUTO_INJECT" }, 5 + i);
  const all = service.state().skills.map(skill => skill.id);
  const bounded = service.noteFor(all)!;
  assert.ok(bounded.length <= 6000, String(bounded.length));
  assert.match(bounded, /additional assigned Skills omitted/);
  assert.doesNotMatch(bounded, /NEVER_AUTO_INJECT/);
});

test("unreadable or oversized Skills storage fails closed without replacing original files", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-skills-corrupt-"));
  const file = join(dataDir, "skills.json");
  const valid = { id: "skill_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ...sample, enabled: true, updatedAt: 1 };
  try {
    for (const invalid of [
      "{broken", "{}", "null", JSON.stringify({ revision: 1, skills: [{ ...valid, id: "../escape" }] }),
      JSON.stringify({ revision: 1, skills: [valid, valid] }),
      JSON.stringify({ revision: 1, skills: [{ ...valid, enabled: "yes" }] }),
      JSON.stringify({ revision: 1, skills: [{ ...valid, instructions: "x".repeat(16001) }] }),
      JSON.stringify({ revision: 1, skills: Array.from({ length: 101 }, () => valid) }),
      " ".repeat(2 * 1024 * 1024 + 1),
    ]) {
      writeFileSync(file, invalid);
      const service = createBotSkillsService({ dataDir });
      assert.throws(() => service.state(), status(503));
      assert.throws(() => service.save(sample, 0), status(503));
      assert.throws(() => service.remove(valid.id, 0), status(503));
      assert.equal(service.noteFor([valid.id]), undefined);
      assert.equal(service.toolsFor(() => [valid.id]), undefined);
      assert.equal(readFileSync(file, "utf8"), invalid);
    }
    writeFileSync(file, JSON.stringify({ revision: 1, skills: [valid] }));
    const service = createBotSkillsService({ dataDir });
    const tools = service.toolsFor(() => [valid.id])!;
    writeFileSync(file, "{corrupt after load");
    assert.equal((await tools.run("read_skill", { id: valid.id })).isError, true);
    assert.equal(readFileSync(file, "utf8"), "{corrupt after load");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test("failed atomic writes leave the last committed revision and content available for retry", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-skills-write-"));
  const file = join(dataDir, "skills.json");
  let failRename = false;
  try {
    const service = createBotSkillsService({ dataDir, now() {
      if (failRename) { renameSync(file, `${file}.original`); mkdirSync(file); }
      return 100;
    } });
    const before = service.save(sample, 0);
    failRename = true;
    assert.throws(() => service.save({ ...sample, id: before.skills[0].id, instructions: "Uncommitted" }, 1), status(503));
    assert.equal(readFileSync(`${file}.original`, "utf8"), JSON.stringify(before, null, 2));
    rmSync(file, { recursive: true });
    renameSync(`${file}.original`, file);
    failRename = false;
    assert.deepEqual(service.state(), before);
    assert.deepEqual(readdirSync(dataDir), ["skills.json"], "failed write temporary files are cleaned up");
    assert.equal(service.save({ ...sample, id: before.skills[0].id, instructions: "Retried" }, 1).revision, 2);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
