import type { Transport, TransportConfig, MatrixEvent, AgentRecord, AgentRegistration, MessageFilter } from "../types/index.js";
/**
 * Phase 1 transport: filesystem-based messaging.
 *
 * Directory layout:
 *   {dataDir}/agents/{agent_id}.json     — agent registration files
 *   {dataDir}/messages/{agent_id}/       — per-agent inbox (one JSON file per message)
 *   {dataDir}/notifications/{agent_id}.json — notification file for hooks
 */
export declare class FileTransport implements Transport {
    private readonly config;
    private readonly agentsDir;
    private readonly messagesDir;
    private readonly notificationsDir;
    private watcher;
    private messageCallbacks;
    private healthy;
    constructor(config: TransportConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    send(event: MatrixEvent): Promise<void>;
    registerAgent(agent: AgentRegistration): Promise<void>;
    unregisterAgent(agentId: string): Promise<void>;
    discoverAgents(): Promise<AgentRecord[]>;
    readMessages(agentId: string, filter?: MessageFilter): Promise<MatrixEvent[]>;
    isHealthy(): boolean;
    onMessage(agentId: string, callback: (event: MatrixEvent) => void): void;
    /** Update heartbeat timestamp for an agent */
    heartbeat(agentId: string): Promise<void>;
    /** Reject agent IDs that could escape the data directory */
    private static validateAgentId;
    private handleIncomingFile;
    private extractRecipient;
    private isPidAlive;
    private writeAtomic;
    private formatTimestamp;
}
