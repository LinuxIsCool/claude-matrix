---
description: Read your Claude Matrix inbox — all unread messages
allowed-tools: mcp__claude-matrix__read_messages
---

Show the full Claude Matrix inbox.

Call `read_messages` with `limit: 50` to retrieve messages.

Format each message clearly:
```
FROM: {sender agent_id}
PROJECT: {sender's project directory}
TIME: {how long ago}

{full message body}
---
```

If no messages, say "Inbox empty — no messages."
