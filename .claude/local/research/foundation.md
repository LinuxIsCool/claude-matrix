# ClaudeMatrix: foundational research for Matrix-based inter-agent communication

**Building a Claude Code plugin for inter-instance communication via Matrix is feasible today.** Claude Code's plugin system (public beta since October 2025) supports bundled MCP servers, 14+ hook events, and a Git-based marketplace — providing all the extensibility primitives needed. The Matrix protocol offers a battle-tested, decentralized messaging layer that runs locally without federation, and the Conduit homeserver can operate with just ~50MB RAM. An existing Matrix MCP server already demonstrates the integration pattern. This report covers every technical layer required to build ClaudeMatrix, from plugin scaffolding to encryption models.

---

## Claude Code's plugin system provides the full extensibility surface

Claude Code plugins are distributable extension packages that bundle slash commands, subagents, skills, hooks, MCP servers, and LSP servers into shareable units. The only required element is a `.claude-plugin/` directory; Claude Code auto-discovers components in conventional locations.

**Plugin directory structure:**

```
claudematrix/
├── .claude-plugin/
│   └── plugin.json          # Metadata manifest
├── commands/                # Slash commands (/claudematrix:send, etc.)
│   └── send.md
├── agents/                  # Isolated subagent definitions
│   └── matrix-agent.md
├── skills/                  # Model-invoked contextual knowledge
│   └── messaging/SKILL.md
├── hooks/
│   └── hooks.json           # Event handlers
├── .mcp.json                # Bundled MCP server config
├── scripts/
│   └── matrix-server.js     # MCP server binary
└── README.md
```

The plugin manifest (`plugin.json`) supports `name`, `version`, `description`, `author`, `repository`, and `license` fields. Plugin commands are automatically namespaced (e.g., `/claudematrix:send`) to prevent conflicts.

**The hooks system is critical for real-time message injection.** Claude Code exposes **14+ hook events** including `SessionStart` (inject context on startup), `UserPromptSubmit` (inject context before processing), `Notification` (when notifications fire), `PreToolUse`/`PostToolUse` (intercept tool execution), and `SubagentStop`/`TeammateIdle` (react to agent state changes). Hook handlers can be shell commands or LLM-evaluated prompts. Crucially, stdout from `SessionStart` and `UserPromptSubmit` hooks is **injected directly into Claude's context**, and the `hookSpecificOutput.additionalContext` field enables real-time context enrichment — this is the mechanism for notifying the active Claude instance about incoming Matrix messages.

**MCP servers bundle directly into plugins** via `.mcp.json` at the plugin root. The `${CLAUDE_PLUGIN_ROOT}` variable ensures path portability:

```json
{
  "mcpServers": {
    "claudematrix": {
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/matrix-server.js",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": { "MATRIX_TOKEN": "${MATRIX_TOKEN}" }
    }
  }
}
```

The MCP server starts automatically when the plugin is enabled, communicates via stdio using JSON-RPC 2.0, and supports up to **20 simultaneous MCP servers** without degradation.

**The marketplace system uses Git repositories** with a `marketplace.json` registry file — structurally identical to the Homebrew tap and Obsidian community plugin models. Users add marketplaces via `/plugin marketplace add username/repo`, then install with `/plugin install pluginname@marketplace`. Both local paths and GitHub repos are supported as plugin sources. The official Anthropic marketplace lives at `github.com/anthropics/claude-plugins-official`, and community directories like `claudemarketplaces.com` aggregate third-party marketplaces.

---

## Matrix runs locally with minimal overhead and supports custom agent event types

The Matrix protocol defines RESTful HTTP JSON APIs for synchronizing events between clients and homeservers. For ClaudeMatrix, the critical insight is that **Matrix works perfectly as a purely local messaging system** — federation can be disabled, the homeserver can bind to `127.0.0.1`, and no DNS, certificates, or internet access are needed.

**Conduit** (Rust-based) is the recommended homeserver for local deployment: a single **~15MB binary** using an embedded SQLite database, consuming approximately **50MB RAM** idle. Configuration is minimal:

```toml
[global]
server_name = "localhost"
database_path = "./data"
database_backend = "sqlite"
address = "127.0.0.1"
port = 6167
allow_registration = true
allow_federation = false
```

Dendrite (Go) is a viable alternative at ~100MB RAM with SQLite support, while Synapse (Python, reference implementation) requires 500MB–1GB minimum and is too heavy for embedded use. No Matrix homeserver can run as an embedded Node.js library — the practical pattern is spawning Conduit as a child process, polling `/_matrix/client/versions` until ready, then connecting via HTTP on localhost.

