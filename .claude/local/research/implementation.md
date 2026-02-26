# ClaudeMatrix plugin: implementation research deep-dive

**The Claude Code plugin system provides a viable but constrained foundation for building ClaudeMatrix.** MCP servers persist for the full session and can hold state (including a Matrix sync connection), hooks can inject real-time context via `additionalContext` JSON, and async hooks enable background side-effects. The critical gap is that **no timer-based hooks exist** — all context injection is event-driven — and **Conduit lacks macOS/Windows binaries**, requiring a compile-from-source strategy or platform-specific binary bundling. This report covers every implementation detail needed to begin coding, organized by subsystem.

---

## Session identity flows through hook JSON, not environment variables

Each Claude Code session receives a UUID-format `session_id`, but it is **only accessible via the JSON blob piped to hook stdin** — not as an environment variable. A feature request (GitHub #17188) for `CLAUDE_SESSION_ID` as an env var remains unimplemented. The workaround is to extract it in a `SessionStart` hook and persist it via `CLAUDE_ENV_FILE`:

```bash
HOOK_INPUT=$(cat)
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')
echo "export CLAUDE_SESSION_ID='$SESSION_ID'" >> "$CLAUDE_ENV_FILE"
```

The environment variables Claude Code does expose are narrower than expected:

| Variable | Scope | Purpose |
|---|---|---|
| `CLAUDE_PROJECT_DIR` | All hooks, MCP servers | Absolute project root path |
| `CLAUDE_PLUGIN_ROOT` | Plugin hooks only | Plugin directory path |
| `CLAUDE_ENV_FILE` | SessionStart/Setup hooks only | File for persisting env vars |
| `CLAUDECODE` | General | Set to `"1"` inside Claude Code |
| `CLAUDE_CODE_ENTRYPOINT` | General | How CC was started (e.g., `"cli"`) |

Project identity comes from `CLAUDE_PROJECT_DIR` (the CWD at launch). Sessions are stored as `.jsonl` transcripts at `~/.claude/projects/<project-hash>/<session-uuid>.jsonl`. A `sessions-index.json` per project tracks summaries, git branches, and timestamps. Sessions persist until the **30-day cleanup** (`cleanupPeriodDays` setting). Hook configurations are **snapshotted at startup** and cannot be modified mid-session, which is a security feature.

---

## Hooks can inject context and run async, but never fire on a timer

The hook system supports **13 event types**, all triggered by user actions or Claude's own behavior — none fire periodically. The complete event list: `SessionStart`, `Setup`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionEnd`. The closest to periodic firing is `Notification` with the `idle_prompt` matcher (fires after **60+ seconds** of waiting for user input) and `SessionStart` with `source: "compact"` (fires on auto-compaction as the context window fills).

**Context injection** works through two mechanisms. Plain text on stdout (exit code 0) becomes visible context. Structured JSON with `hookSpecificOutput.additionalContext` provides more discrete injection:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Unread Matrix messages: @alice: 'deploy approved' (2m ago)"
  }
}
```

For `UserPromptSubmit`, the hook receives the user's prompt text and can either augment it with `additionalContext` or **block it entirely** with `{"decision": "block", "reason": "..."}`. Blocked prompts are erased from context.

**Async hooks** (added ~v2.1.0) are critical for ClaudeMatrix. Adding `"async": true` to a command hook lets it run in the background without blocking Claude. The catch: async hook output (`systemMessage`, `additionalContext`) is **delivered on the next conversation turn**, not immediately. If the session is idle, it waits until the next user interaction. This means real-time Matrix notifications can only surface when the user next engages.

Hook **timeout defaults to 60 seconds** (configurable per hook via the `timeout` field in seconds). Some sources report a newer 10-minute default in v2.1.3+. The three hook handler types are `command` (shell), `prompt` (fast LLM single-turn), and `agent` (subagent with Read/Grep/Glob tools). Exit code semantics: **0** = success, **2** = blocking error, **other** = non-blocking warning.

**Hooks cannot invoke MCP tools.** They are isolated shell processes with no callback mechanism into Claude's MCP infrastructure. An open feature request (#6981) proposes allowing MCP servers to define hooks, but this is unimplemented. A hook can, however, call an HTTP API served by the MCP server process directly, since the MCP server runs as a local process.

---

## MCP servers persist for the full session and can hold stateful connections

This is the most architecturally important finding for ClaudeMatrix. The MCP specification **requires persistent connections** — a server that exits after one request violates the spec. For stdio-based plugin servers, Claude Code spawns the server process when the plugin is enabled and the session starts, then keeps it alive across **all prompts within that session**. The server can maintain any in-memory state: database connections, websocket connections, caches, and crucially, **a Matrix sync loop**.

The MCP SDK's **lifespan pattern** is the canonical way to manage persistent resources:

```python
@asynccontextmanager
async def app_lifespan(server: FastMCP) -> AsyncIterator[AppContext]:
    matrix_client = await connect_to_conduit()
    try:
        yield AppContext(matrix=matrix_client)  # Available to all tool calls
    finally:
        await matrix_client.stop()  # Cleanup on session end
