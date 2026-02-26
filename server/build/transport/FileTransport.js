import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { watch } from "chokidar";
import { AGENT_STALE_THRESHOLD_MS } from "../types/agent.js";
/**
 * Phase 1 transport: filesystem-based messaging.
 *
 * Directory layout:
 *   {dataDir}/agents/{agent_id}.json     — agent registration files
 *   {dataDir}/messages/{agent_id}/       — per-agent inbox (one JSON file per message)
 *   {dataDir}/notifications/{agent_id}.json — notification file for hooks
 */
export class FileTransport {
    config;
    agentsDir;
    messagesDir;
    notificationsDir;
    watcher = null;
    messageCallbacks = new Map();
    healthy = false;
    constructor(config) {
        this.config = config;
        this.agentsDir = path.join(config.dataDir, "agents");
        this.messagesDir = path.join(config.dataDir, "messages");
        this.notificationsDir = path.join(config.dataDir, "notifications");
    }
    async start() {
        fs.mkdirSync(this.agentsDir, { recursive: true });
        fs.mkdirSync(this.messagesDir, { recursive: true });
        fs.mkdirSync(this.notificationsDir, { recursive: true });
        // Ensure our inbox directory exists
        const inboxDir = path.join(this.messagesDir, this.config.agentId);
        fs.mkdirSync(inboxDir, { recursive: true });
        // Watch our inbox for incoming messages
        this.watcher = watch(inboxDir, {
            persistent: true,
            ignoreInitial: true,
            depth: 0,
            ignored: (filePath) => {
                const base = path.basename(filePath);
                return base.startsWith(".tmp-") || !base.endsWith(".json");
            },
        });
        this.watcher.on("add", (filePath) => {
            this.handleIncomingFile(filePath);
        });
        this.watcher.on("error", (err) => {
            console.error("[FileTransport] Watcher error:", err);
        });
        this.healthy = true;
    }
    async stop() {
        this.healthy = false;
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }
    }
    async send(event) {
        // Derive recipient from room_id convention: "!{sorted_ids}:local"
        const recipientId = this.extractRecipient(event);
        if (!recipientId) {
            throw new Error(`Cannot determine recipient from room_id: ${event.room_id}`);
        }
        FileTransport.validateAgentId(recipientId);
        const recipientInbox = path.join(this.messagesDir, recipientId);
        fs.mkdirSync(recipientInbox, { recursive: true });
        const filename = `${this.formatTimestamp(event.origin_server_ts)}-${event.event_id}.json`;
        this.writeAtomic(path.join(recipientInbox, filename), JSON.stringify(event, null, 2));
    }
    async registerAgent(agent) {
        FileTransport.validateAgentId(agent.agent_id);
        const record = {
            agent_id: agent.agent_id,
            session_id: agent.session_id,
            hostname: agent.hostname,
            pid: agent.pid,
            project_dir: agent.project_dir,
            display_name: path.basename(agent.project_dir),
            registered_at: Date.now(),
            last_heartbeat: Date.now(),
            status: "online",
        };
        this.writeAtomic(path.join(this.agentsDir, `${agent.agent_id}.json`), JSON.stringify(record, null, 2));
    }
    async unregisterAgent(agentId) {
        FileTransport.validateAgentId(agentId);
        const filePath = path.join(this.agentsDir, `${agentId}.json`);
        try {
            fs.unlinkSync(filePath);
        }
        catch {
            // Already gone — idempotent
        }
    }
    async discoverAgents() {
        const agents = [];
        let files;
        try {
            files = fs.readdirSync(this.agentsDir).filter((f) => f.endsWith(".json"));
        }
        catch {
            return agents;
        }
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(this.agentsDir, file);
            try {
                const raw = fs.readFileSync(filePath, "utf8");
                const record = JSON.parse(raw);
                // Check PID liveness (only valid on same host)
                if (record.hostname === os.hostname()) {
                    if (!this.isPidAlive(record.pid)) {
                        fs.unlinkSync(filePath);
                        continue;
                    }
                }
                // Check staleness
                const age = now - record.last_heartbeat;
                if (age > AGENT_STALE_THRESHOLD_MS) {
                    record.status = "stale";
                }
                else {
                    record.status = "online";
                }
                agents.push(record);
            }
            catch {
                // Malformed or race condition — skip
            }
        }
        return agents;
    }
    async readMessages(agentId, filter) {
        FileTransport.validateAgentId(agentId);
        const inboxDir = path.join(this.messagesDir, agentId);
        let files;
        try {
            files = fs
                .readdirSync(inboxDir)
                .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
                .sort();
        }
        catch {
            return [];
        }
        const messages = [];
        for (const file of files) {
            try {
                const raw = fs.readFileSync(path.join(inboxDir, file), "utf8");
                const event = JSON.parse(raw);
                if (filter?.since_ts && event.origin_server_ts < filter.since_ts)
                    continue;
                if (filter?.from_agent && event.sender !== filter.from_agent)
                    continue;
                messages.push(event);
            }
            catch {
                // Skip malformed
            }
        }
        const limit = filter?.limit ?? 50;
        return messages.slice(-limit);
    }
    isHealthy() {
        return this.healthy;
    }
    onMessage(agentId, callback) {
        this.messageCallbacks.set(agentId, callback);
    }
    /** Update heartbeat timestamp for an agent */
    async heartbeat(agentId) {
        FileTransport.validateAgentId(agentId);
        const filePath = path.join(this.agentsDir, `${agentId}.json`);
        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const record = JSON.parse(raw);
            record.last_heartbeat = Date.now();
            record.status = "online";
            this.writeAtomic(filePath, JSON.stringify(record, null, 2));
        }
        catch {
            // Agent file missing or corrupt — will be re-registered
        }
    }
    // --- Internal helpers ---
    /** Reject agent IDs that could escape the data directory */
    static validateAgentId(agentId) {
        if (!/^[\w\-.@]+$/.test(agentId)) {
            throw new Error(`Invalid agent ID: ${agentId}`);
        }
    }
    handleIncomingFile(filePath) {
        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const event = JSON.parse(raw);
            const callback = this.messageCallbacks.get(this.config.agentId);
            if (callback) {
                callback(event);
            }
        }
        catch (err) {
            console.error(`[FileTransport] Failed to process ${filePath}:`, err);
        }
    }
    extractRecipient(event) {
        // Room ID format: "!{id_a}|{id_b}:local" — pipe separator cannot appear in agent IDs
        const match = event.room_id.match(/^!(.+):local$/);
        if (!match)
            return null;
        const ids = match[1].split("|");
        if (ids.length !== 2)
            return null;
        return ids.find((id) => id !== event.sender) ?? null;
    }
    isPidAlive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    }
    writeAtomic(targetPath, data) {
        const dir = path.dirname(targetPath);
        const tempPath = path.join(dir, `.tmp-${process.pid}-${crypto.randomUUID()}`);
        try {
            fs.writeFileSync(tempPath, data, "utf8");
            fs.renameSync(tempPath, targetPath);
        }
        catch (err) {
            try {
                fs.unlinkSync(tempPath);
            }
            catch {
                // Ignore cleanup failure
            }
            throw err;
        }
    }
    formatTimestamp(ms) {
        return new Date(ms)
            .toISOString()
            .replace(/[-:T]/g, "")
            .replace(/\.\d{3}Z/, "");
    }
}
//# sourceMappingURL=FileTransport.js.map