# Claude Matrix

Inter-instance messaging plugin for Claude Code. Lets multiple Claude Code sessions discover each other and exchange messages using a Matrix-shaped protocol over filesystem transport.

## What It Does

- **Auto-discovery**: Sessions on the same machine automatically find each other via agent registration files
- **Messaging**: Send and receive messages between Claude Code instances using MCP tools
- **Hook-based notifications**: Unread message counts injected into Claude's context at session start and on each prompt
- **Matrix-compatible**: Message envelopes follow the Matrix Client-Server API shape, enabling future federation

## Prerequisites

- Node.js >= 20
- Claude Code with plugin support

## Installation

```bash
claude plugin marketplace add LinuxIsCool/claude-matrix
claude plugin install claude-matrix@claude-matrix
```

The MCP server ships as a single bundled file (`server/build/index.mjs`) — no `npm install` needed.

To rebuild from source:

```bash
cd server && npm install && npm run build
```

## Slash Commands

| Command | Description |
|---------|-------------|
| `/claude-matrix:status` | Show your identity, connected agents, and unread messages |
| `/claude-matrix:send <agent> <message>` | Send a message to another agent |
| `/claude-matrix:inbox` | Read all messages in your inbox |
| `/claude-matrix:contacts` | List discovered agents on this machine |

## MCP Tools

The plugin provides three MCP tools available to Claude:

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to another agent by ID |
| `read_messages` | Read inbox messages with optional limit filter |
| `list_agents` | Discover all registered agents (online/stale) |

## Driver vs. non-driver launch template (Phase 0 — current)

**All personas** launch WITH `--dangerously-load-development-channels plugin:claude-matrix@legion-plugins`:

```bash
claude --dangerously-load-development-channels plugin:claude-matrix@legion-plugins --agent <persona>
```

The channels flag gives every persona real-time KAIROS push of inbound matrix messages via the
`notifications/claude/channel` JSON-RPC the claude-matrix MCP server emits. The flag disables
the native `AskUserQuestion` tool via hard-coded `isEnabled()`, but MCP tools are not filtered
by that gate — so drivers use
`mcp__plugin_claude-dialog_ui__ask` from the
[`claude-dialog`](../claude-dialog/) plugin for interactive popups instead.

| Tool | With channels flag | Without channels flag |
|------|:--:|:--:|
| `AskUserQuestion` (native) | ❌ disabled by `isEnabled()` | ✅ available |
| `mcp__plugin_claude-dialog_ui__ask` | ✅ available | ✅ available |
| KAIROS channel push (`<channel>` tags in context) | ✅ real-time, inline content | ❌ no push |

Persona YAMLs list **both** tools — Claude Code surfaces whichever is enabled in the current
launch config. See
[backlog id 223](../../local/backlog/driver-orchestrator-architecture.md) and
[Phase 0 plan](../../plans/2026-04-20-driver-v2-phase-0.md) for the decision history.

### Legacy: alarm daemon

`scripts/alarm.mjs` + `claude-matrix-alarm.service` are **retained but disabled**. They were
the Phase-N-minus-1 workaround that ran flagless drivers with an inotify poke pattern.
Superseded 2026-04-20 after Spike R1 confirmed the MCP bypass path.

Rollback (if Phase 0 regresses in production):

```bash
systemctl --user enable --now claude-matrix-alarm.service
# and restore CLAUDEMATRIX_DRIVER=1 launch for driver personas
```

## Architecture

```
claude-matrix/
├── .claude-plugin/plugin.json       # Plugin manifest
├── .mcp.json                        # MCP server configuration
├── hooks/hooks.json                 # SessionStart, UserPromptSubmit, SessionEnd hooks
├── scripts/                         # Hook scripts (ESM JavaScript)
│   ├── lib/agent-id.js              # Shared agent ID derivation
│   ├── on-session-start.js          # Identity injection + peer discovery
│   ├── on-prompt-submit.js          # Unread notification injection
│   └── on-session-end.js            # Cleanup on exit
├── commands/                        # Slash commands
│   ├── status.md, send.md, inbox.md, contacts.md
└── server/                          # TypeScript MCP server
    └── src/
        ├── index.ts                 # Composition root
        ├── types/                   # Matrix event envelope, agent, transport interfaces
        ├── transport/
        │   └── FileTransport.ts     # Phase 1: filesystem IPC with chokidar
        ├── core/
        │   ├── AgentRegistry.ts     # Agent discovery + heartbeat cache
        │   ├── MessageStore.ts      # Send/read with metadata injection
        │   └── NotificationBuffer.ts # Unread tracking + disk notifications
        └── mcp/
            ├── server.ts            # McpServer wiring
            └── tools/               # MCP tool implementations
```

### Transport Abstraction

The `Transport` interface is the load-bearing abstraction that enables evolution:

- **Phase 1** (current): Filesystem — atomic file writes, chokidar watching, per-agent inbox directories
- **Phase 2** (planned): Unix sockets — lower-latency local messaging
- **Phase 3** (planned): Matrix homeserver — cross-machine federation via Conduit

Core modules (`AgentRegistry`, `MessageStore`, `NotificationBuffer`) depend only on the `Transport` interface, never on concrete implementations.

### Data Layout

```
~/.claude/local/claudematrix/
├── agents/{agent_id}.json           # Agent registration (heartbeat, PID, project)
├── messages/{agent_id}/             # Per-agent inbox (one JSON file per message)
├── notifications/{agent_id}.json    # Notification file for hooks
├── panes/{agent_id}.json            # Driver tmux pane registry (alarm daemon target)
└── alarm.log                        # Alarm daemon operation log
```

### Agent Identity

Agent IDs follow the format `session-{first8_of_session_uuid}@{hostname}` (e.g., `session-abc12345@pop-os`). This is human-readable and unique across machines.

### Message Format

Messages use Matrix-shaped event envelopes with custom namespaced extensions:

```json
{
  "event_id": "uuid",
  "type": "com.claudematrix.message",
  "sender": "session-abc12345@pop-os",
  "room_id": "!session-abc12345@pop-os|session-def67890@pop-os:local",
  "origin_server_ts": 1740000000000,
  "content": { "msgtype": "m.text", "body": "Hello from another session!" },
  "com.claudematrix.project_dir": "/home/user/project",
  "com.claudematrix.schema_version": "1.0",
  "com.claudematrix.transport": "filesystem"
}
```

## How It Works

1. **Session Start**: Hook script extracts session ID, persists it to `CLAUDE_ENV_FILE`, injects agent identity and peer list into Claude's context
2. **MCP Server**: Starts alongside Claude, registers agent, begins 30s heartbeat, watches inbox via chokidar
3. **Messaging**: `send_message` tool writes atomic JSON files to recipient's inbox directory; chokidar fires callback on recipient's MCP server
4. **Notifications**: `NotificationBuffer` writes unread summaries to disk; `UserPromptSubmit` hook reads and injects them into Claude's context
5. **Session End**: Hook cleans up agent registration, notification file, and inbox directory

## License

MIT