```

Each Claude Code session gets **its own MCP server process** (stdio transport creates per-process isolation). Multiple sessions cannot share a stdio server. When the server crashes, Claude Code surfaces the error but **does not auto-restart** — the user must manually reconnect via `/mcp`. There is no idle-killing mechanism for stdio servers; they stay alive for the session's duration. The `MCP_TIMEOUT` environment variable controls startup timeout.

For testing, the **MCP Inspector** (`npx @modelcontextprotocol/inspector node build/index.js`) provides a web UI at `localhost:6274` with interactive tool testing, real-time JSON-RPC logging, and a CLI mode for CI/CD pipelines.

---

## Conduit runs entirely from environment variables with SQLite on localhost

The original Conduit remains the simplest option for embedded deployment, though its ecosystem has fragmented. **Conduit** → **conduwuit** (archived Jan 2026) → **Tuwunel** (Swiss government-sponsored successor) and **Continuwuity** (community fork). For a minimal embedded homeserver, original Conduit with SQLite is sufficient.

Conduit uses the **Figment** configuration library, which merges a TOML file with `CONDUIT_*` environment variables. The key discovery: setting `CONDUIT_CONFIG=''` (empty string) allows **fully environment-variable-driven configuration** with no config file at all:

```bash
CONDUIT_CONFIG='' \
CONDUIT_SERVER_NAME='localhost' \
CONDUIT_DATABASE_PATH='./conduit_data' \
CONDUIT_DATABASE_BACKEND='sqlite' \
CONDUIT_PORT='6167' \
CONDUIT_ADDRESS='127.0.0.1' \
CONDUIT_ALLOW_REGISTRATION='true' \
CONDUIT_ALLOW_FEDERATION='false' \
./conduit
```

Conduit has **no CLI flags** — it uses only env vars and config files. The defaults are already localhost-friendly: `address` defaults to `127.0.0.1` and `allow_federation` defaults to `false`.

**Programmatic user registration** uses the standard Matrix endpoint with `m.login.dummy` for open-registration servers:

```bash
POST http://localhost:6167/_matrix/client/v3/register
{"username": "agent1", "password": "secret", "auth": {"type": "m.login.dummy"}}
# Returns: {"access_token": "...", "user_id": "@agent1:localhost", "device_id": "..."}
```

For health checking, `GET /_matrix/client/versions` requires no auth and returns the server's supported protocol versions. There is no dedicated `/health` endpoint.

**Database sizing is a concern.** Even with just 4 users and a few hundred messages, SQLite databases reach **~400MB** due to E2EE one-time key storage. The database files are `conduit.db`, `conduit.db-wal`, and `conduit.db-shm` stored at the configured `database_path`. RAM usage sits at **~150MB** for small instances. Startup is sub-second for Conduit's single-binary Rust architecture — roughly **75× faster than Synapse** in benchmarks.

**Binary availability is the critical limitation.** Official binaries exist only for Linux (x86_64 and aarch64, statically linked musl builds at ~33–55MB). There are **no macOS or Windows binaries**. The npm distribution strategy must either compile from source via `cargo build --release` (requires Rust toolchain + libclang) or download platform-specific pre-built binaries. The conduwuit/Tuwunel forks also lack macOS/Windows releases.

---

## matrix-bot-sdk provides registration, DMs, and custom events out of the box

The `matrix-bot-sdk` npm package (v0.7.1, TypeScript) covers every Matrix interaction ClaudeMatrix needs. The `MatrixAuth` class handles both login and registration:

```typescript
import { MatrixAuth, MatrixClient, SimpleFsStorageProvider } from "matrix-bot-sdk";

