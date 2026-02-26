---
title: Claude Matrix Post-MVP Status and Roadmap
description: Comprehensive status report after Phase 1 MVP completion, documenting deferred issues, known limitations, and the full development roadmap
summary: Phase 1 MVP is complete with file-based transport, 3 MCP tools, 3 hooks, and 4 slash commands. Documents 4 deferred review issues, 3 plugin convention notes, testing strategy, and the Phase 2/3 roadmap toward cross-machine federation.
created: 2026-02-26
project: claude-matrix
tags: [status, roadmap, review, architecture]
---

# Claude Matrix Post-MVP Status and Roadmap

## Executive Summary

Phase 1 MVP is complete, reviewed, and pushed to GitHub at https://github.com/LinuxIsCool/claude-matrix. The plugin provides file-based inter-instance messaging between Claude Code sessions on the same machine. Two rounds of code review identified 11 issues; 7 were fixed, 4 were deferred as acceptable for Phase 1.

This document captures everything that remains: deferred issues, known limitations, testing strategy, and the full development roadmap through cross-machine federation.

---

## Current State

**Version**: 0.1.0
**Transport**: Filesystem (Phase 1)
**Repo**: https://github.com/LinuxIsCool/claude-matrix
**Plugin name**: `claude-matrix`

### What Works
- Agent auto-discovery via registration files + PID liveness checks
- 30s heartbeat with 90s staleness threshold
- Send/receive messages between sessions via atomic file writes + chokidar watching
- Hook-based context injection (identity at session start, unread notifications on each prompt)
- 4 slash commands: `/claude-matrix:status`, `/claude-matrix:send`, `/claude-matrix:inbox`, `/claude-matrix:contacts`
- Security: agent ID path traversal validation, session ID shell injection prevention
- Clean shutdown: agent deregistration, notification cleanup, inbox cleanup

### What Doesn't Work Yet
- No read cursor — messages are never consumed from disk, so `read_messages` returns the same messages every time
- No message persistence after session end (inbox is deleted on cleanup)
- No cross-machine messaging (filesystem transport is local only)
- No tests

---

## Deferred Review Issues

These were identified during code review but intentionally deferred:

### 1. Inbox deleted unconditionally on session end (Issue #4)

**Severity**: Medium
**Risk**: Messages arriving during shutdown are silently lost

`on-session-end.js` deletes all inbox files without checking if any are unread. If a peer sends a message immediately before/during teardown, it's lost with no record.

**Why deferred**: Phase 1 has no read cursor anyway — there's no concept of "read vs unread" at the file level. The NotificationBuffer tracks unreads in memory, but it's already gone by the time the SessionEnd hook runs (MCP server shuts down first). Fixing this properly requires a read cursor (Phase 2 feature).

**Future fix**: Implement a read cursor file (`~/.claude/local/claudematrix/cursors/{agent_id}.json`) that tracks the last-read timestamp. SessionEnd hook checks cursor vs inbox files before deleting. Or: don't delete inbox on session end at all — let messages accumulate and be available on next session start.

### 2. Stale threshold duplicated between TypeScript and JavaScript (Issue #9)

**Severity**: Low
**Risk**: Values could diverge if only one is updated

`AGENT_STALE_THRESHOLD_MS = 90_000` exists in both `server/src/types/agent.ts` and `scripts/on-session-start.js`. The hook script can't import from TypeScript source.

**Why deferred**: Both values match. Risk is a future maintenance slip, not a current bug.

**Future fix**: Extract constants into a shared JSON config file (e.g., `config/constants.json`) that both TypeScript and JS can `readFileSync` and parse. Or: have the build step generate a `scripts/lib/constants.js` from the TypeScript source.

### 3. AgentRegistry cache refresh not guarded against concurrent calls (Issue #10)

**Severity**: Low
**Risk**: Duplicate filesystem scans on concurrent tool calls

If two MCP tool calls hit `getAll()` simultaneously when the cache is expired, both trigger `discoverAgents()`. The second overwrites the first's result, which is benign.

