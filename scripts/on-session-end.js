#!/usr/bin/env node

/**
 * SessionEnd hook: clean up agent registration and inbox.
 * Removes agent file, notification file, and inbox messages.
 *
 * Agent ID resolution:
 *   1. CLAUDEMATRIX_AGENT_ID env var (set by session-start hook)
 *   2. discoverAgentId() — match claude_pid from /proc ancestry
 *   3. deriveAgentId(sessionId) — legacy fallback
 */

import { unlinkSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { deriveAgentId, discoverAgentId } from "./lib/agent-id.js";

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

// Remove agent registration
try {
  unlinkSync(join(dataDir, "agents", `${agentId}.json`));
} catch {
  // Already gone
}

// Remove notification file
try {
  unlinkSync(join(dataDir, "notifications", `${agentId}.json`));
} catch {
  // Already gone
}

// Remove alarm pane registry (driver only — harmless if not present)
try {
  unlinkSync(join(dataDir, "panes", `${agentId}.json`));
} catch {
  // Already gone or never registered (non-driver)
}

// Clean up inbox directory
try {
  const inboxDir = join(dataDir, "messages", agentId);
  for (const f of readdirSync(inboxDir)) {
    try {
      unlinkSync(join(inboxDir, f));
    } catch {
      // Skip
    }
  }
  rmdirSync(inboxDir);
} catch {
  // Already gone or not created
}
