import type { Transport, AgentRecord, AgentRegistration } from "../types/index.js";
export declare class AgentRegistry {
    private readonly transport;
    private readonly selfAgentId;
    private heartbeatTimer;
    private cachedAgents;
    private cacheExpiry;
    private readonly cacheTtlMs;
    constructor(transport: Transport, selfAgentId: string);
    register(registration: AgentRegistration): Promise<void>;
    unregister(): Promise<void>;
    getAll(): Promise<AgentRecord[]>;
    getSelf(): Promise<AgentRecord | undefined>;
    startHeartbeat(): void;
    stopHeartbeat(): void;
}
