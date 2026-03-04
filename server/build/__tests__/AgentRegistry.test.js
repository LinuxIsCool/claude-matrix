import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentRegistry } from "../core/AgentRegistry.js";
function makeMockTransport() {
    const mock = {
        registered: [],
        unregistered: [],
        heartbeats: [],
        mockAgents: [],
        start: async () => { },
        stop: async () => { },
        send: async (_event) => { },
        registerAgent: async (agent) => { mock.registered.push(agent); },
        unregisterAgent: async (agentId) => { mock.unregistered.push(agentId); },
        discoverAgents: async () => mock.mockAgents,
        readMessages: async (_agentId, _filter) => [],
        heartbeat: async (agentId) => { mock.heartbeats.push(agentId); },
        isHealthy: () => true,
        onMessage: (_agentId, _cb) => { },
    };
    return mock;
}
describe("AgentRegistry", () => {
    let transport;
    let registry;
    beforeEach(() => {
        transport = makeMockTransport();
        registry = new AgentRegistry(transport, "self@host");
    });
    it("delegates register to transport", async () => {
        const reg = {
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
//# sourceMappingURL=AgentRegistry.test.js.map