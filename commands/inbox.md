---
description: Read your Claude Matrix inbox — all unread messages
allowed-tools: Agent
---

Show the full Claude Matrix inbox.

Use the Agent tool to dispatch to the `claude-matrix:operator` agent with this prompt:

"Call `read_messages` with limit 50 to retrieve all inbox messages. Format each message showing: FROM (agent_id and display_name), PROJECT, TIME (relative), and the full message body. If no messages, say 'Inbox empty — no messages.'"