**Why deferred**: Node.js is single-threaded. The `await` in `discoverAgents()` yields to the event loop, but the sync `readdirSync`/`readFileSync` calls don't interleave. Worst case is two filesystem scans in the same tick — wasteful but harmless.

**Future fix**: Add a `refreshPromise` field to coalesce concurrent refreshes:

```typescript
private refreshPromise: Promise<AgentRecord[]> | null = null;

async getAll(): Promise<AgentRecord[]> {
  if (Date.now() < this.cacheExpiry) return this.cachedAgents;
  if (!this.refreshPromise) {
    this.refreshPromise = this.transport.discoverAgents().then(agents => {
      this.cachedAgents = agents;
      this.cacheExpiry = Date.now() + this.cacheTtlMs;
      this.refreshPromise = null;
      return agents;
    });
  }
  return this.refreshPromise;
}
```

### 4. writeAtomic duplicated between FileTransport and NotificationBuffer (Issue #11)

**Severity**: Low
**Risk**: Bug fix in one copy doesn't propagate to the other

Both `FileTransport.writeAtomic()` and `NotificationBuffer.writeNotificationFile()` implement the same temp-file-then-rename pattern independently.

**Why deferred**: They're small (10 lines each) and work correctly. Extracting a utility adds a new file for minimal benefit at this stage.

**Future fix**: Extract into `src/utils/fs.ts`:

