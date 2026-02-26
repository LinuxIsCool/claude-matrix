import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRegistry } from "../core/AgentRegistry.js";
import type { MessageStore } from "../core/MessageStore.js";
import type { NotificationBuffer } from "../core/NotificationBuffer.js";
import { registerSendMessage } from "./tools/send_message.js";
import { registerReadMessages } from "./tools/read_messages.js";
import { registerListAgents } from "./tools/list_agents.js";

export interface McpDependencies {
  agentRegistry: AgentRegistry;
  messageStore: MessageStore;
  notificationBuffer: NotificationBuffer;
  selfAgentId: string;
}

export function createMcpServer(deps: McpDependencies): McpServer {
  const server = new McpServer(
    { name: "claudematrix", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );

  registerSendMessage(server, deps.messageStore, deps.agentRegistry);
  registerReadMessages(server, deps.messageStore, deps.notificationBuffer);
  registerListAgents(server, deps.agentRegistry, deps.selfAgentId);

  return server;
}
