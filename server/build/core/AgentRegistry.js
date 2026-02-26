import { AGENT_HEARTBEAT_INTERVAL_MS } from "../types/agent.js";
export class AgentRegistry {
    transport;
    selfAgentId;
    heartbeatTimer = null;
    cachedAgents = [];
    cacheExpiry = 0;
    cacheTtlMs = 5_000;
    constructor(transport, selfAgentId) {
        this.transport = transport;
        this.selfAgentId = selfAgentId;
    }
    async register(registration) {
        await this.transport.registerAgent(registration);
    }
    async unregister() {
        this.stopHeartbeat();
        await this.transport.unregisterAgent(this.selfAgentId);
    }
    async getAll() {
        const now = Date.now();
        if (now < this.cacheExpiry) {
            return this.cachedAgents;
        }
        this.cachedAgents = await this.transport.discoverAgents();
        this.cacheExpiry = now + this.cacheTtlMs;
        return this.cachedAgents;
    }
    async getSelf() {
        const agents = await this.getAll();
        return agents.find((a) => a.agent_id === this.selfAgentId);
    }
    startHeartbeat() {
        this.heartbeatTimer = setInterval(async () => {
            try {
                await this.transport.heartbeat(this.selfAgentId);
            }
            catch {
                // Non-fatal — heartbeat failure just means we'll appear stale
            }
        }, AGENT_HEARTBEAT_INTERVAL_MS);
        // Don't prevent Node.js from exiting
        this.heartbeatTimer.unref();
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}
//# sourceMappingURL=AgentRegistry.js.map