/**
 * Agent ID resolution for hook scripts.
 *
 * Priority: discoverAgentId() → deriveAgentId() fallback.
 *
 * The MCP server writes `claude_pid` (its parent = Claude Code PID) to the
 * agent registration file. Hooks walk their own /proc ancestry to find the
 * same Claude Code PID, then match it against registered agents.
 */

import { hostname } from "node:os";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Agent ID validation regex — must match FileTransport.validateAgentId */
const AGENT_ID_RE = /^[\w\-.@]+$/;

/**
 * Derive agent ID from session ID (fallback when PID discovery fails).
 * Produces a consistent ID only if the MCP server also derived from the same session ID.
 */
export function deriveAgentId(sessionId) {
  const host = hostname();
  return `session-${sessionId.slice(0, 8)}@${host}`;
}

/**
 * Default /proc status reader. Reads /proc/{pid}/status.
 */
function defaultReadStatus(pid) {
  return readFileSync(`/proc/${pid}/status`, "utf8");
}

/**
 * Walk /proc ancestry to find the Claude Code process PID.
 * Returns the PID if found, null otherwise.
 *
 * @param {function} readStatus - Injectable reader for /proc/{pid}/status (for testing)
 */
export function findClaudePid(readStatus = defaultReadStatus) {
  let pid = process.ppid;
  for (let i = 0; i < 5; i++) {
    try {
      const status = readStatus(pid);
      const nameLine = status.split("\n").find((l) => l.startsWith("Name:"));
      if (!nameLine) return null;
      const name = nameLine.split("\t").pop().trim();
      if (name === "claude") return pid;

      // Walk up: find PPid line
      const ppidLine = status.split("\n").find((l) => l.startsWith("PPid:"));
      if (!ppidLine) return null;
      const parentPid = parseInt(ppidLine.split("\t").pop().trim(), 10);
      if (parentPid <= 1) return null;
      pid = parentPid;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Discover our agent ID by matching claude_pid in agent registration files.
 * Returns the agent_id string if found, null otherwise.
 *
 * @param {string} dataDir - Claude Matrix data directory
 * @param {function} readStatus - Injectable reader for /proc/{pid}/status (for testing)
 */
export function discoverAgentId(dataDir, readStatus = defaultReadStatus) {
  const claudePid = findClaudePid(readStatus);
  if (!claudePid) return null;

  const agentsDir = join(dataDir, "agents");
  let files;
  try {
    files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }

  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(join(agentsDir, file), "utf8"));
      if (typeof record.claude_pid === "number" && record.claude_pid === claudePid) {
        if (!AGENT_ID_RE.test(record.agent_id)) continue;
        return record.agent_id;
      }
    } catch {
      // Skip malformed
    }
  }
  return null;
}
