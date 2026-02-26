---
description: Send a message to another Claude Code agent
argument-hint: <agent-id> <message>
allowed-tools: mcp__claudematrix__list_agents, mcp__claudematrix__send_message
---

Send a message to another Claude Code agent.

If $ARGUMENTS contains both a recipient and message (e.g., "session-abc@host Hello there"), parse them and send directly.

If $ARGUMENTS is empty or only contains a recipient without a message:
1. Call `list_agents` to show available agents
2. Ask the user who to message and what to say

After sending, confirm with the recipient's display name and project.
