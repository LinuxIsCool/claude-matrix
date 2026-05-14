---
description: Set, clear, or display this agent's live focus task. Phase 1 of task-490.
allowed-tools: Agent, mcp__plugin_claude-matrix_claude-matrix__list_agents
---

Set or clear this Claude Code agent's live focus task. The focus is
persisted on the agent's registry record and surfaced in `list_agents`
output. Phase 3 of task-490 will render the focused task with a glow
in the claude-webui kanban.

# Usage

```
/focus              → show current focus from list_agents output (this agent)
/focus 490          → set_focus(task_id=490, source="explicit")
/focus task-490     → set_focus(task_id=490, source="explicit")
/focus clear        → clear_focus()
/focus --help       → this help text
```

Argument: $ARGUMENTS

# What to do

Parse `$ARGUMENTS`. Trim whitespace.

**If empty or `--help`** — call `list_agents`, find the row marked
`(you)`, and report the current focus from the `focus: task-N (source)`
fragment. If no focus fragment is present, output `no focus set`.

**If `clear`** — call the `clear_focus` MCP tool (no args). Output
the tool's text response verbatim.

**If matches `^\d+$` (bare integer) or `^task-\d+$` (string form)** —
call the `set_focus` MCP tool with `{task_id: <value>, source: "explicit"}`.
Output the tool's text response verbatim. Do NOT add commentary.

**If matches anything else** — print a 1-line error pointing at
`/focus --help`. Do not call any tool.

# Output style

Terse. One line per invocation. The user is mid-flow; don't editorialize.

# Notes for the agent

- `set_focus` and `clear_focus` are MCP tools registered by
  `claude-matrix` (Phase 1 of task-490). They edit THIS agent's own
  record only — you cannot set focus on another agent.
- The change is durable: it survives heartbeat cycles (heartbeat is
  read-merge-write per the Phase 0 pin test).
- The change is live-pushed to `agents/` watchers via FileTransport's
  agents-directory chokidar watcher (200ms debounce).
