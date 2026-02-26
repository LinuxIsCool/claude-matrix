import type { Transport, MatrixEvent, MessageFilter, ReadResult } from "../types/index.js";
export declare class MessageStore {
    private readonly transport;
    private readonly projectDir;
    readonly agentId: string;
    constructor(transport: Transport, selfAgentId: string, projectDir: string);
    send(toAgentId: string, body: string): Promise<MatrixEvent>;
    read(filter?: MessageFilter): Promise<ReadResult>;
    /** Derive a deterministic room ID for a DM between two agents */
    private deriveRoomId;
}
