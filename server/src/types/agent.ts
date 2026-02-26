export interface AgentRecord {
  agent_id: string;
  session_id: string;
  hostname: string;
  pid: number;
  project_dir: string;
  display_name: string;
  registered_at: number;
  last_heartbeat: number;
  status: AgentStatus;
}

export type AgentStatus = "online" | "stale" | "offline";

export interface AgentRegistration {
  agent_id: string;
  session_id: string;
  project_dir: string;
  hostname: string;
  pid: number;
}

/** Agent is stale if no heartbeat for this many ms (90s = 3x 30s heartbeat) */
export const AGENT_STALE_THRESHOLD_MS = 90_000;

/** Heartbeat interval in ms */
export const AGENT_HEARTBEAT_INTERVAL_MS = 30_000;
