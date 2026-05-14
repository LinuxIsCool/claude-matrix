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
  AgentFocus,
  AgentChangeKind,
  MessageFilter,
} from "../types/index.js";
import { AGENT_STALE_THRESHOLD_MS } from "../types/agent.js";

/**
 * Debounce window for the agents/ directory watcher. Rapid bursts of
 * writes (e.g. set_focus immediately followed by heartbeat) coalesce
 * to a single onAgentChange fire. 200ms is conservative — long enough
 * to merge a heartbeat-during-set_focus race, short enough to feel
 * "live" in a kanban glow UI.
 *
 * Phase 1 of task-490.
 */
export const AGENT_WATCH_DEBOUNCE_MS = 200;

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
  private agentsWatcher: FSWatcher | null = null;
  private messageCallbacks = new Map<string, (event: MatrixEvent) => void>();
  // Phase 1 of task-490: registry-change subscribers. Array (not Map)
  // because we expect ≤2 subscribers per process (AgentRegistry +
  // optionally a direct MCP consumer); fan-out is cheap.
  private agentChangeCallbacks: Array<(agentId: string, kind: AgentChangeKind) => void> = [];
  private agentChangeDebounce = new Map<string, ReturnType<typeof setTimeout>>();
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
        // Don't ignore the watched directory itself
        if (filePath === inboxDir) return false;
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

    // Phase 1 of task-490: watch the agents/ directory so registry
    // consumers can react to focus changes (and registrations /
    // deletions) without polling. Debounced to coalesce rapid bursts
    // (e.g. set_focus followed milliseconds later by a heartbeat).
    this.agentsWatcher = watch(this.agentsDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      ignored: (filePath: string) => {
        if (filePath === this.agentsDir) return false;
        const base = path.basename(filePath);
        return base.startsWith(".tmp-") || !base.endsWith(".json");
      },
    });

    this.agentsWatcher.on("add", (filePath: string) => {
      this.fireAgentChange(this.agentIdFromPath(filePath), "add");
    });
    this.agentsWatcher.on("change", (filePath: string) => {
      this.fireAgentChange(this.agentIdFromPath(filePath), "change");
    });
    this.agentsWatcher.on("unlink", (filePath: string) => {
      this.fireAgentChange(this.agentIdFromPath(filePath), "delete");
    });
    this.agentsWatcher.on("error", (err) => {
      console.error("[FileTransport] Agents watcher error:", err);
    });

    this.healthy = true;
  }

  async stop(): Promise<void> {
    this.healthy = false;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.agentsWatcher) {
      await this.agentsWatcher.close();
      this.agentsWatcher = null;
    }
    // Cancel any pending debounce timers so stop() is clean.
    for (const timer of this.agentChangeDebounce.values()) {
      clearTimeout(timer);
    }
    this.agentChangeDebounce.clear();
  }

  async send(event: MatrixEvent): Promise<void> {
    // Derive recipient from room_id convention: "!{id_a}|{id_b}:local"
    const recipientId = this.extractRecipient(event);
    if (!recipientId) {
      throw new Error(`Cannot determine recipient from room_id: ${event.room_id}`);
    }
    FileTransport.validateAgentId(recipientId);

    const recipientInbox = path.join(this.messagesDir, recipientId);
    fs.mkdirSync(recipientInbox, { recursive: true });

    const filename = `${this.formatTimestamp(event.origin_server_ts)}-${event.event_id}.json`;
    this.writeAtomic(
      path.join(recipientInbox, filename),
      JSON.stringify(event, null, 2),
    );
  }

  async registerAgent(agent: AgentRegistration): Promise<void> {
    FileTransport.validateAgentId(agent.agent_id);
    const record: AgentRecord = {
      agent_id: agent.agent_id,
      session_id: agent.session_id,
      hostname: agent.hostname,
      pid: agent.pid,
      claude_pid: agent.claude_pid,
      project_dir: agent.project_dir,
      display_name: path.basename(agent.project_dir),
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
      status: "online",
      // Phase 0 of task-490 (Live Focus & Attention Graph):
      // forward persona slug from the registration call onto the
      // persisted AgentRecord. `undefined` when the agent was
      // launched without PERSONA_SLUG set — downstream consumers
      // treat absent persona as "anonymous / unknown" and fall
      // back to the default color (claude-personas DEFAULT_COLOR).
      persona: agent.persona,
      // `focus` starts unset — populated later via the set_focus
      // MCP tool (Phase 1) or inference (Phase 4). Stored as
      // `null` rather than `undefined` so the field is always
      // present in the serialized JSON, making it easy to detect
      // "cleared" vs "never set" once the inference pipeline lands.
      focus: null,
    };

    this.writeAtomic(
      path.join(this.agentsDir, `${agent.agent_id}.json`),
      JSON.stringify(record, null, 2),
    );
  }

  async unregisterAgent(agentId: string): Promise<void> {
    FileTransport.validateAgentId(agentId);
    const filePath = path.join(this.agentsDir, `${agentId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[FileTransport] Failed to unregister agent ${agentId}:`, err);
      }
    }
  }

  async discoverAgents(): Promise<AgentRecord[]> {
    const agents: AgentRecord[] = [];

    let files: string[];
    try {
      files = fs.readdirSync(this.agentsDir).filter((f) => f.endsWith(".json"));
    } catch (err) {
      console.error("[FileTransport] Failed to read agents directory:", err);
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
            try {
              fs.unlinkSync(filePath);
            } catch (unlinkErr) {
              console.error(`[FileTransport] Failed to clean up stale agent ${file}:`, unlinkErr);
            }
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
      } catch (err) {
        console.error(`[FileTransport] Skipping agent file ${file}:`, err);
      }
    }

    return agents;
  }

  async readMessages(
    agentId: string,
    filter?: MessageFilter,
  ): Promise<MatrixEvent[]> {
    FileTransport.validateAgentId(agentId);
    const inboxDir = path.join(this.messagesDir, agentId);

    let files: string[];
    try {
      files = fs
        .readdirSync(inboxDir)
        .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[FileTransport] Failed to read inbox for ${agentId}:`, err);
      }
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
      } catch (err) {
        console.error(`[FileTransport] Skipping unreadable message ${file}:`, err);
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
    FileTransport.validateAgentId(agentId);
    const filePath = path.join(this.agentsDir, `${agentId}.json`);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const record: AgentRecord = JSON.parse(raw);
      record.last_heartbeat = Date.now();
      record.status = "online";
      this.writeAtomic(filePath, JSON.stringify(record, null, 2));
    } catch (err) {
      console.error(`[FileTransport] Heartbeat failed for ${agentId}:`, err);
    }
  }

  /**
   * Update the `focus` field on an agent's record. Set `focus` to
   * `null` to clear. Read-merge-write — all other fields (persona,
   * heartbeat, registration metadata) survive.
   *
   * Throws if the agent record does not exist on disk (so callers
   * can't accidentally persist a focus for an unknown agent_id).
   *
   * Phase 1 of task-490.
   */
  async updateAgentFocus(agentId: string, focus: AgentFocus | null): Promise<void> {
    FileTransport.validateAgentId(agentId);
    const filePath = path.join(this.agentsDir, `${agentId}.json`);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Cannot update focus: agent ${agentId} not registered`);
      }
      throw err;
    }
    const record: AgentRecord = JSON.parse(raw);
    record.focus = focus;
    this.writeAtomic(filePath, JSON.stringify(record, null, 2));
    // Fire a synthetic "focus" change event immediately rather than
    // waiting for chokidar — keeps the same-process call path tight
    // (set_focus then list_agents on the same process sees fresh data
    // without any debounce delay). chokidar will ALSO fire a "change"
    // event ~200ms later; consumers must be idempotent on duplicates.
    this.fireAgentChange(agentId, "focus");
  }

  /**
   * Subscribe to agent registry changes. Multiple subscribers OK —
   * each receives every (agentId, kind) tuple.
   *
   * Phase 1 of task-490.
   */
  onAgentChange(callback: (agentId: string, kind: AgentChangeKind) => void): void {
    this.agentChangeCallbacks.push(callback);
  }

  // --- Internal helpers ---

  /** Reject agent IDs that could escape the data directory */
  private static validateAgentId(agentId: string): void {
    if (!/^[\w\-.@]+$/.test(agentId)) {
      throw new Error(`Invalid agent ID: ${agentId}`);
    }
  }

  private handleIncomingFile(filePath: string): void {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const event: MatrixEvent = JSON.parse(raw);
      const callback = this.messageCallbacks.get(this.config.agentId);
      if (callback) {
        callback(event);
      }
    } catch (err) {
      console.error(`[FileTransport] Failed to process ${filePath}:`, err);
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

  /**
   * Derive an agent_id from an absolute file path like
   * `/.../agents/pid-12345@host.json`. Returns the base name without
   * the `.json` suffix. No validation here — callers receive raw
   * filesystem events and downstream code can reject as needed.
   */
  private agentIdFromPath(filePath: string): string {
    return path.basename(filePath).replace(/\.json$/, "");
  }

  /**
   * Debounce + fan out an agent change event. Multiple writes to the
   * same agent file within `AGENT_WATCH_DEBOUNCE_MS` coalesce into a
   * single callback fire (using the last kind seen). Per-agent
   * debouncing (not global) so concurrent set_focus calls on two
   * different agents both fire promptly.
   *
   * Phase 1 of task-490.
   */
  private fireAgentChange(agentId: string, kind: AgentChangeKind): void {
    const existing = this.agentChangeDebounce.get(agentId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.agentChangeDebounce.delete(agentId);
      for (const cb of this.agentChangeCallbacks) {
        try {
          cb(agentId, kind);
        } catch (err) {
          console.error("[FileTransport] onAgentChange callback failed:", err);
        }
      }
    }, AGENT_WATCH_DEBOUNCE_MS);
    timer.unref?.();
    this.agentChangeDebounce.set(agentId, timer);
  }

}
