/**
 * Live focus payload — what task the agent is currently working on.
 *
 * Phase 0 of task-490 introduces this field. Carried alongside heartbeat,
 * NOT inside the `status` field (which the heartbeat overwrites every
 * 30s to "online" per FileTransport.heartbeat — see CLAUDE.md note).
 *
 * `source` distinguishes how the focus was set:
 *   - "explicit" — the agent (or operator) called set_focus directly
 *   - "inferred-strong" — derived from observed signal with high
 *     confidence (e.g. a recent set_status mutation on a backlog
 *     task by this agent's persona within the last 60s)
 *   - "inferred-weak"   — derived from a softer signal (e.g. file_path
 *     in claude-logging PreToolUse events matching task-NNN pattern)
 *   - "stale"           — set previously but no recent corroborating
 *     signal; the registry has not yet cleared it
 *
 * `confidence` is a 0..1 scalar that lets the registry rank competing
 * weak signals when multiple tasks plausibly match. Optional — when
 * absent, callers can assume 1.0 for explicit / 0.7 for inferred-strong
 * / 0.4 for inferred-weak / 0.1 for stale.
 */
export interface AgentFocus {
  task_id: number | string;
  source: "explicit" | "inferred-strong" | "inferred-weak" | "stale";
  started_at: number; // unix ms
  confidence?: number; // 0..1, optional
}

export interface AgentRecord {
  agent_id: string;
  session_id: string;
  hostname: string;
  pid: number;
  claude_pid?: number;
  project_dir: string;
  display_name: string;
  registered_at: number;
  last_heartbeat: number;
  status: AgentStatus;

  /**
   * Persona slug (e.g. "matt", "darren", "shawn"). Read from the
   * `PERSONA_SLUG` environment variable at agent registration time.
   * Absent (`undefined`) when the agent was launched without a persona.
   *
   * Downstream renderers (claude-webui kanban glow, claude-home agent
   * dock, claude-collective view) resolve this to a hex color via
   * `claude-personas/src/claude_personas/colors.py:resolve_color()` —
   * the canonical persona color authority.
   *
   * Added: Phase 0 of task-490 (Live Focus & Attention Graph).
   */
  persona?: string;

  /**
   * Live focus state — which backlog task the agent is currently
   * working on. `null` when no focus is set (the registry value
   * intentionally differs from `undefined`: `undefined` means
   * "field absent / unknown", `null` means "focus explicitly cleared").
   *
   * Set via the matrix `set_focus` MCP tool (Phase 1) or inferred
   * from observed signals (Phase 4). Read by every UI surface that
   * renders "what's everyone working on?".
   *
   * Added: Phase 0 of task-490.
   */
  focus?: AgentFocus | null;
}

export type AgentStatus = "online" | "stale" | "offline";

export interface AgentRegistration {
  agent_id: string;
  session_id: string;
  project_dir: string;
  hostname: string;
  pid: number;
  claude_pid: number;

  /**
   * Persona slug passed in at registration time. `index.ts` reads
   * `process.env["PERSONA_SLUG"]` and includes it here when present.
   * Forwarded to AgentRecord.persona by FileTransport.registerAgent.
   *
   * Added: Phase 0 of task-490.
   */
  persona?: string;
}

/** Agent is stale if no heartbeat for this many ms (90s = 3x 30s heartbeat) */
export const AGENT_STALE_THRESHOLD_MS = 90_000;

/** Heartbeat interval in ms */
export const AGENT_HEARTBEAT_INTERVAL_MS = 30_000;
