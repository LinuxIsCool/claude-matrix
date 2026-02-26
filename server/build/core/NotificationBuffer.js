import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
export class NotificationBuffer {
    notificationsDir;
    selfAgentId;
    unread = [];
    writeDebounceTimer = null;
    debounceMs = 200;
    constructor(notificationsDir, selfAgentId) {
        this.notificationsDir = notificationsDir;
        this.selfAgentId = selfAgentId;
    }
    push(event) {
        const summary = {
            from_agent: event.sender,
            from_display: event.sender.split("@")[0].replace("session-", ""),
            from_project_dir: event["com.claudematrix.project_dir"] ?? "unknown",
            preview: "body" in event.content
                ? event.content.body.slice(0, 120)
                : "[non-text event]",
            received_at: Date.now(),
            event_id: event.event_id,
        };
        this.unread.push(summary);
        this.scheduleWrite();
    }
    flush() {
        if (this.writeDebounceTimer) {
            clearTimeout(this.writeDebounceTimer);
            this.writeDebounceTimer = null;
        }
        const items = this.unread.splice(0);
        this.writeNotificationFile();
        return items;
    }
    getUnreadCount() {
        return this.unread.length;
    }
    getSummaries() {
        return [...this.unread];
    }
    writeNotificationFile() {
        const file = {
            generated_at: Date.now(),
            agent_id: this.selfAgentId,
            unread_count: this.unread.length,
            summaries: this.unread.slice(0, 10), // Cap at 10 summaries
        };
        const filePath = path.join(this.notificationsDir, `${this.selfAgentId}.json`);
        const tempPath = path.join(this.notificationsDir, `.tmp-${process.pid}-${crypto.randomUUID()}`);
        try {
            fs.mkdirSync(this.notificationsDir, { recursive: true });
            fs.writeFileSync(tempPath, JSON.stringify(file, null, 2), "utf8");
            fs.renameSync(tempPath, filePath);
        }
        catch {
            try {
                fs.unlinkSync(tempPath);
            }
            catch {
                // Ignore
            }
        }
    }
    scheduleWrite() {
        if (this.writeDebounceTimer)
            return;
        this.writeDebounceTimer = setTimeout(() => {
            this.writeDebounceTimer = null;
            this.writeNotificationFile();
        }, this.debounceMs);
    }
}
//# sourceMappingURL=NotificationBuffer.js.map