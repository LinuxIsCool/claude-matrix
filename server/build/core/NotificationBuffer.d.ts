import type { MatrixEvent, NotificationSummary } from "../types/index.js";
export declare class NotificationBuffer {
    private readonly notificationsDir;
    private readonly selfAgentId;
    private unread;
    private writeDebounceTimer;
    private readonly debounceMs;
    constructor(notificationsDir: string, selfAgentId: string);
    push(event: MatrixEvent): void;
    flush(): NotificationSummary[];
    getUnreadCount(): number;
    getSummaries(): NotificationSummary[];
    writeNotificationFile(): void;
    private scheduleWrite;
}
