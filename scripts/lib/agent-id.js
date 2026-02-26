/**
 * Shared agent ID derivation — single source of truth for hook scripts.
 * Must match the logic in server/src/index.ts.
 */

import { hostname } from "node:os";

export function deriveAgentId(sessionId) {
  const host = hostname();
  return `session-${sessionId.slice(0, 8)}@${host}`;
}