**The Matrix data model maps naturally to agent communication.** Everything in Matrix is an event — a JSON object with `type`, `content`, `sender`, `room_id`, and `event_id`. Custom event types use reverse-DNS namespacing:

```typescript
// Custom agent message event
await client.sendEvent(roomId, "com.claudematrix.agent.task", {
  agent_id: "agent-research-001",
  task_type: "research",
  status: "in_progress",
  payload: { query: "Find information about X" }
});

// Custom state event for agent registration
await client.sendStateEvent(roomId, "com.claudematrix.agent.registration", {
  agent_id: "agent-001",
  capabilities: ["research", "code_review"],
  status: "online"
}, "agent-001");  // state_key = agent_id
```

For SDK choice, **matrix-bot-sdk** is optimal for the initial build — it's designed for bots/agents in Node.js with a simpler API, built-in `SimpleFsStorageProvider` for CLI tools, and auto-join mixins. Its limitation is no native E2E encryption; if encryption becomes critical, migrate to **matrix-js-sdk** which includes full Olm/Megolm support via vodozemac (Rust compiled to WASM). For local-only deployments, encryption adds complexity without clear benefit.

Matrix rooms support `public`, `invite`-only, `knock` (request to join), and `restricted` (Space membership-gated) join rules. Direct messages are simply invite-only rooms with an `is_direct` flag. The power levels system (integers 0–100) provides fine-grained permissions for each room action.

---

## The MCP server architecture bridges Matrix messaging to Claude Code

The MCP server is the integration core — it maintains a persistent Matrix client internally and exposes messaging capabilities as tools, resources, and prompts that Claude Code can invoke.

**The TypeScript MCP SDK (v2)** provides `McpServer` and `StdioServerTransport` as the foundation. A ClaudeMatrix MCP server would register tools like `send_message`, `read_messages`, `list_rooms`, `create_room`, `join_room`, and `invite_user`, plus subscribable resources for room message streams:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "claudematrix", version: "1.0.0" });

server.registerTool("send_message", {
  title: "Send Matrix Message",
  description: "Send a message to a Matrix room or agent",
  inputSchema: {
    roomId: z.string().describe("Matrix room ID"),
    message: z.string().describe("Message text"),
  },
}, async ({ roomId, message }) => {
  await matrixClient.sendMessage(roomId, { msgtype: "m.text", body: message });
  return { content: [{ type: "text", text: `Message sent to ${roomId}` }] };
});
```

**An existing reference implementation already exists**: `mjknowles/matrix-mcp-server` on GitHub (27 stars, MIT license) provides **15 tools** across read-only and write tiers, using Streamable HTTP transport with OAuth 2.0. ClaudeMatrix would adapt this pattern but use stdio transport for Claude Code plugin integration and maintain a persistent Matrix sync loop rather than ephemeral per-tool clients.

**Real-time message notification uses MCP resource subscriptions.** When the server declares `resources.subscribe` capability, Claude Code can subscribe to resources like `matrix://!roomId/messages`. The server's internal Matrix sync loop detects new messages and emits `notifications/resources/updated`, prompting Claude Code to re-read the resource. This is the cleanest path to near-real-time message awareness. Additionally, the MCP protocol supports **server-initiated sampling** (requesting Claude to generate a response) and **elicitation** (requesting user input), enabling auto-reply workflows and confirmation dialogs.

Key operational patterns from existing messaging MCP servers (Slack, Discord) confirm that **poll-on-demand is the dominant pattern** — Claude calls `read_messages` when it needs updates. The Discord MCP server demonstrates the persistent-connection pattern: it maintains an always-on Discord.js bot internally, and tools operate on this connected client. ClaudeMatrix should follow this approach with matrix-bot-sdk's persistent sync loop.

---

## Inter-agent communication leverages established multi-agent patterns

**Google's A2A (Agent-to-Agent) protocol** (v0.3, July 2025, 150+ partners, Linux Foundation governance) is the most relevant standard for cross-agent communication. It defines Agent Cards published at `/.well-known/agent.json` for discovery, task-oriented messaging via JSON-RPC 2.0 over HTTPS, and supports synchronous, streaming (SSE), and async push notification modes. A2A explicitly complements MCP: **MCP standardizes agent-to-tool communication; A2A standardizes agent-to-agent communication.**

