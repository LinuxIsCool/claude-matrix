import * as crypto from "node:crypto";
export class MessageStore {
    transport;
    projectDir;
    agentId;
    constructor(transport, selfAgentId, projectDir) {
        this.transport = transport;
        this.projectDir = projectDir;
        this.agentId = selfAgentId;
    }
    async send(toAgentId, body) {
        const event = {
            event_id: crypto.randomUUID(),
            type: "com.claudematrix.message",
            sender: this.agentId,
            room_id: this.deriveRoomId(this.agentId, toAgentId),
            origin_server_ts: Date.now(),
            content: {
                msgtype: "m.text",
                body,
            },
            "com.claudematrix.project_dir": this.projectDir,
            "com.claudematrix.schema_version": "1.0",
            "com.claudematrix.transport": "filesystem",
        };
        await this.transport.send(event);
        return event;
    }
    async read(filter) {
        const messages = await this.transport.readMessages(this.agentId, filter);
        return {
            messages,
            messages_returned: messages.length,
        };
    }
    /** Derive a deterministic room ID for a DM between two agents */
    deriveRoomId(agentA, agentB) {
        const sorted = [agentA, agentB].sort();
        return `!${sorted[0]}|${sorted[1]}:local`;
    }
}
//# sourceMappingURL=MessageStore.js.map