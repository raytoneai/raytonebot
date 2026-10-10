/**
 * Group-chat collaboration health check: do the members speak in the expected turns? Content
 * quality is out of scope (that is the model's); this checks routing shape, who spoke, in what
 * order and how often, that every speaker said something, and that each turn ended cleanly.
 *
 * Runs against a live host over HTTP (default the local dev server), in new `group_eval-*`
 * conversations that are deleted afterwards.
 * Usage: node scripts/group-collab-eval/run.ts [label]
 * Env: RAYTONEBOT_URL (default http://127.0.0.1:5188), PROVIDER (deepseek), MODEL (deepseek-flash),
 *      CLI_SOURCE (provider | local-login), RUNS (2), ONLY (comma-separated scenario ids).
 */
import { writeFileSync } from "node:fs";

type Member = "assistant" | "planner" | "builder";
const A: Member = "assistant", P: Member = "planner", B: Member = "builder";
const NAME: Record<Member, string> = { assistant: "Raer", planner: "Tonny", builder: "Bob" };
type Expect = { mode: string; speakers: Member[]; ordered: boolean };
type Scenario = { id: string; turns: { prompt: string; expect: Expect }[] };

const ALL = [A, P, B];
const SCENARIOS: Scenario[] = [
  { id: "count-off", turns: [{ prompt: "大家报个数", expect: { mode: "round_robin", speakers: ALL, ordered: true } }] },
  { id: "count-from-bob", turns: [{ prompt: "从 Bob 开始报数", expect: { mode: "round_robin", speakers: [B, A, P], ordered: true } }] },
  { id: "idiom-chain", turns: [
    { prompt: "来个成语接龙，每人接一个", expect: { mode: "round_robin", speakers: ALL, ordered: true } },
    { prompt: "再来一轮", expect: { mode: "round_robin", speakers: ALL, ordered: true } },
  ] },
  { id: "couplet", turns: [
    { prompt: "你们搞一个对对联游戏，一个上联一个下联一个横批", expect: { mode: "round_robin", speakers: ALL, ordered: true } },
    { prompt: "照着这个节奏再来一轮", expect: { mode: "round_robin", speakers: ALL, ordered: true } },
  ] },
  { id: "brainstorm", turns: [{ prompt: "头脑风暴一下：每人说一个团建点子", expect: { mode: "parallel", speakers: ALL, ordered: false } }] },
  { id: "discussion", turns: [{ prompt: "你们讨论一下要不要给项目开 TypeScript strict 模式，最后给个结论",
    expect: { mode: "discussion", speakers: [A, P, B, A, P, B, A], ordered: true } }] },
  { id: "mention", turns: [{ prompt: "@Bob 报个数", expect: { mode: "mention", speakers: [B], ordered: true } }] },
];

const BASE = (process.env.RAYTONEBOT_URL ?? "http://127.0.0.1:5188") + "/__agentcanvas/pi";
const PROVIDER = process.env.PROVIDER ?? "deepseek", MODEL = process.env.MODEL ?? "deepseek-flash";
const CLI_SOURCE = process.env.CLI_SOURCE ?? "provider";
const RUNS = Number(process.env.RUNS ?? 2);
const TURN_LIMIT_MS = 5 * 60_000;
const label = process.argv[2] ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

type Observed = { mode?: string; route?: string; speakers: Member[]; empty: Member[]; status: string; error?: string; ms: number };

