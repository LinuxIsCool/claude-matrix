import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MessageStore } from "../../core/MessageStore.js";
import type { AgentRegistry } from "../../core/AgentRegistry.js";
export declare function registerSendMessage(server: McpServer, store: MessageStore, registry: AgentRegistry): void;