```typescript
export function writeAtomic(targetPath: string, data: string): void {
  const dir = path.dirname(targetPath);
  const tempPath = path.join(dir, `.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(tempPath, data, "utf8");
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw err;
  }
}
```

---

## Plugin Convention Notes

From plugin validator:

### 1. SessionStart matcher field

`hooks/hooks.json` uses `"matcher": "startup|resume|clear|compact"` for SessionStart. This field is documented for PreToolUse/PostToolUse (where it matches tool names) but may not function for SessionStart events. It might be silently ignored — meaning the hook fires on every session start regardless.

**Status**: Needs real-world testing. If it's ignored, remove it to avoid confusion.

### 2. mcpServers not declared in plugin.json

The MCP server is configured only in `.mcp.json`, not mirrored in `plugin.json`. This is functionally fine — Claude Code reads `.mcp.json` separately. But declaring it in the manifest improves discoverability.

**Status**: Optional. Can add later if plugin discovery becomes a concern.

### 3. .claude/commands/build.md lacks frontmatter

The `/build` command in `.claude/commands/` is a development-time convenience, not a user-facing plugin command. It lives in the project-local command space and has no YAML frontmatter.

**Status**: Fine as-is. It's not shipped as part of the plugin's `commands/` directory.

---

## Testing Strategy

### Unit Tests (Priority 1)

Use vitest. Test the core modules in isolation:

**FileTransport**:
- `send()` writes atomic JSON to correct inbox directory
- `readMessages()` respects `since_ts`, `from_agent`, `limit` filters
- `discoverAgents()` returns only live, non-stale agents
- `validateAgentId()` rejects path traversal attempts
- `extractRecipient()` correctly parses room IDs with `|` separator
- Concurrent reads during writes don't produce corrupt data

**MessageStore**:
- `send()` constructs valid Matrix event envelope
- `read()` delegates to transport with correct agent ID
- `deriveRoomId()` produces deterministic, sorted IDs
- Self-send is blocked at tool level (not store level)

**NotificationBuffer**:
- `push()` creates correct summary from event
- `flush()` returns and clears all items atomically
- `writeNotificationFile()` produces valid JSON matching NotificationFile schema
- Debounce coalesces rapid pushes into single write

**AgentRegistry**:
- `getAll()` returns cached results within TTL
- `getAll()` refreshes after TTL expires
- `register()` + `unregister()` lifecycle works correctly
- Heartbeat updates last_heartbeat in agent file

### Integration Tests (Priority 2)

Test the full pipeline:
- Two FileTransport instances sending messages to each other
- Message arrives → NotificationBuffer.push() → notification file updated
- Agent registration → discovery from another transport instance
- Heartbeat keeps agent alive across stale threshold

### Hook Tests (Priority 3)

Shell-based tests piping JSON to stdin:
- `on-session-start.js` with valid UUID → outputs correct additionalContext JSON
- `on-session-start.js` with invalid session ID → exits 0, no output
- `on-prompt-submit.js` with notification file present → outputs unread summary
- `on-session-end.js` → cleans up agent, notification, inbox files

---

## Roadmap

### Phase 1.1: Polish (Next)

- [ ] Live two-session test (install plugin, open two Claude Code sessions, message between them)
- [ ] Add vitest unit tests for core modules
- [ ] Implement read cursor (track last-read timestamp per agent)
- [ ] Don't delete inbox on session end — preserve for next session
- [ ] Extract shared `writeAtomic` utility
- [ ] Extract shared constants config

### Phase 2: Unix Socket Transport

Replace filesystem IPC with Unix domain sockets for lower latency:

- Create `UnixSocketTransport` implementing `Transport` interface
- Each agent listens on `/tmp/claude-matrix/agent-{id}.sock`
- NDJSON framing for message boundaries
- Benchmarks show 2-3x faster than filesystem for same-machine messaging
- Keep filesystem transport as fallback for robustness
- Socket path limit: 104 bytes macOS, 108 bytes Linux — `/tmp/claude-matrix.sock` (24 chars) is safe

### Phase 3: Matrix Homeserver Federation

Cross-machine messaging via Conduit homeserver:

- Deploy Conduit (lightweight Rust Matrix homeserver) on mothership
- Create `MatrixTransport` implementing `Transport` interface
- Agent registration maps to Matrix user accounts
- Room IDs become real Matrix rooms
- Messages become real Matrix events (already wire-compatible)
- `com.claudematrix.*` custom event types work natively in Matrix
- Cross-machine agent discovery via Matrix user directory
- End-to-end encryption via Vodozemac (Matrix's Olm replacement)

### Phase 4: Agent Capabilities and Task Delegation

Beyond messaging:
- Agent capability advertisement (what tools/skills each agent has)
- Task delegation protocol (request agent to perform work)
- Result streaming (progress updates during delegated tasks)
- Agent roster management (persistent contacts across sessions)

---

## Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport interface from day 1 | Yes | Enables Phase 2/3 without changing core modules |
| Matrix-shaped envelopes | Yes | Wire-compatible with real Matrix — zero migration cost for Phase 3 |
| Hook-MCP bridge via files | Not HTTP/sockets | Simplest possible — MCP writes file, hooks read it. Zero infrastructure. |
| Room ID `\|` separator | Not `_` | Hostnames can contain underscores; `\|` cannot appear in agent IDs |
| Agent ID `session-{8}@host` | Not PID-based | Deterministic from session UUID, survives restarts, human-readable |
| Data at `~/.claude/local/claudematrix/` | Not temp dir | Survives reboots, follows Claude Code conventions, controlled by env var |
| Build output committed to git | Not ignored | Zero-friction plugin installation — no build step required after clone |
| Plugin name `claude-matrix` | Not `claudematrix` | Kebab-case matches repo name and Claude Code conventions |

---

## Files Modified in Review Cycle

Security fixes:
- `server/src/transport/FileTransport.ts` — `validateAgentId()` + calls at all path-constructing methods
- `scripts/on-session-start.js` — hex+dash regex validation for session ID

Logic fixes:
- `server/src/mcp/tools/send_message.ts` — self-send blocking
- `server/src/core/MessageStore.ts` — exposed `agentId`, renamed `total_unread` → `messages_returned`
- `server/src/types/message.ts` — `ReadResult.messages_returned`
- `server/src/core/NotificationBuffer.ts` — `splice(0)` in `flush()`
- `commands/status.md` — removed stale `unread_only` reference

Naming:
- All files — `claudematrix` → `claude-matrix` for plugin name, MCP server key, command prefixes, slash command references