const auth = new MatrixAuth("http://localhost:6167");
const client = await auth.passwordRegister("agent1", "password");
// client is now authenticated with access token set
```

`passwordRegister()` assumes the server supports `m.login.password` flow and completes only that stage — ideal for Conduit with open registration. For more control, `doRequest` provides raw API access:

```typescript
const response = await client.doRequest("POST", "/_matrix/client/v3/register", null, {
    username: "agent1", password: "password",
    auth: { type: "m.login.dummy" }
});
```

**SimpleFsStorageProvider** stores a JSON file (using `lowdb` with `FileSync` adapter) at any specified path. The default structure persists `syncToken`, `filter`, `appserviceUsers`, `appserviceTransactions`, and a generic `kvStore`. Parent directories are created automatically via `mkdirp`.

The **sync loop** uses HTTP long-polling against `/_matrix/client/v3/sync` with a **40-second HTTP timeout** per request (10 minutes for initial sync). When idle, it maintains a single open HTTP connection with roughly **one request every 10–30 seconds**. CPU usage is negligible while waiting. The loop has built-in **exponential backoff** on errors and does not crash on transient failures. To adjust polling frequency, set `client.syncingTimeout` before calling `start()`.

**DM room creation** is handled by the built-in `DMs` helper:

```typescript
const dmRoomId = await client.dms.getOrCreateDm("@otheruser:localhost");
```

**Custom event types** work through `sendEvent` and `sendStateEvent`:

```typescript
await client.sendEvent(roomId, "com.claudematrix.task", { task_id: "abc", status: "complete" });
client.on("room.event", (roomId, event) => {
    if (event.type === "com.claudematrix.task") { /* handle */ }
});
```

Note that the package hasn't been published in ~2 years. The maintained fork is `@vector-im/matrix-bot-sdk` from Element/Matrix.org.

---

## Cross-platform socket paths need careful management

Unix domain socket path limits differ: **104 bytes on macOS** vs **108 bytes on Linux**. Paths like `/tmp/claudematrix.sock` (24 chars) are safe; deep paths inside `~/.local/share/` risk hitting the limit. macOS does **not** support Linux's abstract namespace sockets (null-byte prefix). On Windows, named pipes at `\\.\pipe\claudematrix` replace sockets entirely — Node.js `net.createServer()` and `net.createConnection()` use the same API for both, just with different path strings. The `xpipe` npm package normalizes paths cross-platform.

For the plugin itself, Claude Code has **no built-in platform-conditional system**. Plugins handle OS differences in their own code (e.g., `process.platform` checks in the MCP server). Hook scripts are shell commands and inherently platform-dependent — Windows compatibility requires separate scripts or cross-platform runtimes like Node.js for hook handlers.

---

## Managed child processes beat detached daemons for plugin lifecycle

For spawning Conduit from the MCP server process, a **managed (non-detached) child process** is the recommended pattern. When the MCP server exits (session end), the child Conduit process exits automatically. This avoids orphan processes and simplifies lifecycle management:

```javascript
const child = spawn(conduitPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
child.on('exit', (code, signal) => { /* handle unexpected exit, attempt restart */ });

process.once('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
process.once('SIGINT', () => { child.kill('SIGTERM'); process.exit(0); });
```

Conduit responds to **SIGTERM** and **SIGINT** for graceful shutdown (standard Rust/Tokio signal handling). Always listen for the child's `exit` event to prevent zombie processes. For restart resilience, use exponential backoff (base 1s, max 30s, max 5 retries) with a retry counter that resets after 60 seconds of healthy operation.

PID files should go in `$XDG_RUNTIME_DIR` (auto-cleaned on logout) or `os.tmpdir()` as fallback. Use `fs.writeFileSync(path, data, { flag: 'wx' })` for atomic creation to prevent TOCTOU races, and `process.kill(pid, 0)` for cross-platform liveness checks. On startup, always check for stale PID files from previous crashed sessions.

---

## Plugin structure and development workflow

The canonical plugin directory layout for ClaudeMatrix would be:

```
claudematrix/
├── .claude-plugin/
│   └── plugin.json          # name, version, description
├── commands/
│   └── matrix-status.md     # /matrix-status slash command
├── hooks/
│   └── hooks.json           # SessionStart + UserPromptSubmit hooks
├── .mcp.json                # MCP server definition
├── servers/
│   └── matrix-mcp-server.js # Bundled MCP server
├── scripts/
│   └── inject-notifications.sh
└── bin/
    └── conduit-<platform>   # Platform-specific Conduit binary
```

The `.mcp.json` would reference the server as `{"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/servers/matrix-mcp-server.js"]}`. Testing uses `claude --plugin-dir ./claudematrix` (no hot reload — restart required for changes). Hook isolation testing pipes JSON to stdin: `echo '{"session_id":"test","hook_event_name":"SessionStart"}' | ./scripts/inject-notifications.sh`. The `claude --debug` flag reveals plugin loading details, hook registration, and MCP server initialization.

## Conclusion

The architecture is viable but shaped by three key constraints. First, **context injection is event-driven only** — the `UserPromptSubmit` hook is the natural place to poll for new Matrix messages and inject them as `additionalContext`, making every user prompt a trigger for notification delivery. Second, **MCP server persistence is the architectural linchpin** — the server can hold a running matrix-bot-sdk sync loop for the entire session, accumulating messages that hooks then surface. Third, **Conduit's binary situation forces a build-from-source strategy on macOS**, or alternatively, using the official Docker image with a thin wrapper on non-Linux platforms. The ~400MB database footprint for even minimal deployments suggests implementing message retention policies early. The most elegant pattern would pair a `SessionStart` hook (to inject the session ID and bootstrap context) with a `UserPromptSubmit` hook (to pull accumulated notifications from the MCP server's in-memory buffer on each prompt) — no timer needed, just piggyback on user interaction.