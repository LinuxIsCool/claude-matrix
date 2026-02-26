/**
 * Matrix-shaped event envelope. Intentionally compatible with the Matrix
 * Client-Server API event structure from day one. All transports
 * serialize/deserialize this shape. Phase 3 maps 1:1 to real Matrix events.
 */
export interface MatrixEvent {
    event_id: string;
    type: ClaudeMatrixEventType;
    sender: string;
    room_id: string;
    origin_server_ts: number;
    content: EventContent;
    /** Matrix optional fields */
    unsigned?: {
        age?: number;
        transaction_id?: string;
    };
    /** ClaudeMatrix extension namespace */
    "com.claudematrix.project_dir"?: string;
    "com.claudematrix.schema_version"?: string;
    "com.claudematrix.transport"?: "filesystem" | "unix_socket" | "matrix";
}
export type ClaudeMatrixEventType = "com.claudematrix.message" | "com.claudematrix.message.notice" | "com.claudematrix.agent.register" | "com.claudematrix.agent.deregister" | "com.claudematrix.agent.heartbeat";
export type EventContent = MessageContent | NoticeContent | AgentRegisterContent | AgentDeregisterContent | AgentHeartbeatContent;
export interface MessageContent {
    msgtype: "m.text";
    body: string;
}
export interface NoticeContent {
    msgtype: "m.notice";
    body: string;
}
export interface AgentRegisterContent {
    agent_id: string;
    session_id: string;
    project_dir: string;
    hostname: string;
    pid: number;
}
export interface AgentDeregisterContent {
    agent_id: string;
    reason: "shutdown" | "crash_recovery";
}
export interface AgentHeartbeatContent {
    agent_id: string;
    pid: number;
}