For **local agent discovery** on the same machine, file-based registration is the recommended approach. Each agent writes a JSON registration file to `~/.claudematrix/agents/` containing its ID, PID, capabilities, socket path, and heartbeat timestamp. Discovery involves scanning this directory, validating PIDs via `process.kill(pid, 0)`, and cleaning stale entries. This pattern requires zero external dependencies and is human-debuggable.

**The recommended transport hierarchy is:**

- **Primary (same-machine, real-time)**: Unix domain sockets with newline-delimited JSON (NDJSON). Benchmarks show Unix sockets are **2–3x faster** than TCP localhost, bypassing the entire network stack. Each agent listens on `/tmp/claudematrix/agent-{id}.sock`.
- **Secondary (same-machine, async/offline)**: File-based inbox at `~/.claudematrix/inbox/{agent-id}/` with `chokidar` file watching for near-instant notification.
- **Tertiary (cross-machine)**: Matrix protocol via Conduit homeserver, with A2A-compatible Agent Cards for remote discovery.

The **inbox/outbox pattern with store-and-forward** handles offline agents: messages go to an outbox table (SQLite), a background process monitors for recipient availability, and delivers when the target comes online. The transactional outbox pattern (write business data + outbox message in a single SQLite transaction) provides **at-least-once delivery guarantees**.

Contact management follows the XMPP roster pattern: each agent maintains a roster of known agents with subscription states (`none`, `to`, `from`, `both`), capabilities, groups/tags, and presence status. A capability index (inverted index from capability → agent IDs) enables "find an agent that can do X" queries — essentially a FIPA Directory Facilitator implemented as a local SQLite table.

---

## A four-tier security model maps directly onto Matrix's access controls

The proposed security architecture draws from government classification systems (Top Secret/Secret/Confidential/Unclassified), the Bell-LaPadula formal model, and Matrix's native encryption and room controls:

| Tier | Label | Content examples | Matrix room config | Access |
|------|-------|------------------|--------------------|--------|
| 4 | SECRET | API keys, credentials, internal reasoning | Invite-only, E2EE mandatory, `m.federate: false` | Agent owner + explicitly authorized |
| 3 | PRIVATE | User PII, task context, collaboration data | Invite-only, E2EE mandatory | Named verified agents |
| 2 | TRUSTED | Shared knowledge, plans, coordination state | Restricted/knock, E2EE mandatory | Agents in trusted federation |
| 1 | PUBLIC | Capabilities, status, discovery info | Public, encryption optional | Any agent |

**Bell-LaPadula rules apply to information flow**: an agent at Tier N can read from Tier N or below ("no read up") and write to Tier N or above ("no write down"). This prevents downward leakage — Tier 3 data must never appear in a Tier 1 channel. Each message carries a classification label in its content as a custom field (`io.claudematrix.classification`).

Matrix's **power levels system** (integers 0–100 with per-action thresholds) implements RBAC at the room level, while custom state events can encode ABAC policies for fine-grained per-message decisions based on agent attributes and task context.

**Trust establishment between unknown agents** follows a layered approach: TOFU (trust-on-first-use, SSH-style) for Tier 1 initial discovery, Matrix cross-signing (web of trust) for Tier 2–3 relationship trust, and certificate-based trust (Agent CA issuing short-lived certs) for Tier 3–4 authorization. Zero Trust principles from NIST SP 800-207 apply throughout: no implicit trust based on network location, per-session access evaluation, and continuous monitoring.

**Forward secrecy** is provided by Olm's Double Ratchet for 1:1 channels and Megolm's hash ratchet for group rooms. For high-security tiers, Megolm sessions should rotate every N messages or T minutes, and session keys must be deleted after task completion. Data retention policies vary by tier: **1 hour** for SECRET, **24 hours** for PRIVATE, **7–30 days** for TRUSTED, and indefinite for PUBLIC.

---

## Plugin distribution follows the Obsidian/Homebrew registry model

For structuring ClaudeMatrix as an installable plugin, the optimal approach uses Claude Code's native marketplace system — a Git repository containing a `.claude-plugin/marketplace.json` that points to plugin sources:

```json
{
  "name": "claudematrix-marketplace",
  "owner": { "name": "ClaudeMatrix Team" },
  "metadata": { "description": "Inter-agent communication via Matrix" },
  "plugins": [
    {
      "name": "claudematrix",
      "source": "./plugins/claudematrix",
      "description": "Matrix-based agent messaging for Claude Code",
      "version": "1.0.0"
    }
  ]
}
```

