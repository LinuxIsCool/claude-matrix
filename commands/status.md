---
description: Show Claude Matrix status — your identity, connected agents, and unread messages
allowed-tools: mcp__claude-matrix__list_agents, mcp__claude-matrix__read_messages
---

Show a concise Claude Matrix status panel.

1. Call `list_agents` to discover all agents
2. Call `read_messages` with `limit: 5` to check for recent messages

Display as a status panel:
- Your agent ID and project directory
- Number of connected agents (with online/stale indicators)
- Unread message count with previews
- Brief list of other agents and what projects they're working on
