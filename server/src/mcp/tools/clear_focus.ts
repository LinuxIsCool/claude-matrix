import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRegistry } from "../../core/AgentRegistry.js";

/**
 * MCP tool: clear_focus
 *
 * Removes the live focus task for THIS agent. Persists `focus: null`
 * (rather than `undefined`) so downstream consumers can distinguish
 * "explicitly cleared" from "never set".
 *
 * Phase 1 of task-490 (Live Focus & Attention Graph). Backlog ID 490.
 */
export function registerClearFocus(
  server: McpServer,
  registry: AgentRegistry,
  _selfAgentId: string,
): void {
  server.registerTool(
    "clear_focus",
    {
      title: "Clear Focus",
      description:
        "Clear this agent's live focus task. The record is persisted " +
        "as focus=null (distinct from focus=undefined) so consumers " +
        "can detect explicit dismissal.",
      inputSchema: {},
    },
    async () => {
      try {
        await registry.clearFocus();
        return {
          content: [
            {
              type: "text" as const,
              text: "Focus cleared.",
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to clear focus: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
