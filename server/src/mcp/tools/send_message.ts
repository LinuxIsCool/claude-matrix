import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MessageStore } from "../../core/MessageStore.js";
import type { AgentRegistry } from "../../core/AgentRegistry.js";

export function registerSendMessage(
  server: McpServer,
  store: MessageStore,
  registry: AgentRegistry,
): void {
  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description:
        "Send a message to another Claude Code agent on this machine",
      inputSchema: {
        to: z
          .string()
          .describe("Agent ID of the recipient (from list_agents)"),
        message: z.string().describe("Message text to send"),
      },
    },
    async ({ to, message }) => {
      try {
        // Block self-sends
        if (to === store.agentId) {
          return {
            content: [
              { type: "text" as const, text: "Cannot send a message to yourself." },
            ],
            isError: true,
          };
        }

        // Validate recipient exists
        const agents = await registry.getAll();
        const recipient = agents.find((a) => a.agent_id === to);
        if (!recipient) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Agent not found: ${to}\nAvailable agents: ${agents.map((a) => a.agent_id).join(", ") || "none"}`,
              },
            ],
            isError: true,
          };
        }

        const event = await store.send(to, message);
        return {
          content: [
            {
              type: "text" as const,
              text: `Message sent to ${recipient.display_name} (${recipient.project_dir})\nevent_id: ${event.event_id}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Send failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
