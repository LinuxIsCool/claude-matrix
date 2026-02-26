#!/usr/bin/env node

/**
 * UserPromptSubmit hook: inject unread message notifications.
 * Reads the notification file written by the MCP server's NotificationBuffer.
 * Must be fast (< 5s timeout) — just a file read.
 *
 * Stdin: JSON with session_id, prompt, etc.
 * Stdout: JSON with hookSpecificOutput.additionalContext (if unread messages exist)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { deriveAgentId } from "./lib/agent-id.js";

async function main() {
  const sessionId = process.env.CLAUDEMATRIX_SESSION_ID;
  if (!sessionId) {
    // Session ID not yet persisted — first prompt before env was loaded
    // Try reading from stdin
    try {
      const input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
      if (!input.session_id) process.exit(0);
      // Can't use stdin session_id reliably here since it's the prompt hook
      process.exit(0);
    } catch {
      process.exit(0);
    }
  }

  const agentId = deriveAgentId(sessionId);
  const dataDir =
    process.env.CLAUDEMATRIX_DATA_DIR ||
    join(homedir(), ".claude", "local", "claudematrix");
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

main().catch(() => process.exit(0));
