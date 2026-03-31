import * as os from "node:os";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileTransport } from "./transport/FileTransport.js";
import { AgentRegistry } from "./core/AgentRegistry.js";
import { MessageStore } from "./core/MessageStore.js";
import { NotificationBuffer } from "./core/NotificationBuffer.js";
import { createMcpServer } from "./mcp/server.js";

// --- Configuration from environment ---

const dataDir =
  process.env["CLAUDEMATRIX_DATA_DIR"] ??
  path.join(os.homedir(), ".claude", "local", "claudematrix");

const sessionId =
  process.env["CLAUDEMATRIX_SESSION_ID"] ?? process.env["CLAUDE_SESSION_ID"];

const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
const hostname = os.hostname();

// Derive agent ID: deterministic from session + hostname
const agentId = sessionId
  ? `session-${sessionId.slice(0, 8)}@${hostname}`
  : `pid-${process.pid}@${hostname}`;

// --- Compose the system ---

const transport = new FileTransport({ dataDir, agentId });

const agentRegistry = new AgentRegistry(transport, agentId);
const messageStore = new MessageStore(transport, agentId, projectDir);
const notificationBuffer = new NotificationBuffer(
  path.join(dataDir, "notifications"),
  agentId,
);

// Wire incoming messages to the notification buffer AND channel push
transport.onMessage(agentId, (event) => {
  // Existing: update notification buffer for hook-based fallback
  notificationBuffer.push(event);

  // Channel push: emit real-time notification for sessions with --channels
  // Accept both ClaudeMatrix types and raw Matrix types (from fleet-msg)
  const eventType = event.type as string;
  const isMessage =
    eventType === "com.claudematrix.message" ||
    eventType === "com.claudematrix.message.notice" ||
    eventType === "m.room.message";
  if (isMessage) {
    const body =
      "body" in event.content
        ? (event.content as { body: string }).body
        : JSON.stringify(event.content);
    const senderDisplay = event.sender
      .split("@")[0]
      .replace(/^(session-|pid-)/, "");

    mcpServer.server
      .notification({
        method: "notifications/claude/channel",
        params: {
          content: body,
          meta: {
            sender: event.sender,
            sender_display: senderDisplay,
            sender_project:
              event["com.claudematrix.project_dir"] ?? "",
            event_id: event.event_id,
          },
        },
      })
      .catch((err: unknown) => {
        // Non-fatal: channel may not be active (no --channels flag)
        console.error(
          "[Claude Matrix] Channel notification failed:",
          err,
        );
      });
  }
});

const mcpServer = createMcpServer({
  agentRegistry,
  messageStore,
  notificationBuffer,
  selfAgentId: agentId,
});

// --- Lifecycle ---

async function start(): Promise<void> {
  // Start transport (creates directories, starts watcher)
  await transport.start();

  // Register this agent
  await agentRegistry.register({
    agent_id: agentId,
    session_id: sessionId ?? `pid-${process.pid}`,
    project_dir: projectDir,
    hostname,
    pid: process.pid,
    claude_pid: process.ppid,
  });

  // Start heartbeat
  agentRegistry.startHeartbeat();

  // Write initial (empty) notification file so hooks have something to read
  notificationBuffer.writeNotificationFile();

  // Connect MCP server to stdio
  const stdioTransport = new StdioServerTransport();
  await mcpServer.connect(stdioTransport);

  // Log startup (stderr only — stdout is JSON-RPC)
  console.error(
    `[Claude Matrix] Agent ${agentId} started | project: ${projectDir} | data: ${dataDir}`,
  );
}

async function shutdown(): Promise<void> {
  console.error("[Claude Matrix] Shutting down...");
  agentRegistry.stopHeartbeat();
  try {
    await agentRegistry.unregister();
  } catch (err) {
    console.error("[Claude Matrix] Failed to unregister:", err);
  }
  try {
    await transport.stop();
  } catch (err) {
    console.error("[Claude Matrix] Failed to stop transport:", err);
  }
  process.exit(0);
}

// Graceful shutdown handlers
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

// Start
start().catch((err) => {
  console.error("[Claude Matrix] Fatal startup error:", err);
  process.exit(1);
});
