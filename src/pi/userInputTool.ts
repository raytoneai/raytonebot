import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { userQuestions, type UserAnswers, type UserQuestion } from "../runtime/userInput.ts";

export type UserInputRequest = { toolCallId: string; questions: UserQuestion[]; signal: AbortSignal };

/** Pure user interaction: no permissions, files, subprocesses, or credentials. */
export function userInputTool(ask: (request: UserInputRequest) => Promise<UserAnswers>) {
  return defineTool({
    name: "ask_user", label: "Ask user", description: "Ask 1–4 concise questions and wait for the user's choices or written answers. Never ask for passwords or API keys.",
    promptGuidelines: ["Use ask_user when missing user preferences or information would materially change the task. Tool permissions are handled separately. Do not invent answers if the user skips."],
    executionMode: "sequential",
    parameters: Type.Object({ questions: Type.Array(Type.Object({
      header: Type.String({ maxLength: 200 }), question: Type.String({ minLength: 1, maxLength: 4000 }),
      options: Type.Array(Type.Object({ label: Type.String({ minLength: 1, maxLength: 500 }), description: Type.String({ maxLength: 2000 }) }), { maxItems: 12 }),
      multiSelect: Type.Boolean(),
    }), { minItems: 1, maxItems: 4 }) }),
    async execute(toolCallId, params, signal) {
      const questions = userQuestions(params.questions, "claude");
      const answer = await ask({ toolCallId, questions, signal: signal ?? new AbortController().signal });
      const result = answer === null ? { skipped: true } : { answers: Object.fromEntries(questions.map((q) => [q.question, answer[q.id]])) };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
