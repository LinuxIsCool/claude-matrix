import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  MatrixEvent,
  NotificationFile,
  NotificationSummary,
} from "../types/index.js";

export class NotificationBuffer {
  private unread: NotificationSummary[] = [];
  private writeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs = 200;

  constructor(
    private readonly notificationsDir: string,
    private readonly selfAgentId: string,
  ) {}

  push(event: MatrixEvent): void {
    const summary: NotificationSummary = {
      from_agent: event.sender,
      from_display: event.sender.split("@")[0].replace("session-", ""),
      from_project_dir: event["com.claudematrix.project_dir"] ?? "unknown",
      preview:
        "body" in event.content
          ? (event.content as { body: string }).body.slice(0, 120)
          : "[non-text event]",
      received_at: Date.now(),
      event_id: event.event_id,
    };

    this.unread.push(summary);
    this.scheduleWrite();
  }

  flush(): NotificationSummary[] {
    if (this.writeDebounceTimer) {
      clearTimeout(this.writeDebounceTimer);
      this.writeDebounceTimer = null;
    }
    const items = this.unread.splice(0);
    this.writeNotificationFile();
    return items;
  }

  getUnreadCount(): number {
    return this.unread.length;
  }

  getSummaries(): NotificationSummary[] {
    return [...this.unread];
  }

  writeNotificationFile(): void {
    const file: NotificationFile = {
      generated_at: Date.now(),
      agent_id: this.selfAgentId,
      unread_count: this.unread.length,
      summaries: this.unread.slice(0, 10), // Cap at 10 summaries
    };

    const filePath = path.join(
      this.notificationsDir,
      `${this.selfAgentId}.json`,
    );
    const tempPath = path.join(
      this.notificationsDir,
      `.tmp-${process.pid}-${crypto.randomUUID()}`,
    );

    try {
      fs.mkdirSync(this.notificationsDir, { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(file, null, 2), "utf8");
      fs.renameSync(tempPath, filePath);
    } catch {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore
      }
    }
  }

  private scheduleWrite(): void {
    if (this.writeDebounceTimer) return;
    this.writeDebounceTimer = setTimeout(() => {
      this.writeDebounceTimer = null;
      this.writeNotificationFile();
    }, this.debounceMs);
  }
}
