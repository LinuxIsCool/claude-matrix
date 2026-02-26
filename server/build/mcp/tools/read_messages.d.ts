import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MessageStore } from "../../core/MessageStore.js";
import type { NotificationBuffer } from "../../core/NotificationBuffer.js";
export declare function registerReadMessages(server: McpServer, store: MessageStore, buffer: NotificationBuffer): void;