async function turn(conversationId: string, prompt: string): Promise<Observed> {
  const started = Date.now();
  const abort = new AbortController();
  const limit = setTimeout(() => abort.abort(), TURN_LIMIT_MS);
  const seen: Observed = { speakers: [], empty: [], status: "no terminal", ms: 0 };
  const texts = new Map<string, { member: Member; text: string }>();
  try {
    const response = await fetch(`${BASE}/group/prompt`, { method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
      body: JSON.stringify({ conversationId, requestId: `eval_${crypto.randomUUID()}`, prompt, members: ALL, provider: PROVIDER, model: MODEL,
        thinkingLevel: "medium", permissionMode: "request", claudeCodeModelSource: CLI_SOURCE, codexModelSource: CLI_SOURCE, locale: "zh" }) });
    let buffer = "";
    for await (const chunk of response.body!) {
      buffer += Buffer.from(chunk).toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const event = JSON.parse(line) as { type: string; messageId?: string; visibility?: string; payload?: Record<string, any> };
        const payload = event.payload ?? {};
        if (event.type === "tool.call.result" && event.visibility === "debug" && typeof payload.resultPreview === "string") {
          seen.route = payload.resultPreview.slice(0, 160);
          seen.mode = payload.resultPreview.split(" ")[0];
        }
        if (event.type === "group.member.started") seen.speakers.push(payload.member);
        if (event.type === "text.delta" && event.messageId?.includes("~")) {
          const member = event.messageId.split("~")[0] as Member;
          const run = event.messageId.split(":")[0];
          const entry = texts.get(run) ?? { member, text: "" };
          entry.text += String(payload.delta ?? "");
          texts.set(run, entry);
        }
        // A plan confirmation waits for a person: this check never answers it.
        if (event.type === "run.awaiting_input" || payload.inputRequestId) { seen.status = "awaiting confirmation"; abort.abort(); }
        if (event.type === "run.finished") seen.status = String(payload.status);
        if (event.type === "run.error") { seen.status = "error"; seen.error = String(payload.message ?? "").slice(0, 200); }
      }
    }
  } catch (error) {
    if (seen.status === "no terminal") seen.status = abort.signal.aborted ? "timed out" : "transport error";
    seen.error ??= error instanceof Error ? error.message : String(error);
    await fetch(`${BASE}/abort`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId }) }).catch(() => undefined);
  } finally { clearTimeout(limit); }
  // Each member run is one speaking turn; it must have produced text.
  const spoken = [...texts.values()];
  for (const member of new Set(seen.speakers)) {
    const runs = seen.speakers.filter((m) => m === member).length;
    const withText = spoken.filter((t) => t.member === member && t.text.trim()).length;
    for (let i = withText; i < runs; i++) seen.empty.push(member);
  }
  seen.ms = Date.now() - started;
  return seen;
}

function problems(expect: Expect, seen: Observed): string[] {
  const out: string[] = [];
  if (seen.status !== "success") out.push(`ended ${seen.status}${seen.error ? `: ${seen.error}` : ""}`);
  if (seen.mode !== expect.mode) out.push(`route ${seen.mode ?? "none"} (expected ${expect.mode})`);
  const names = (list: Member[]) => list.map((m) => NAME[m]).join("→") || "nobody";
  const same = expect.ordered ? seen.speakers.join() === expect.speakers.join()
    : [...seen.speakers].sort().join() === [...expect.speakers].sort().join();
  if (!same) out.push(`speakers ${names(seen.speakers)} (expected ${names(expect.speakers)}${expect.ordered ? "" : ", any order"})`);
  if (seen.empty.length) out.push(`no text from ${names(seen.empty)}`);
  return out;
}

const rows: { run: number; scenario: string; turn: number; prompt: string; ok: boolean; problems: string[]; seen: Observed }[] = [];
for (let run = 1; run <= RUNS; run++) {
  for (const scenario of SCENARIOS.filter((s) => !process.env.ONLY || process.env.ONLY.split(",").includes(s.id))) {
    const conversationId = `group_eval-${scenario.id}-${Date.now().toString(36)}`;
    for (const [index, step] of scenario.turns.entries()) {
      const seen = await turn(conversationId, step.prompt);
      const found = problems(step.expect, seen);
      rows.push({ run, scenario: scenario.id, turn: index + 1, prompt: step.prompt, ok: found.length === 0, problems: found, seen });
      console.log(`${found.length ? "✗" : "✓"} run ${run} ${scenario.id}#${index + 1} ${Math.round(seen.ms / 1000)}s ${found.join("; ")}`);
    }
    await fetch(`${BASE}/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" }).catch(() => undefined);
  }
}
writeFileSync(`collab-${label}.json`, JSON.stringify(rows, null, 1));
const passed = rows.filter((r) => r.ok).length;
console.log(`\n${passed}/${rows.length} turns healthy (${RUNS} runs × ${rows.length / RUNS} turns)`);
