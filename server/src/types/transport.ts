import type { MatrixEvent } from "./event.js";
import type { AgentRecord, AgentRegistration, AgentFocus } from "./agent.js";
import type { MessageFilter } from "./message.js";

/**
 * Reason an agent's record changed. Passed to `onAgentChange` callbacks
 * so the registry can decide what to invalidate. Phase 1 of task-490
 * surfaces "focus" alongside generic "add"/"change"/"delete" so UIs
 * that only care about focus can subscribe selectively.
 */
export type AgentChangeKind = "add" | "change" | "delete" | "focus";

/**
 * Transport interface — the load-bearing abstraction for the entire 5-phase roadmap.
 *
 * Phase 1: FileTransport    — filesystem inbox, chokidar watcher
 * Phase 2: SocketTransport  — Unix domain sockets, NDJSON framing
 * Phase 3: MatrixTransport  — Conduit homeserver via matrix-bot-sdk
 * Phase 4: EncryptedTransport — wraps MatrixTransport with Olm/Megolm
 * Phase 5: FederatedTransport — cross-homeserver via Matrix federation
 *
 * Core modules depend ONLY on this interface, never on concrete implementations.
 */
export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;

  /** Send an event. Resolves when durably written, not necessarily delivered. */
  send(event: MatrixEvent): Promise<void>;

  /** Register this agent with the transport layer. */
  registerAgent(agent: AgentRegistration): Promise<void>;

  /** Unregister this agent. Must be idempotent. */
  unregisterAgent(agentId: string): Promise<void>;

  /** Return all currently discoverable agents. */
  discoverAgents(): Promise<AgentRecord[]>;

  /** Read messages for this agent, optionally filtered. */
  readMessages(agentId: string, filter?: MessageFilter): Promise<MatrixEvent[]>;

  /** Update heartbeat for an agent to signal liveness. */
  heartbeat(agentId: string): Promise<void>;

  /** Health check for the transport layer. */
  isHealthy(): boolean;

  /** Subscribe to incoming events for an agent (new file, new socket message, etc.) */
  onMessage(agentId: string, callback: (event: MatrixEvent) => void): void;

  /**
   * Update the focus field on an agent's record. Set `focus` to `null` to
   * clear. Read-merge-write semantics — all other fields (persona,
   * heartbeat, etc.) survive.
   *
   * OPTIONAL on the interface so future transports (Phase 2 Unix
   * sockets, Phase 3 Matrix homeserver) can opt-in once they have a
   * focus primitive. FileTransport implements it.
   *
   * Phase 1 of task-490.
   */
  updateAgentFocus?(agentId: string, focus: AgentFocus | null): Promise<void>;

  /**
   * Subscribe to agent registry changes — registrations, focus
   * updates, deletions. Callback fires once per detected change after
   * debouncing (typically 200ms). The `kind` argument indicates the
   * change classification (add / change / delete / focus). Multiple
   * subscribers are allowed; FileTransport fans out events to all.
   *
   * OPTIONAL on the interface. FileTransport implements it via chokidar
   * watching the agents/ directory.
   *
   * Phase 1 of task-490.
   */
  onAgentChange?(callback: (agentId: string, kind: AgentChangeKind) => void): void;
}

export interface TransportConfig {
  dataDir: string;
  agentId: string;
}
