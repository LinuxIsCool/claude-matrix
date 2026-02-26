import type { MatrixEvent } from "./event.js";
import type { AgentRecord, AgentRegistration } from "./agent.js";
import type { MessageFilter } from "./message.js";
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
}
export interface TransportConfig {
    dataDir: string;
    agentId: string;
}
