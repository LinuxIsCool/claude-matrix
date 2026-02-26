import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MessageStore } from "../../core/MessageStore.js";
import type { NotificationBuffer } from "../../core/NotificationBuffer.js";

export function registerReadMessages(
  server: McpServer,
  store: MessageStore,
  buffer: NotificationBuffer,
): void {
  server.registerTool(
    "read_messages",
    {
      title: "Read Messages",
      description: "Read messages from your ClaudeMatrix inbox",
      inputSchema: {
        limit: z
          .number()
          .optional()
          .default(20)
          .describe("Max messages to return"),
      },
    },
    async ({ limit }) => {
      try {
        const result = await store.read({ limit });

        // Clear notification buffer after reading
        buffer.flush();

        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No messages." }],
          };
        }

        const formatted = result.messages.map((msg) => {
          const body =
            "body" in msg.content
              ? (msg.content as { body: string }).body
              : JSON.stringify(msg.content);
          const ago = Math.round((Date.now() - msg.origin_server_ts) / 1000);
          const project = msg["com.claudematrix.project_dir"] ?? "unknown";
          return `FROM: ${msg.sender} | PROJECT: ${project} | ${ago}s ago\n${body}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} message(s):\n\n${formatted.join("\n---\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Read failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
