import * as crypto from "node:crypto";
import type {
  Transport,
  MatrixEvent,
  MessageContent,
  MessageFilter,
  ReadResult,
} from "../types/index.js";

export class MessageStore {
  readonly agentId: string;

  constructor(
    private readonly transport: Transport,
    selfAgentId: string,
    private readonly projectDir: string,
  ) {
    this.agentId = selfAgentId;
  }

  async send(toAgentId: string, body: string): Promise<MatrixEvent> {
    const event: MatrixEvent = {
      event_id: crypto.randomUUID(),
      type: "com.claudematrix.message",
      sender: this.agentId,
      room_id: this.deriveRoomId(this.agentId, toAgentId),
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
      this.agentId,
      filter,
    );

    return {
      messages,
      messages_returned: messages.length,
    };
  }

  /** Derive a deterministic room ID for a DM between two agents */
  private deriveRoomId(agentA: string, agentB: string): string {
    const sorted = [agentA, agentB].sort();
    return `!${sorted[0]}|${sorted[1]}:local`;
  }
}
