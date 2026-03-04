import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { NotificationBuffer } from "../core/NotificationBuffer.js";
import type { MatrixEvent } from "../types/index.js";

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cm-notif-test-"));
}

function makeEvent(sender: string, body: string): MatrixEvent {
  return {
    event_id: crypto.randomUUID(),
    type: "com.claudematrix.message",
    sender,
    room_id: `!${sender}|recipient@host:local`,
    origin_server_ts: Date.now(),
    content: { msgtype: "m.text", body },
    "com.claudematrix.project_dir": "/tmp/sender-project",
  };
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("NotificationBuffer", () => {
  it("tracks unread count after push", () => {
    const buffer = new NotificationBuffer(tmpDir, "agent@host");
    buffer.push(makeEvent("other@host", "Hello!"));
    expect(buffer.getUnreadCount()).toBe(1);
  });

  it("extracts preview from message body", () => {
    const buffer = new NotificationBuffer(tmpDir, "agent@host");
    buffer.push(makeEvent("session-abc12345@host", "Test message body"));

    const summaries = buffer.getSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].preview).toBe("Test message body");
    expect(summaries[0].from_agent).toBe("session-abc12345@host");
    expect(summaries[0].from_display).toBe("abc12345");
    expect(summaries[0].from_project_dir).toBe("/tmp/sender-project");
  });

  it("truncates preview at 120 characters", () => {
    const buffer = new NotificationBuffer(tmpDir, "agent@host");
    const longBody = "x".repeat(200);
    buffer.push(makeEvent("other@host", longBody));

    const summaries = buffer.getSummaries();
    expect(summaries[0].preview).toHaveLength(120);
  });

  it("flush clears unread and writes to disk", () => {
    const buffer = new NotificationBuffer(tmpDir, "agent@host");
    buffer.push(makeEvent("other@host", "msg1"));
    buffer.push(makeEvent("other@host", "msg2"));

    const flushed = buffer.flush();
    expect(flushed).toHaveLength(2);
    expect(buffer.getUnreadCount()).toBe(0);

    // Verify file was written with 0 unread (since flush clears first)
    const filePath = path.join(tmpDir, "agent@host.json");
    const file = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(file.unread_count).toBe(0);
    expect(file.agent_id).toBe("agent@host");
  });

  it("getSummaries returns a copy", () => {
    const buffer = new NotificationBuffer(tmpDir, "agent@host");
    buffer.push(makeEvent("other@host", "msg"));

    const summaries1 = buffer.getSummaries();
    const summaries2 = buffer.getSummaries();
    expect(summaries1).not.toBe(summaries2);
    expect(summaries1).toEqual(summaries2);
  });

  it("writeNotificationFile creates valid JSON", () => {
    const buffer = new NotificationBuffer(tmpDir, "agent@host");
    buffer.push(makeEvent("other@host", "msg1"));
    buffer.push(makeEvent("other@host", "msg2"));
    buffer.writeNotificationFile();

    const filePath = path.join(tmpDir, "agent@host.json");
    const file = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(file.unread_count).toBe(2);
    expect(file.summaries).toHaveLength(2);
    expect(typeof file.generated_at).toBe("number");
  });

  it("caps summaries at 10 in notification file", () => {
    const buffer = new NotificationBuffer(tmpDir, "agent@host");
    for (let i = 0; i < 15; i++) {
      buffer.push(makeEvent("other@host", `msg-${i}`));
    }
    buffer.writeNotificationFile();

    const filePath = path.join(tmpDir, "agent@host.json");
    const file = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(file.unread_count).toBe(15);
    expect(file.summaries).toHaveLength(10);
  });
});
