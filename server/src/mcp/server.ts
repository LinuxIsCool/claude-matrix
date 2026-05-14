import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRegistry } from "../core/AgentRegistry.js";
import type { MessageStore } from "../core/MessageStore.js";
import type { NotificationBuffer } from "../core/NotificationBuffer.js";
import { registerSendMessage } from "./tools/send_message.js";
import { registerReadMessages } from "./tools/read_messages.js";
import { registerListAgents } from "./tools/list_agents.js";
import { registerSetFocus } from "./tools/set_focus.js";
import { registerClearFocus } from "./tools/clear_focus.js";

export interface McpDependencies {
  agentRegistry: AgentRegistry;
  messageStore: MessageStore;
  notificationBuffer: NotificationBuffer;
  selfAgentId: string;
}

export function createMcpServer(deps: McpDependencies): McpServer {
  const server = new McpServer(
    { name: "claude-matrix", version: "0.2.0" },
    {
      capabilities: {
        logging: {},
        experimental: { "claude/channel": {} },
      },
      instructions: [
        "Inter-agent messages from other Claude Code sessions on this machine",
        "arrive as <channel> tags with sender, sender_display, and event_id attributes.",
        "The source attribute varies by installation (e.g. plugin:claude-matrix:claude-matrix).",
        "Read them and respond naturally.",
        "To reply, use the send_message tool with the sender attribute value as the recipient agent_id.",
        "To see all online agents, use the list_agents tool.",
      ].join(" "),
    },
  );

  registerSendMessage(server, deps.messageStore, deps.agentRegistry);
  registerReadMessages(server, deps.messageStore, deps.notificationBuffer);
  registerListAgents(server, deps.agentRegistry, deps.selfAgentId);
  // Phase 1 of task-490: focus surface.
  registerSetFocus(server, deps.agentRegistry, deps.selfAgentId);
  registerClearFocus(server, deps.agentRegistry, deps.selfAgentId);

  return server;
}
