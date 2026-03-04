import { describe, it, expect, beforeEach } from "vitest";
import { MessageStore } from "../core/MessageStore.js";
// Lightweight mock transport — only send/readMessages used by MessageStore
function makeMockTransport() {
    const mock = {
        sent: [],
        mockMessages: [],
        start: async () => { },
        stop: async () => { },
        send: async (event) => { mock.sent.push(event); },
        registerAgent: async (_agent) => { },
        unregisterAgent: async (_agentId) => { },
        discoverAgents: async () => [],
        readMessages: async (_agentId, _filter) => mock.mockMessages,
        heartbeat: async (_agentId) => { },
        isHealthy: () => true,
        onMessage: (_agentId, _cb) => { },
    };
    return mock;
}
describe("MessageStore", () => {
    let transport;
    let store;
    beforeEach(() => {
        transport = makeMockTransport();
        store = new MessageStore(transport, "agent-a@host", "/project-a");
    });
    it("constructs a valid Matrix envelope on send", async () => {
        const event = await store.send("agent-b@host", "Hello!");
        expect(event.type).toBe("com.claudematrix.message");
        expect(event.sender).toBe("agent-a@host");
        expect(event.content).toEqual({ msgtype: "m.text", body: "Hello!" });
        expect(event["com.claudematrix.project_dir"]).toBe("/project-a");
        expect(event["com.claudematrix.schema_version"]).toBe("1.0");
        expect(event["com.claudematrix.transport"]).toBe("filesystem");
        expect(event.event_id).toBeTruthy();
        expect(event.origin_server_ts).toBeGreaterThan(0);
    });
    it("derives deterministic sorted room_id", async () => {
        const event = await store.send("agent-b@host", "test");
        // Sorted: agent-a < agent-b
        expect(event.room_id).toBe("!agent-a@host|agent-b@host:local");
        // Reverse direction should produce the same room_id
        const store2 = new MessageStore(transport, "agent-b@host", "/project-b");
        const event2 = await store2.send("agent-a@host", "test");
        expect(event2.room_id).toBe("!agent-a@host|agent-b@host:local");
    });
    it("delivers event to transport.send()", async () => {
        await store.send("agent-b@host", "delivered");
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0].content.body).toBe("delivered");
    });
    it("reads messages from transport", async () => {
        transport.mockMessages = [
            {
                event_id: "1",
                type: "com.claudematrix.message",
                sender: "other@host",
                room_id: "!a|b:local",
                origin_server_ts: Date.now(),
                content: { msgtype: "m.text", body: "hey" },
            },
        ];
        const result = await store.read();
        expect(result.messages_returned).toBe(1);
        expect(result.messages[0].event_id).toBe("1");
    });
    it("exposes agentId", () => {
        expect(store.agentId).toBe("agent-a@host");
    });
});
//# sourceMappingURL=MessageStore.test.js.map