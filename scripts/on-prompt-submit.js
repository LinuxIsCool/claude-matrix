#!/usr/bin/env node

/**
 * UserPromptSubmit hook: inject unread message notifications.
 * Reads the notification file written by the MCP server's NotificationBuffer.
 * Must be fast (< 5s timeout) — just a file read.
 *
 * Agent ID resolution:
 *   1. CLAUDEMATRIX_AGENT_ID env var (set by session-start hook)
 *   2. discoverAgentId() — match claude_pid from /proc ancestry
 *   3. deriveAgentId(sessionId) — legacy fallback
 *
 * Stdout: JSON with hookSpecificOutput.additionalContext (if unread messages exist)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { deriveAgentId, discoverAgentId } from "./lib/agent-id.js";

async function main() {
  const dataDir =
    process.env.CLAUDEMATRIX_DATA_DIR ||
    join(homedir(), ".claude", "local", "claudematrix");

  // Resolve agent ID: env var → discovery → derive
  let agentId = process.env.CLAUDEMATRIX_AGENT_ID;
  if (!agentId) {
    agentId = discoverAgentId(dataDir);
  }
  if (!agentId) {
    const sessionId = process.env.CLAUDEMATRIX_SESSION_ID;
    if (!sessionId) process.exit(0);
    agentId = deriveAgentId(sessionId);
  }

  const notifFile = join(dataDir, "notifications", `${agentId}.json`);

  let notif;
  try {
    notif = JSON.parse(readFileSync(notifFile, "utf8"));
  } catch {
    process.exit(0);
  }

  if (!notif.unread_count || notif.unread_count === 0) {
    process.exit(0);
  }

  // Build notification summary
  const lines = notif.summaries
    .slice(0, 5)
    .map((s) => {
      const ago = Math.round((Date.now() - s.received_at) / 1000);
      return `  - ${s.from_agent} (${s.from_project_dir}): "${s.preview}" (${ago}s ago)`;
    });
  if (notif.summaries.length > 5) {
    lines.push(`  ... and ${notif.summaries.length - 5} more`);
  }

  const context = [
    `[Claude Matrix] ${notif.unread_count} unread message(s):`,
    ...lines,
    "Use /claude-matrix:inbox to read full messages.",
  ].join("\n");

  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };

  process.stdout.write(JSON.stringify(output));
}

main().catch((err) => {
  console.error("[claude-matrix] on-prompt-submit error:", err);
  process.exit(0);
});
