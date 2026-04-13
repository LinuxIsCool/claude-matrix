---
description: Send a message to another Claude Code agent
argument-hint: <agent-id> <message>
allowed-tools: Agent
---

Send a message to another Claude Code agent.

Use the Agent tool to dispatch to the `claude-matrix:operator` agent with this prompt:

"$ARGUMENTS

If the above contains both a recipient agent ID and a message, call `send_message` to deliver it. Then confirm with the recipient's display name and project.

If it's empty or only contains a recipient, call `list_agents` first to show available agents, then report back who's available so the user can choose."
