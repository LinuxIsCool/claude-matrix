#!/usr/bin/env node

/**
 * SessionStart hook: discover agent identity, persist it to CLAUDE_ENV_FILE,
 * and inject identity context into Claude.
 *
 * Agent ID resolution:
 *   1. discoverAgentId() — match claude_pid from /proc ancestry against agent registrations
 *   2. deriveAgentId(sessionId) — legacy fallback using session ID
 *
 * Stdin: JSON blob with session_id, cwd, hook_event_name, etc.
 * Stdout: JSON with hookSpecificOutput.additionalContext
 */

import { readFileSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { hostname, homedir } from "node:os";
import { deriveAgentId, discoverAgentId } from "./lib/agent-id.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }

  const sessionId = input.session_id;
  if (!sessionId || !/^[0-9a-f\-]+$/i.test(sessionId)) {
    process.exit(0);
  }

  const host = hostname();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dataDir = process.env.CLAUDEMATRIX_DATA_DIR || join(homedir(), ".claude", "local", "claudematrix");
  const envFile = process.env.CLAUDE_ENV_FILE;

  // Persist session ID for later hooks
  if (envFile) {
    try {
      appendFileSync(envFile, `export CLAUDEMATRIX_SESSION_ID='${sessionId}'\n`);
    } catch {
      // Non-fatal
    }
  }

  // Discover agent ID: try discovery with 1s retry (MCP server may still be starting)
  let agentId = discoverAgentId(dataDir);
  if (!agentId) {
    await sleep(1000);
    agentId = discoverAgentId(dataDir);
  }
  if (!agentId) {
    agentId = deriveAgentId(sessionId);
  }

  // Persist discovered agent ID for subsequent hooks
  if (envFile) {
    try {
      appendFileSync(envFile, `export CLAUDEMATRIX_AGENT_ID='${agentId}'\n`);
    } catch {
      // Non-fatal
    }
  }

  let contextParts = [
    `[Claude Matrix] You are agent: ${agentId}`,
    `Project: ${projectDir}`,
  ];

  // Check for other agents
  const agentsDir = join(dataDir, "agents");
  try {
    mkdirSync(agentsDir, { recursive: true });
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    const now = Date.now();
    const STALE_THRESHOLD_MS = 90_000;
    const otherAgents = [];
    for (const file of files) {
      try {
        const record = JSON.parse(readFileSync(join(agentsDir, file), "utf8"));
        if (record.agent_id === agentId) continue;

        // Skip stale agents (no heartbeat for >90s)
        if (now - record.last_heartbeat > STALE_THRESHOLD_MS) continue;

        // PID liveness check (only valid on same host)
        if (record.hostname === host) {
          try { process.kill(record.pid, 0); } catch { continue; }
        }

        otherAgents.push(`  - ${record.agent_id} (${basename(record.project_dir)})`);
      } catch {
        // Skip malformed
      }
    }
    if (otherAgents.length > 0) {
      contextParts.push(`Other agents online:\n${otherAgents.join("\n")}`);
    }
  } catch {
    // No agents dir yet
  }

  // Check for unread notifications
  const notifFile = join(dataDir, "notifications", `${agentId}.json`);
  try {
    const notif = JSON.parse(readFileSync(notifFile, "utf8"));
    if (notif.unread_count > 0) {
      contextParts.push(`${notif.unread_count} unread message(s). Use /claude-matrix:inbox to read.`);
    }
  } catch {
    // No notifications yet
  }

  contextParts.push(
    "Use /claude-matrix:send to message other agents. Use /claude-matrix:contacts to see who's online."
  );

  const context = contextParts.join("\n");

  // Output structured additionalContext
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };

  process.stdout.write(JSON.stringify(output));
}

main().catch(() => process.exit(0));
