# ClaudeMatrix Development

See @README.md for full project documentation.

## Quick Reference

- **Language**: TypeScript (server), ESM JavaScript (hooks)
- **Build**: `cd server && npm run build`
- **Test server**: `timeout 3 node server/build/index.js 2>&1 || true`
- **Test hooks**: `echo '{"session_id":"abc12345-abcd-1234-abcd-123456789abc"}' | node scripts/on-session-start.js`

## Key Conventions

- All filesystem paths constructed from agent IDs are validated against `/^[\w\-.@]+$/`
- Session IDs are validated as hex+dash before writing to env files
- Atomic writes everywhere: temp file + `fs.renameSync()`
- MCP tools use Zod raw shapes (not `z.object()`) per SDK v1.x conventions
- TypeScript imports require `.js` extensions (`NodeNext` module resolution)
- Hook scripts must exit 0 on all error paths — never block Claude Code
- `console.error()` for logging in MCP server (stdout is JSON-RPC)

## Architecture

Transport interface (`types/transport.ts`) is the central abstraction. Core modules depend only on it:
- `FileTransport` — Phase 1 filesystem IPC
- `AgentRegistry` — discovery + heartbeat cache (5s TTL)
- `MessageStore` — send/read with Matrix envelope construction
- `NotificationBuffer` — unread tracking + disk notification file for hooks
