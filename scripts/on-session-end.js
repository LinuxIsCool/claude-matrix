#!/usr/bin/env node

/**
 * SessionEnd hook: clean up agent registration and inbox.
 * Removes agent file, notification file, and inbox messages.
 */

import { unlinkSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { deriveAgentId } from "./lib/agent-id.js";

const sessionId = process.env.CLAUDEMATRIX_SESSION_ID;
if (!sessionId) {
  process.exit(0);
}

const agentId = deriveAgentId(sessionId);
const dataDir =
  process.env.CLAUDEMATRIX_DATA_DIR ||
  join(homedir(), ".claude", "local", "claudematrix");

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
