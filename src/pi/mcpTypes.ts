/** MCP servers as the settings page sees them (ADR-037). Shared by server and browser; no Node imports. */

export type McpServerStatus = "off" | "ready" | "error";

export type McpServerView = {
  /** Also the tool prefix: `mcp__<id>__<tool>`. Lowercase letters, digits and dashes. */
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** A bearer token is saved; the token itself never leaves the server. */
  hasToken: boolean;
  status: McpServerStatus;
  /** Tool names the agents see, as last listed. */
  tools: string[];
  error?: string;
  checkedAt?: number;
};

export type McpServerInput = {
  name?: string;
  url?: string;
  /** Empty or absent keeps the saved token; `clearToken` removes it. */
  token?: string;
  clearToken?: boolean;
  enabled?: boolean;
};
