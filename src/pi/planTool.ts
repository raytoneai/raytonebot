import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { taskPlanSnapshot } from "../runtime/taskPlan.ts";

/** Pure session data: no filesystem, child process, or privileged resources. */
export const planTool = defineTool({
  name: "update_plan",
  label: "Update plan",
  description: "Save the complete current plan and each step's actual status.",
  promptGuidelines: ["For substantial multi-step work, use update_plan to share a short plan and update it as work progresses. Mark a step completed only after verifying its result. Skip planning for simple questions."],
  executionMode: "sequential",
  parameters: Type.Object({
    plan: Type.Array(Type.Object({
      step: Type.String({ minLength: 1, maxLength: 4000 }),
      status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
    }), { maxItems: 100 }),
    explanation: Type.Optional(Type.String({ maxLength: 8000 })),
  }),
  async execute(_id, params, signal) {
    signal?.throwIfAborted();
    const snapshot = taskPlanSnapshot("", params.plan, params.explanation);
    if (!snapshot) throw new Error("Invalid plan snapshot.");
    return { content: [{ type: "text", text: "Plan updated." }],
      details: { plan: snapshot.steps, explanation: snapshot.explanation } };
  },
});
