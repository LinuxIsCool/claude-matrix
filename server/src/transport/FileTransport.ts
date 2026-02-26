import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { watch, type FSWatcher } from "chokidar";
import type {
  Transport,
  TransportConfig,
  MatrixEvent,
  AgentRecord,
  AgentRegistration,
  MessageFilter,
} from "../types/index.js";
import { AGENT_STALE_THRESHOLD_MS } from "../types/agent.js";

/**
 * Phase 1 transport: filesystem-based messaging.
 *
 * Directory layout:
 *   {dataDir}/agents/{agent_id}.json     — agent registration files
 *   {dataDir}/messages/{agent_id}/       — per-agent inbox (one JSON file per message)
 *   {dataDir}/notifications/{agent_id}.json — notification file for hooks
 */
export class FileTransport implements Transport {
  private readonly agentsDir: string;
  private readonly messagesDir: string;
  private readonly notificationsDir: string;
  private watcher: FSWatcher | null = null;
  private messageCallbacks = new Map<string, (event: MatrixEvent) => void>();
  private healthy = false;

  constructor(private readonly config: TransportConfig) {
    this.agentsDir = path.join(config.dataDir, "agents");
    this.messagesDir = path.join(config.dataDir, "messages");
    this.notificationsDir = path.join(config.dataDir, "notifications");
  }

  async start(): Promise<void> {
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
      ignored: (filePath: string) => {
        const base = path.basename(filePath);
        return base.startsWith(".tmp-") || !base.endsWith(".json");
      },
    });

    this.watcher.on("add", (filePath: string) => {
      this.handleIncomingFile(filePath);
    });

    this.watcher.on("error", (err) => {
      console.error("[FileTransport] Watcher error:", err);
    });

    this.healthy = true;
  }

  async stop(): Promise<void> {
    this.healthy = false;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  async send(event: MatrixEvent): Promise<void> {
    // Derive recipient from room_id convention: "!{sorted_ids}:local"
    const recipientId = this.extractRecipient(event);
    if (!recipientId) {
      throw new Error(`Cannot determine recipient from room_id: ${event.room_id}`);
    }

    const recipientInbox = path.join(this.messagesDir, recipientId);
    fs.mkdirSync(recipientInbox, { recursive: true });

    const filename = `${this.formatTimestamp(event.origin_server_ts)}-${event.event_id}.json`;
    this.writeAtomic(
      path.join(recipientInbox, filename),
      JSON.stringify(event, null, 2),
    );
  }

  async registerAgent(agent: AgentRegistration): Promise<void> {
    const record: AgentRecord = {
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

    this.writeAtomic(
      path.join(this.agentsDir, `${agent.agent_id}.json`),
      JSON.stringify(record, null, 2),
    );
  }

  async unregisterAgent(agentId: string): Promise<void> {
    const filePath = path.join(this.agentsDir, `${agentId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already gone — idempotent
    }
  }

  async discoverAgents(): Promise<AgentRecord[]> {
    const agents: AgentRecord[] = [];

    let files: string[];
    try {
      files = fs.readdirSync(this.agentsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return agents;
    }

    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(this.agentsDir, file);
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const record: AgentRecord = JSON.parse(raw);

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
        } else {
          record.status = "online";
        }

        agents.push(record);
      } catch {
        // Malformed or race condition — skip
      }
    }

    return agents;
  }

  async readMessages(
    agentId: string,
    filter?: MessageFilter,
  ): Promise<MatrixEvent[]> {
    const inboxDir = path.join(this.messagesDir, agentId);

    let files: string[];
    try {
      files = fs
        .readdirSync(inboxDir)
        .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
        .sort();
    } catch {
      return [];
    }

    const messages: MatrixEvent[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(inboxDir, file), "utf8");
        const event: MatrixEvent = JSON.parse(raw);

        if (filter?.since_ts && event.origin_server_ts < filter.since_ts) continue;
        if (filter?.from_agent && event.sender !== filter.from_agent) continue;

        messages.push(event);
      } catch {
        // Skip malformed
      }
    }

    const limit = filter?.limit ?? 50;
    return messages.slice(-limit);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  onMessage(agentId: string, callback: (event: MatrixEvent) => void): void {
    this.messageCallbacks.set(agentId, callback);
  }

  /** Update heartbeat timestamp for an agent */
  async heartbeat(agentId: string): Promise<void> {
    const filePath = path.join(this.agentsDir, `${agentId}.json`);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const record: AgentRecord = JSON.parse(raw);
      record.last_heartbeat = Date.now();
      record.status = "online";
      this.writeAtomic(filePath, JSON.stringify(record, null, 2));
    } catch {
      // Agent file missing or corrupt — will be re-registered
    }
  }

  // --- Internal helpers ---

  private handleIncomingFile(filePath: string): void {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const event: MatrixEvent = JSON.parse(raw);
      const callback = this.messageCallbacks.get(this.config.agentId);
      if (callback) {
        callback(event);
      }
    } catch {
      // Malformed or partial write — skip
    }
  }

  private extractRecipient(event: MatrixEvent): string | null {
    // Room ID format: "!{id_a}|{id_b}:local" — pipe separator cannot appear in agent IDs
    const match = event.room_id.match(/^!(.+):local$/);
    if (!match) return null;

    const ids = match[1].split("|");
    if (ids.length !== 2) return null;
    return ids.find((id) => id !== event.sender) ?? null;
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private writeAtomic(targetPath: string, data: string): void {
    const dir = path.dirname(targetPath);
    const tempPath = path.join(
      dir,
      `.tmp-${process.pid}-${crypto.randomUUID()}`,
    );

    try {
      fs.writeFileSync(tempPath, data, "utf8");
      fs.renameSync(tempPath, targetPath);
    } catch (err) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    }
  }

  private formatTimestamp(ms: number): string {
    return new Date(ms)
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\.\d{3}Z/, "");
  }

}
