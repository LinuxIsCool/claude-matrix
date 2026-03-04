import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { FileTransport } from "../transport/FileTransport.js";
import type { AgentRegistration, MatrixEvent } from "../types/index.js";

let tmpDir: string;
let transport: FileTransport;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cm-test-"));
}

function makeRegistration(
  agentId: string,
  overrides?: Partial<AgentRegistration>,
): AgentRegistration {
  return {
    agent_id: agentId,
    session_id: `sess-${agentId}`,
    project_dir: `/tmp/${agentId}`,
    hostname: os.hostname(),
    pid: process.pid,
    claude_pid: process.ppid,
    ...overrides,
  };
}

function makeEvent(sender: string, recipient: string, body: string): MatrixEvent {
  const sorted = [sender, recipient].sort();
  return {
    event_id: crypto.randomUUID(),
    type: "com.claudematrix.message",
    sender,
    room_id: `!${sorted[0]}|${sorted[1]}:local`,
    origin_server_ts: Date.now(),
    content: { msgtype: "m.text", body },
  };
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(async () => {
  if (transport) {
    try { await transport.stop(); } catch { /* ignore */ }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("FileTransport", () => {
  describe("lifecycle", () => {
    it("creates directories on start", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "test@host" });
      await transport.start();
      expect(fs.existsSync(path.join(tmpDir, "agents"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "messages"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "notifications"))).toBe(true);
      expect(transport.isHealthy()).toBe(true);
    });

    it("sets healthy to false on stop", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "test@host" });
      await transport.start();
      await transport.stop();
      expect(transport.isHealthy()).toBe(false);
    });
  });

  describe("agent registration", () => {
    it("registers and discovers an agent", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));

      const agents = await transport.discoverAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].agent_id).toBe("agent-a@host");
      expect(agents[0].status).toBe("online");
    });

    it("unregisters an agent", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));
      await transport.unregisterAgent("agent-a@host");

      const agents = await transport.discoverAgents();
      expect(agents).toHaveLength(0);
    });

    it("rejects agent IDs with path traversal characters", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "safe@host" });
      await transport.start();
      await expect(
        transport.registerAgent(makeRegistration("../evil@host")),
      ).rejects.toThrow("Invalid agent ID");
    });

    it("persists claude_pid in registration", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host", { claude_pid: 12345 }));

      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(record.claude_pid).toBe(12345);
    });
  });

  describe("discovery", () => {
    it("marks stale agents", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));

      // Backdate the heartbeat
      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      record.last_heartbeat = Date.now() - 100_000; // > 90s threshold
      fs.writeFileSync(filePath, JSON.stringify(record));

      const agents = await transport.discoverAgents();
      expect(agents[0].status).toBe("stale");
    });

    it("removes agents with dead PIDs", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "observer@host" });
      await transport.start();

      // Write a registration with a dead PID
      const filePath = path.join(tmpDir, "agents", "dead-agent@host.json");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          agent_id: "dead-agent@host",
          session_id: "sess",
          hostname: os.hostname(),
          pid: 999999, // almost certainly dead
          project_dir: "/tmp",
          display_name: "test",
          registered_at: Date.now(),
          last_heartbeat: Date.now(),
          status: "online",
        }),
      );

      const agents = await transport.discoverAgents();
      expect(agents.find((a) => a.agent_id === "dead-agent@host")).toBeUndefined();
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe("messaging", () => {
    it("sends and reads messages", async () => {
      const transportA = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      const transportB = new FileTransport({ dataDir: tmpDir, agentId: "agent-b@host" });
      await transportA.start();
      await transportB.start();

      const event = makeEvent("agent-a@host", "agent-b@host", "Hello B!");
      await transportA.send(event);

      const messages = await transportB.readMessages("agent-b@host");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toEqual({ msgtype: "m.text", body: "Hello B!" });
      expect(messages[0].sender).toBe("agent-a@host");

      await transportB.stop();
      await transportA.stop();
      transport = null!; // prevent afterEach from stopping again
    });

    it("filters messages by since_ts", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-b@host" });
      await transport.start();

      const sender = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await sender.start();

      const oldEvent = makeEvent("agent-a@host", "agent-b@host", "old");
      oldEvent.origin_server_ts = Date.now() - 60_000;
      await sender.send(oldEvent);

      const newEvent = makeEvent("agent-a@host", "agent-b@host", "new");
      await sender.send(newEvent);

      const messages = await transport.readMessages("agent-b@host", {
        since_ts: Date.now() - 10_000,
      });
      expect(messages).toHaveLength(1);
      expect((messages[0].content as { body: string }).body).toBe("new");

      await sender.stop();
    });

    it("ignores .tmp- files when reading", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-b@host" });
      await transport.start();

      const inboxDir = path.join(tmpDir, "messages", "agent-b@host");
      fs.writeFileSync(
        path.join(inboxDir, ".tmp-orphan-12345"),
        '{"garbage": true}',
      );

      const messages = await transport.readMessages("agent-b@host");
      expect(messages).toHaveLength(0);
    });
  });

  describe("heartbeat", () => {
    it("updates last_heartbeat timestamp", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));

      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const before = JSON.parse(fs.readFileSync(filePath, "utf8")).last_heartbeat;

      // Small delay to ensure timestamp changes
      await new Promise((r) => setTimeout(r, 10));
      await transport.heartbeat("agent-a@host");

      const after = JSON.parse(fs.readFileSync(filePath, "utf8")).last_heartbeat;
      expect(after).toBeGreaterThan(before);
    });
  });

  describe("chokidar watcher", () => {
    it("fires onMessage callback for new inbox files", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-b@host" });

      const received: MatrixEvent[] = [];
      transport.onMessage("agent-b@host", (event) => {
        received.push(event);
      });

      await transport.start();

      // Wait for chokidar to be ready
      await new Promise((r) => setTimeout(r, 200));

      // Write a message file directly to the inbox
      const inboxDir = path.join(tmpDir, "messages", "agent-b@host");
      const event = makeEvent("agent-a@host", "agent-b@host", "realtime!");
      fs.writeFileSync(
        path.join(inboxDir, `${Date.now()}-${event.event_id}.json`),
        JSON.stringify(event),
      );

      // Wait for chokidar to pick it up
      await new Promise((r) => setTimeout(r, 500));

      expect(received).toHaveLength(1);
      expect((received[0].content as { body: string }).body).toBe("realtime!");
    });
  });
});
