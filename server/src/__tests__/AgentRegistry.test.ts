import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Transport, MatrixEvent, AgentRecord, AgentRegistration, MessageFilter } from "../types/index.js";
import { AgentRegistry } from "../core/AgentRegistry.js";

function makeMockTransport(): Transport & {
  registered: AgentRegistration[];
  unregistered: string[];
  heartbeats: string[];
  mockAgents: AgentRecord[];
} {
  const mock = {
    registered: [] as AgentRegistration[],
    unregistered: [] as string[],
    heartbeats: [] as string[],
    mockAgents: [] as AgentRecord[],
    start: async () => {},
    stop: async () => {},
    send: async (_event: MatrixEvent) => {},
    registerAgent: async (agent: AgentRegistration) => { mock.registered.push(agent); },
    unregisterAgent: async (agentId: string) => { mock.unregistered.push(agentId); },
    discoverAgents: async (): Promise<AgentRecord[]> => mock.mockAgents,
    readMessages: async (_agentId: string, _filter?: MessageFilter): Promise<MatrixEvent[]> => [],
    heartbeat: async (agentId: string) => { mock.heartbeats.push(agentId); },
    isHealthy: () => true,
    onMessage: (_agentId: string, _cb: (event: MatrixEvent) => void) => {},
  };
  return mock;
}

describe("AgentRegistry", () => {
  let transport: ReturnType<typeof makeMockTransport>;
  let registry: AgentRegistry;

  beforeEach(() => {
    transport = makeMockTransport();
    registry = new AgentRegistry(transport, "self@host");
  });

  it("delegates register to transport", async () => {
    const reg: AgentRegistration = {
      agent_id: "self@host",
      session_id: "sess",
      project_dir: "/project",
      hostname: "host",
      pid: 1234,
    };
    await registry.register(reg);
    expect(transport.registered).toHaveLength(1);
    expect(transport.registered[0].agent_id).toBe("self@host");
  });

  it("unregister stops heartbeat and delegates", async () => {
    registry.startHeartbeat();
    await registry.unregister();
    expect(transport.unregistered).toContain("self@host");
  });

  it("caches getAll results for 5 seconds", async () => {
    transport.mockAgents = [
      {
        agent_id: "self@host",
        session_id: "sess",
        hostname: "host",
        pid: 1234,
        project_dir: "/project",
        display_name: "project",
        registered_at: Date.now(),
        last_heartbeat: Date.now(),
        status: "online",
      },
    ];

    const first = await registry.getAll();
    expect(first).toHaveLength(1);

    // Mutate transport data — should still return cached
    transport.mockAgents = [];
    const second = await registry.getAll();
    expect(second).toHaveLength(1);
  });

  it("getSelf returns own agent record", async () => {
    transport.mockAgents = [
      {
        agent_id: "self@host",
        session_id: "sess",
        hostname: "host",
        pid: 1234,
        project_dir: "/project",
        display_name: "project",
        registered_at: Date.now(),
        last_heartbeat: Date.now(),
        status: "online",
      },
      {
        agent_id: "other@host",
        session_id: "sess2",
        hostname: "host",
        pid: 5678,
        project_dir: "/other",
        display_name: "other",
        registered_at: Date.now(),
        last_heartbeat: Date.now(),
        status: "online",
      },
    ];

    const self = await registry.getSelf();
    expect(self?.agent_id).toBe("self@host");
  });

  it("heartbeat fires on interval", async () => {
    vi.useFakeTimers();
    registry.startHeartbeat();

    // Advance past one heartbeat interval (30s)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(transport.heartbeats[0]).toBe("self@host");

    registry.stopHeartbeat();
    vi.useRealTimers();
  });
});
