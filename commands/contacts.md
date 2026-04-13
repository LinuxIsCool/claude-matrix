---
description: List all known Claude Code agents on this machine
allowed-tools: Agent
---

Show the Claude Matrix contacts list.

Use the Agent tool to dispatch to the `claude-matrix:operator` agent with this prompt:

"Call `list_agents` to discover all agents on this machine. Format as a contacts directory table showing: Agent ID (highlight which one is you with ← you), Display Name, Project directory, Status (online/stale), and time since last heartbeat."
