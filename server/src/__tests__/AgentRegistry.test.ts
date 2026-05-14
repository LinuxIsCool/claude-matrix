import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  Transport,
  MatrixEvent,
  AgentRecord,
  AgentRegistration,
  AgentFocus,
  AgentChangeKind,
  MessageFilter,
} from "../types/index.js";
import { AgentRegistry } from "../core/AgentRegistry.js";

function makeMockTransport(): Transport & {
  registered: AgentRegistration[];
  unregistered: string[];
  heartbeats: string[];
  mockAgents: AgentRecord[];
  focusUpdates: Array<[string, AgentFocus | null]>;
  agentChangeListeners: Array<(agentId: string, kind: AgentChangeKind) => void>;
} {
  const mock = {
    registered: [] as AgentRegistration[],
    unregistered: [] as string[],
    heartbeats: [] as string[],
    mockAgents: [] as AgentRecord[],
    focusUpdates: [] as Array<[string, AgentFocus | null]>,
    agentChangeListeners: [] as Array<(agentId: string, kind: AgentChangeKind) => void>,
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
    updateAgentFocus: async (agentId: string, focus: AgentFocus | null) => {
      mock.focusUpdates.push([agentId, focus]);
    },
    onAgentChange: (cb: (agentId: string, kind: AgentChangeKind) => void) => {
      mock.agentChangeListeners.push(cb);
    },
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
      claude_pid: 1233,
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

  // ── Phase 1 of task-490 — setFocus / clearFocus / onAgentChange ─────

  it("setFocus delegates to transport.updateAgentFocus with self's agent_id", async () => {
    const focus: AgentFocus = {
      task_id: 490,
      source: "explicit",
      started_at: 1700000000000,
    };
    await registry.setFocus(focus);
    expect(transport.focusUpdates).toHaveLength(1);
    expect(transport.focusUpdates[0]).toEqual(["self@host", focus]);
  });

  it("clearFocus delegates to transport.updateAgentFocus with null", async () => {
    await registry.clearFocus();
    expect(transport.focusUpdates).toHaveLength(1);
    expect(transport.focusUpdates[0]).toEqual(["self@host", null]);
  });

  it("setFocus invalidates the discovery cache", async () => {
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

    // Mutate transport then setFocus — cache should be invalidated
    // so the next getAll() sees the new mockAgents array.
    transport.mockAgents = [];
    await registry.setFocus({ task_id: 1, source: "explicit", started_at: Date.now() });

    const second = await registry.getAll();
    expect(second).toHaveLength(0);
  });

  it("onAgentChange wires through to transport on first subscribe", async () => {
    expect(transport.agentChangeListeners).toHaveLength(0);
    registry.onAgentChange(() => {});
    expect(transport.agentChangeListeners).toHaveLength(1);
    // Second subscribe must NOT re-wire the transport (would double-fire)
    registry.onAgentChange(() => {});
    expect(transport.agentChangeListeners).toHaveLength(1);
  });

  it("onAgentChange fans out to all subscribers", async () => {
    const events1: Array<[string, AgentChangeKind]> = [];
    const events2: Array<[string, AgentChangeKind]> = [];
    registry.onAgentChange((id, kind) => events1.push([id, kind]));
    registry.onAgentChange((id, kind) => events2.push([id, kind]));

    // Invoke the transport-level listener (we registered via the
    // first onAgentChange call) — this is what FileTransport's
    // debounced fire does in real usage.
    transport.agentChangeListeners[0]("agent-x@host", "focus");

    expect(events1).toEqual([["agent-x@host", "focus"]]);
    expect(events2).toEqual([["agent-x@host", "focus"]]);
  });

  it("onAgentChange invalidates the discovery cache on each fire", async () => {
    transport.mockAgents = [
      {
        agent_id: "agent-x@host",
        session_id: "sess",
        hostname: "host",
        pid: 1,
        project_dir: "/x",
        display_name: "x",
        registered_at: Date.now(),
        last_heartbeat: Date.now(),
        status: "online",
      },
    ];
    registry.onAgentChange(() => {});

    const first = await registry.getAll();
    expect(first).toHaveLength(1);

    // Mutate transport state and fire a change — cache must invalidate
    // so subsequent getAll() sees fresh data.
    transport.mockAgents = [];
    transport.agentChangeListeners[0]("agent-x@host", "delete");

    const second = await registry.getAll();
    expect(second).toHaveLength(0);
  });

  it("setFocus throws when transport doesn't support focus", async () => {
    // Build a registry on a transport with no updateAgentFocus method.
    const bareTransport: Transport = {
      start: async () => {},
      stop: async () => {},
      send: async () => {},
      registerAgent: async () => {},
      unregisterAgent: async () => {},
      discoverAgents: async () => [],
      readMessages: async () => [],
      heartbeat: async () => {},
      isHealthy: () => true,
      onMessage: () => {},
    };
    const bareRegistry = new AgentRegistry(bareTransport, "self@host");
    await expect(
      bareRegistry.setFocus({ task_id: 1, source: "explicit", started_at: Date.now() }),
    ).rejects.toThrow(/does not support focus/i);
  });
});
