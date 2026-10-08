/**
 * Routing eval over the product's own decision code (`routeGroupMessage`): rules, then DeepSeek.
 * Usage: node scripts/group-routing-eval/eval.ts <label> scripts/group-routing-eval/cases-h*.json
 * Key: DEEPSEEK_API_KEY (MODEL defaults to deepseek-flash). Writes results-<label>.json in the cwd.
 * h3-h5: the ADR-032 held-out sets; h6: follow-ups with context, written independently and frozen
 * before any run (sha256 42d120c8…). Run each version at least twice: one run varies by 1-2 cases.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { completeJson, GROUP_MEMBERS, routeGroupMessage } from "../../src/pi/groupChat.ts";

const MODEL = process.env.MODEL ?? "deepseek-flash";
const definition = { baseUrl: "https://api.deepseek.com/v1", protocol: "openai-compatible" as const };
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error("DEEPSEEK_API_KEY is not set.");
const ID: Record<string, string> = { raer: "assistant", tonny: "planner", bob: "builder" };
const NAME: Record<string, string> = { assistant: "raer", planner: "tonny", builder: "bob" };
type Case = { id: string; group?: string; message: string; history: [string, string][]; gold: { mode: string; members: string[] } };

const [label, ...files] = process.argv.slice(2);
const summary: Record<string, unknown> = { label, model: MODEL };
const all = [];
for (const file of files) {
  const cases: Case[] = JSON.parse(readFileSync(file, "utf8"));
  const set = cases[0].id.split("-")[0];
  const rows = [];
  for (const c of cases) {
    const lines = c.history.map(([a, t]) => ({ author: (a === "user" ? "user" : ID[a]) as never, text: t }));
    const started = Date.now();
    const { plan, raw } = await routeGroupMessage(c.message, { members: [...GROUP_MEMBERS], lines },
      (system, user) => completeJson(definition, key, MODEL, system, user));
    const pred = { mode: plan.source === "fallback" ? "supervisor" : plan.mode === "mention" ? "single" : plan.mode, members: plan.members.map((m) => NAME[m]) };
    const g = { ...c.gold, mode: c.gold.mode === "mention" ? "single" : c.gold.mode };
    const same = (a: string[], b: string[]) => a.join() === b.join();
    const orderless = set === "h6"; // h6 labels shape only for multi-member modes
    const ok = g.mode === "single" ? pred.mode === "single" && same(pred.members, g.members)
      : g.mode === "parallel" || g.mode === "supervisor" || (orderless && g.mode !== "sequential") ? pred.mode === g.mode
      : pred.mode === g.mode && same(pred.members, g.members);
    rows.push({ id: c.id, group: c.group, message: c.message, gold: g, pred, source: plan.source, raw, ms: Date.now() - started,
      grade: ok ? "correct" : pred.mode === "supervisor" ? "fallback" : "wrong" });
  }
  const count = (k: string) => rows.filter((r) => r.grade === k).length;
  summary[set] = { cases: rows.length, correct: count("correct"), fallback: count("fallback"), wrong: count("wrong"), rule: rows.filter((r) => r.source === "rule").length };
  all.push(...rows);
}
writeFileSync(`results-${label}.json`, JSON.stringify(all, null, 1));
console.log(JSON.stringify(summary));
for (const r of all) if (r.grade !== "correct") console.log(r.grade, r.id, r.source, JSON.stringify(r.pred), "gold", JSON.stringify(r.gold), r.message.slice(0, 40));
