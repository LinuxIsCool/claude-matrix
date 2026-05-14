import type {
  Transport,
  AgentRecord,
  AgentRegistration,
  AgentFocus,
  AgentChangeKind,
} from "../types/index.js";
import { AGENT_HEARTBEAT_INTERVAL_MS } from "../types/agent.js";

export class AgentRegistry {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cachedAgents: AgentRecord[] = [];
  private cacheExpiry = 0;
  private readonly cacheTtlMs = 5_000;
  // Phase 1 of task-490: external subscribers to agent-change events.
  // Wired through to transport.onAgentChange if the transport supports it.
  private changeCallbacks: Array<(agentId: string, kind: AgentChangeKind) => void> = [];
  private changeWired = false;

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

  /**
   * Set the live focus for THIS agent. Forwarded to the underlying
   * transport. Throws if the transport doesn't support focus (Phase 2
   * SocketTransport / Phase 3 MatrixTransport may not — Phase 1
   * FileTransport does).
   *
   * Invalidates the discovery cache so the next getAll() reads fresh
   * data from the transport. Belt-and-suspenders alongside the
   * onAgentChange invalidation — same-process callers see the change
   * even if they haven't subscribed.
   *
   * Phase 1 of task-490.
   */
  async setFocus(focus: AgentFocus): Promise<void> {
    if (!this.transport.updateAgentFocus) {
      throw new Error("Transport does not support focus updates");
    }
    await this.transport.updateAgentFocus(this.selfAgentId, focus);
    this.invalidateCache();
  }

  /**
   * Clear the live focus for THIS agent. Persists `focus: null`.
   *
   * Phase 1 of task-490.
   */
  async clearFocus(): Promise<void> {
    if (!this.transport.updateAgentFocus) {
      throw new Error("Transport does not support focus updates");
    }
    await this.transport.updateAgentFocus(this.selfAgentId, null);
    this.invalidateCache();
  }

  /**
   * Subscribe to agent-change events from the transport. Multiple
   * subscribers OK — callbacks fan out in registration order.
   *
   * Wires the transport-level fan-out lazily on first subscribe so
   * registries created without focus subscribers don't pay the
   * watcher cost.
   *
   * Phase 1 of task-490.
   */
  onAgentChange(callback: (agentId: string, kind: AgentChangeKind) => void): void {
    this.changeCallbacks.push(callback);
    if (!this.changeWired && this.transport.onAgentChange) {
      this.transport.onAgentChange((agentId, kind) => {
        // Invalidate the cache so the very next getAll() sees fresh
        // data — critical for kanban glow UIs that drive their next
        // render off the change callback.
        this.invalidateCache();
        for (const cb of this.changeCallbacks) {
          try {
            cb(agentId, kind);
          } catch (err) {
            console.error("[AgentRegistry] change callback failed:", err);
          }
        }
      });
      this.changeWired = true;
    }
  }

  /**
   * Force-expire the 5s discovery cache. Used by setFocus/clearFocus
   * and the onAgentChange wiring so consumers see fresh data
   * immediately after a known mutation.
   */
  private invalidateCache(): void {
    this.cacheExpiry = 0;
  }

  startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.transport.heartbeat(this.selfAgentId);
      } catch (err) {
        console.error("[AgentRegistry] Heartbeat failed:", err);
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
