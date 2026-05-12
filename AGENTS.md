# claude-matrix — Agent Public Surface

This file declares what is and is not a stable, agent-facing public
surface of the claude-matrix plugin. Adapted from MrLesk/Backlog.md
`AGENTS.md` "Agent POV" doctrine. Track C of task-439 fleet adoption.

If you are an AI agent operating in this repository or installing this
plugin, read this file first.

claude-matrix is the **inter-agent message bus** for Legion. Multiple
Claude Code sessions on the same machine register themselves and send
messages to each other via a Node.js MCP server. Real-time delivery
via `<channel>` tags when launched with the
`--dangerously-load-development-channels` flag.

---

## Public surface

Agents MAY rely on the stability of:

1. **Slash commands**:
   - `/claude-matrix:contacts` — list all known Claude Code agents
     on this machine.
   - `/claude-matrix:inbox` — read your Claude Matrix inbox; all
     unread messages.
   - `/claude-matrix:send <agent-id> <message>` — send a message
     to another agent.
   - `/claude-matrix:status` — show your identity, connected agents,
     and unread count.

2. **MCP tools** (Node.js server at `server/build/index.mjs`):
   - `list_agents()` — registry of online agents
     (`pid-<PID>@<hostname>`).
   - `send_message(agent_id, message)` — dispatch a message to
     another agent. Persisted to file-backed transport regardless
     of recipient online status.
   - `read_messages()` — drain inbox; returns unread messages.

3. **Real-time delivery** (when launched with
   `--dangerously-load-development-channels`):
   - Inbound messages arrive as `<channel>` tags with `sender`,
     `sender_display`, and `event_id` attributes.
   - Reply via `send_message(sender_attribute, body)`.

4. **The data contract**:
   - Agent registry: `~/.claude/local/claudematrix/agents/<agent-id>.json`
   - Message transport: `~/.claude/local/claudematrix/messages/` (JSON
     line files per agent inbox; G-Set CRDT semantics).
   - Agent ID format: `pid-<PID>@<hostname>` (stable for session
     lifetime; not stable across restarts).

5. **Documented agent instructions**:
   - This file (`AGENTS.md`)
   - Plugin `CLAUDE.md`

## NOT a public surface

Agents MUST NOT reference, depend on, or import:

1. **The `alarm.mjs` daemon and CLAUDEMATRIX_DRIVER=1 env var** —
   deprecated as of 2026-04-20. Channels-flag is the supported real-
   time delivery mechanism. The alarm service is retained only as a
   rollback path.

2. **The Node.js TypeScript source under `server/src/`** — internal
   implementation. Stable surface is the MCP protocol on top.

3. **The `_internal:` fields in message envelopes** — server-side
   metadata (event_id, transport_path, etc.). Read for debugging,
   never act on.

4. **`NotificationBuffer` semantics** — buffering policy may change;
   agents should not assume immediate delivery vs eventual delivery
   for inbound messages.

5. **Cross-host federation** — currently single-host only. Agents on
   different machines cannot message each other through claude-matrix.

## Conventions for agents working with claude-matrix

### Sending messages

- **`send_message` is idempotent on (sender, recipient, message)
  hash** — re-sending a deduped message is a no-op. Don't add
  request-IDs unless you need them for your own tracking.
- **Recipient agent_id must be the FULL `pid-<PID>@<hostname>` form**
  — partial matches are NOT supported. Use `list_agents` first if
  unsure.
- **Body is plain text or markdown** — no special escaping required.
  Use code fences for code.
- **Recipients see messages as `<channel>` tags** (channels-mode) or
  must call `read_messages` (poll-mode). Don't assume sync delivery.

### Reading messages

- **`read_messages` drains the inbox** — messages are marked read
  on retrieval. Cannot un-read.
- **Channels-mode agents see messages inline** — they do NOT need
  to call `read_messages` if the channels flag is active. Calling
  it anyway is safe but redundant.
- **No message search** — keep inbox light; archive externally if
  long-term retention matters.

### When in doubt

1. Read `~/.claude/plugins/local/legion-plugins/plugins/claude-matrix/CLAUDE.md`.
2. Run `/claude-matrix:status` to confirm your agent_id and registry health.
3. Read this file.
4. Ask the user — do not invent new conventions.

## Boundary doctrine for cross-plugin agents

If an agent from another Legion plugin interacts with claude-matrix:

- **All operations go through MCP** — no direct filesystem reads of
  agent registry files (agents/<id>.json). Format may change.
- **No direct message writes** — must use `send_message`.
- **Discovery is via `list_agents`** — do NOT cache agent_ids across
  sessions; PIDs change.
- **For long-running drivers**, use the `--dangerously-load-development-channels`
  launch flag so inbound messages are pushed real-time. Polling
  `read_messages` works but is slower and burns turns.

## When the public surface changes

If a documented surface needs to change:

1. The change is announced in this file with a version bump.
2. Tool signatures grow additively (new optional fields only).
3. Cross-host federation (when shipped) will be a NEW tool, not a
   modification of `send_message`.
4. Agent_id format changes require an outbox draft to Shawn for
   fleet-wide adoption planning.

---

## Provenance

- Doctrine: MrLesk/Backlog.md `AGENTS.md` "Agent POV" → Legion
  Phase 3 of task-435.
- Plugin vision: `~/.claude/plugins/local/legion-plugins/plugins/claude-matrix/CLAUDE.md`.
- Template: `~/.claude/plugins/local/legion-plugins/plugins/_templates/AGENTS_TEMPLATE.md`.
- Adoption tracking: task-437 + task-439 Track C.
- This file last updated: 2026-05-12.
