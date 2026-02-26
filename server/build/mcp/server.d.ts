import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRegistry } from "../core/AgentRegistry.js";
import type { MessageStore } from "../core/MessageStore.js";
import type { NotificationBuffer } from "../core/NotificationBuffer.js";
export interface McpDependencies {
    agentRegistry: AgentRegistry;
    messageStore: MessageStore;
    notificationBuffer: NotificationBuffer;
    selfAgentId: string;
}
export declare function createMcpServer(deps: McpDependencies): McpServer;
