import * as os from "node:os";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileTransport } from "./transport/FileTransport.js";
import { AgentRegistry } from "./core/AgentRegistry.js";
import { MessageStore } from "./core/MessageStore.js";
import { NotificationBuffer } from "./core/NotificationBuffer.js";
import { createMcpServer } from "./mcp/server.js";
// --- Configuration from environment ---
const dataDir = process.env["CLAUDEMATRIX_DATA_DIR"] ??
    path.join(os.homedir(), ".claude", "local", "claudematrix");
const sessionId = process.env["CLAUDEMATRIX_SESSION_ID"] ?? process.env["CLAUDE_SESSION_ID"];
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
const notificationBuffer = new NotificationBuffer(path.join(dataDir, "notifications"), agentId);
// Wire incoming messages to the notification buffer
transport.onMessage(agentId, (event) => {
    notificationBuffer.push(event);
});
const mcpServer = createMcpServer({
    agentRegistry,
    messageStore,
    notificationBuffer,
    selfAgentId: agentId,
});
// --- Lifecycle ---
async function start() {
    // Start transport (creates directories, starts watcher)
    await transport.start();
    // Register this agent
    await agentRegistry.register({
        agent_id: agentId,
        session_id: sessionId ?? `pid-${process.pid}`,
        project_dir: projectDir,
        hostname,
        pid: process.pid,
    });
    // Start heartbeat
    agentRegistry.startHeartbeat();
    // Write initial (empty) notification file so hooks have something to read
    notificationBuffer.writeNotificationFile();
    // Connect MCP server to stdio
    const stdioTransport = new StdioServerTransport();
    await mcpServer.connect(stdioTransport);
    // Log startup (stderr only — stdout is JSON-RPC)
    console.error(`[Claude Matrix] Agent ${agentId} started | project: ${projectDir} | data: ${dataDir}`);
}
async function shutdown() {
    console.error("[Claude Matrix] Shutting down...");
    try {
        agentRegistry.stopHeartbeat();
        await agentRegistry.unregister();
        await transport.stop();
    }
    catch (err) {
        console.error("[Claude Matrix] Shutdown error:", err);
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
//# sourceMappingURL=index.js.map