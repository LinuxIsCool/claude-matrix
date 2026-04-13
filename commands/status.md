---
description: Show Claude Matrix status — your identity, connected agents, and unread messages
allowed-tools: Agent
---

Show a concise Claude Matrix status panel.

Use the Agent tool to dispatch to the `claude-matrix:operator` agent with this prompt:

"Call `list_agents` to discover all agents, and `read_messages` with limit 5 to check for recent messages. Display as a compact status panel: your agent ID and project, number of connected agents (online/stale), unread message count with previews, and brief list of other agents and their projects."
