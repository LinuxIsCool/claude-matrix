import type { Transport, AgentRecord, AgentRegistration } from "../types/index.js";
import { AGENT_HEARTBEAT_INTERVAL_MS } from "../types/agent.js";

export class AgentRegistry {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cachedAgents: AgentRecord[] = [];
  private cacheExpiry = 0;
  private readonly cacheTtlMs = 5_000;

  constructor(
    private readonly transport: Transport,
    private readonly selfAgentId: string,
  ) {}

  async register(registration: AgentRegistration): Promise<void> {
    await this.transport.registerAgent(registration);
  }

  async unregister(): Promise<void> {
    this.stopHeartbeat();
    await this.transport.unregisterAgent(this.selfAgentId);
  }

  async getAll(): Promise<AgentRecord[]> {
    const now = Date.now();
    if (now < this.cacheExpiry) {
      return this.cachedAgents;
    }

    this.cachedAgents = await this.transport.discoverAgents();
    this.cacheExpiry = now + this.cacheTtlMs;
    return this.cachedAgents;
  }

  async getSelf(): Promise<AgentRecord | undefined> {
    const agents = await this.getAll();
    return agents.find((a) => a.agent_id === this.selfAgentId);
  }

  startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.transport.heartbeat(this.selfAgentId);
      } catch {
        // Non-fatal — heartbeat failure just means we'll appear stale
      }
    }, AGENT_HEARTBEAT_INTERVAL_MS);

    // Don't prevent Node.js from exiting
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
