import * as crypto from "node:crypto";
import type {
  Transport,
  MatrixEvent,
  MessageContent,
  MessageFilter,
  ReadResult,
} from "../types/index.js";

export class MessageStore {
  constructor(
    private readonly transport: Transport,
    private readonly selfAgentId: string,
    private readonly projectDir: string,
  ) {}

  async send(toAgentId: string, body: string): Promise<MatrixEvent> {
    const event: MatrixEvent = {
      event_id: crypto.randomUUID(),
      type: "com.claudematrix.message",
      sender: this.selfAgentId,
      room_id: this.deriveRoomId(this.selfAgentId, toAgentId),
      origin_server_ts: Date.now(),
      content: {
        msgtype: "m.text",
        body,
      } satisfies MessageContent,
      "com.claudematrix.project_dir": this.projectDir,
      "com.claudematrix.schema_version": "1.0",
      "com.claudematrix.transport": "filesystem",
    };

    await this.transport.send(event);
    return event;
  }

  async read(filter?: MessageFilter): Promise<ReadResult> {
    const messages = await this.transport.readMessages(
      this.selfAgentId,
      filter,
    );

    return {
      messages,
      total_unread: messages.length,
    };
  }

  /** Derive a deterministic room ID for a DM between two agents */
  private deriveRoomId(agentA: string, agentB: string): string {
    const sorted = [agentA, agentB].sort();
    return `!${sorted[0]}|${sorted[1]}:local`;
  }
}
