import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { WEB_TOOL_SPECS, type WebToolName, type WebTools } from "./webAccess.ts";

const PARAMETERS = {
  web_search: Type.Object({
    query: Type.String({ minLength: 1, maxLength: 400 }),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    time_range: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")])),
  }),
  web_fetch: Type.Object({
    url: Type.String({ minLength: 1, maxLength: 4000 }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
};

/** Runs in the bot process like update_plan: the agent UID never opens the connection. */
export function webPiTools(web: WebTools) {
  return WEB_TOOL_SPECS.map((spec) => defineTool({
    name: spec.name,
    label: spec.name === "web_search" ? "Web search" : "Web fetch",
    description: spec.description,
    promptGuidelines: spec.name === "web_search"
      ? ["Use web_search for current events, facts you are unsure of, and anything after your training data; cite the URLs you rely on."]
      : [],
    parameters: PARAMETERS[spec.name as WebToolName],
    async execute(_id, params, signal) {
      const result = await web.run(spec.name, params, signal);
      if (result.isError) throw new Error(result.text);
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  }));
}
