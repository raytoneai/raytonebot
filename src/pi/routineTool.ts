import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { RoutineRequest } from "./routines.ts";
import type { RoutineView } from "./routineTypes.ts";

/** Raer's `create_routine` (ADR-033): saves a routine switched off; the user turns it on in Settings. */
export function createRoutineTool(create: (request: RoutineRequest) => Promise<RoutineView>) {
  return defineTool({
    name: "create_routine", label: "Create routine",
    description: "Save a routine: instructions Raer runs on a schedule in its own conversation. It is created switched off. Returns the saved routine or an error.",
    promptGuidelines: [
      "Use create_routine when the user wants something done on a schedule (every morning, weekdays at 9, every Friday). Turn their wording into a five-field cron: minute hour day month weekday.",
      "Use the timezone the user names or that the conversation makes clear, as an IANA name (Asia/Shanghai). If it is unclear, ask before you call the tool.",
      "Write instructions that work without this conversation: what to check, where, and what to report.",
      "After it is saved, tell the user it is off until they turn it on in Settings → Routines, and that it runs on time only once the scheduling service is connected; until then they can use Run now there.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      title: Type.String({ description: "Short name, at most 80 characters." }),
      schedule: Type.String({ description: "Five-field cron, e.g. \"0 9 * * 1-5\" for weekdays at 9:00." }),
      timezone: Type.String({ description: "IANA timezone, e.g. Asia/Shanghai." }),
      instructions: Type.String({ description: "What to do on each run, self-contained." }),
    }),
    async execute(_toolCallId, params) {
      const routine = await create(params);
      return { content: [{ type: "text", text: JSON.stringify({ saved: true, enabled: routine.enabled, id: routine.id, title: routine.title, schedule: routine.schedule, timezone: routine.timezone }) }], details: routine };
    },
  });
}