Users install with two commands: `/plugin marketplace add your-org/claudematrix` then `/plugin install claudematrix@claudematrix-marketplace`. The marketplace JSON can reference both local directories (`./plugins/...`) and external GitHub repos (`github:user/repo`), enabling a mix of core and community plugins.

**Git submodules, subtrees, and npm workspaces are not recommended** for the marketplace aggregation layer. Submodules add contributor friction (requires `--recursive` cloning, detached HEAD issues), subtrees pollute commit history, and npm workspaces are designed for JS monorepos with shared dependencies — not markdown/config plugin bundles. The **JSON registry pointing to external repos** (the Obsidian/Homebrew model) is simpler, scales to thousands of plugins, and is already natively supported by Claude Code.

For CI/CD, GitHub Actions should validate `marketplace.json` schema, verify plugin structure, check for required files, and enforce semantic versioning. Community plugins are accepted via PR, with automated validation and optional human review.

---

## Local IPC and storage round out the implementation stack

**SQLite via better-sqlite3** (synchronous API, 2–3x faster than node-sqlite3) provides local persistence with WAL mode for concurrent access. The schema covers agents, rooms, room_members, messages, and an outbox table for pending deliveries, plus an FTS5 virtual table for full-text message search. Apple's iMessage uses a structurally similar SQLite schema (`message`, `handle`, `chat` tables with many-to-many joins), validating this approach for messaging workloads.

**Unix domain sockets** serve as the primary local transport. Node.js's native `net` module creates servers and clients on socket paths like `/tmp/claudematrix/agent-{id}.sock`. The NDJSON (newline-delimited JSON) framing protocol handles message boundaries. Docker's architecture provides a direct precedent: REST API over Unix sockets for local communication, TCP for remote — exactly the dual-transport pattern ClaudeMatrix needs.

**The event-driven architecture** uses Node.js EventEmitter as an internal message bus, with chokidar (v5, used in 30M+ repos) for filesystem event watching. The notification chain implements layered fallback: Unix socket push → inotify/chokidar file watch → periodic polling at 5-second intervals. This ensures message delivery regardless of whether both agents are simultaneously online.

Design patterns from major messaging platforms inform the API design: Telegram's **offset-based message consumption** (idempotent replay), Discord's **intent-based event filtering** (only receive subscribed events) and heartbeat keepalive with session resume, Slack's **acknowledge-immediately-process-asynchronously** pattern, and Signal's **prekey bundles** for offline messaging. The JSON-RPC 2.0 protocol (used by both LSP and A2A) provides the wire format, with Content-Length framing for stdio transport and NDJSON for socket transport.

---

## Conclusion: a clear implementation path emerges

The research reveals that **every component needed for ClaudeMatrix exists and is production-ready** — no speculative technology is required. The critical architectural decisions are:

1. **Plugin structure**: Use Claude Code's native plugin system with bundled MCP server, hooks for context injection (`SessionStart` + `UserPromptSubmit` for message notifications), and custom slash commands for user-facing messaging operations.

2. **Communication stack**: Conduit homeserver (local, no federation) as the Matrix backbone, matrix-bot-sdk for the Node.js client, and Unix domain sockets as a fast local complement for same-machine agents. The MCP server maintains a persistent Matrix sync loop and exposes messaging as tools + subscribable resources.

3. **Discovery and identity**: File-based agent registration at `~/.claudematrix/agents/` for local discovery, A2A-compatible Agent Cards for remote discovery, and an XMPP-inspired roster stored in SQLite for contact management.

4. **Security**: Four-tier classification mapped to Matrix room types, power levels, and encryption settings. BLP information flow rules enforced at the application layer. TOFU for initial discovery, cross-signing for relationship trust, certificates for high-security tiers.

5. **Distribution**: Single GitHub repository structured as both marketplace and plugin, installable via Claude Code's native `/plugin marketplace add` command. Community contributions accepted via PR to the registry JSON.

The most significant finding is the existence of `mjknowles/matrix-mcp-server` — a working Matrix MCP server with 15 tools that validates the core integration pattern. ClaudeMatrix's primary innovation is not the Matrix-MCP bridge (that exists) but the **plugin packaging, hook-based real-time notification injection, local agent discovery layer, and four-tier security model** that together create a complete inter-instance communication system for Claude Code.