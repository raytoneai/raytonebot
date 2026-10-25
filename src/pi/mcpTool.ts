import { defineTool } from "@earendil-works/pi-coding-agent";

import { hostToolContent, type McpToolkit } from "./mcpServers.ts";

/** Host tools as Pi tools: the user's MCP tools (ADR-037) and remember / forget (ADR-038).
 *  The bot process makes the call, after the gate. */
export function mcpPiTools(toolkit: Pick<McpToolkit, "specs" | "run">) {
  return toolkit.specs.map((spec) => defineTool({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    // Plain JSON Schema: Pi validates and coerces it like its own TypeBox schemas.
    parameters: spec.inputSchema as never,
    async execute(_id, params, signal) {
      const result = await toolkit.run(spec.name, params, signal);
      if (result.isError) throw new Error(result.text);
      return { content: hostToolContent(result), details: {} };
    },
  }));
}
