import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRegistry } from "../../core/AgentRegistry.js";

export function registerListAgents(
  server: McpServer,
  registry: AgentRegistry,
  selfAgentId: string,
): void {
  server.registerTool(
    "list_agents",
    {
      title: "List Agents",
      description:
        "List all Claude Code agents discovered on this machine",
    },
    async () => {
      try {
        const agents = await registry.getAll();

        if (agents.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No agents discovered (you may be the only one running).",
              },
            ],
          };
        }

        const formatted = agents.map((a) => {
          const isSelf = a.agent_id === selfAgentId ? " (you)" : "";
          const age = Math.round(
            (Date.now() - a.last_heartbeat) / 1000,
          );
          return `${a.agent_id}${isSelf} | ${a.status} | project: ${a.project_dir} | last seen: ${age}s ago`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `${agents.length} agent(s):\n\n${formatted.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
