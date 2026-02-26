import type { MatrixEvent } from "./event.js";

export interface MessageFilter {
  since_ts?: number;
  from_agent?: string;
  limit?: number;
}

export interface ReadResult {
  messages: MatrixEvent[];
  messages_returned: number;
}

export interface NotificationFile {
  generated_at: number;
  agent_id: string;
  unread_count: number;
  summaries: NotificationSummary[];
}

export interface NotificationSummary {
  from_agent: string;
  from_display: string;
  from_project_dir: string;
  preview: string;
  received_at: number;
  event_id: string;
}
