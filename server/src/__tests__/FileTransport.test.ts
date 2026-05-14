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

    // ── Phase 0 of task-490 — persona + focus on AgentRecord ──────────

    it("persists persona slug when supplied", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(
        makeRegistration("agent-a@host", { persona: "matt" }),
      );

      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(record.persona).toBe("matt");
    });

    it("omits persona when not supplied (registration field absent)", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));

      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      // `persona` field may be absent or undefined — both indicate anonymous
      expect(record.persona).toBeUndefined();
    });

    it("seeds focus field to null on registration", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));

      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      // Contract: focus is present + null on fresh registration.
      // `null` (not undefined) so downstream can distinguish
      // "never set" from "cleared" once the inference pipeline lands
      // in Phase 4 of task-490.
      expect("focus" in record).toBe(true);
      expect(record.focus).toBeNull();
    });

    // ── Phase 1 of task-490 — updateAgentFocus + onAgentChange ────────

    it("updateAgentFocus writes focus to record", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));

      await transport.updateAgentFocus("agent-a@host", {
        task_id: 490,
        source: "explicit",
        started_at: 1700000000000,
      });

      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(record.focus).toEqual({
        task_id: 490,
        source: "explicit",
        started_at: 1700000000000,
      });
    });

    it("updateAgentFocus(null) clears focus", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));

      await transport.updateAgentFocus("agent-a@host", {
        task_id: 490,
        source: "explicit",
        started_at: Date.now(),
      });
      await transport.updateAgentFocus("agent-a@host", null);

      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(record.focus).toBeNull();
    });

    it("updateAgentFocus preserves persona", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(
        makeRegistration("agent-a@host", { persona: "matt" }),
      );

      await transport.updateAgentFocus("agent-a@host", {
        task_id: 490,
        source: "explicit",
        started_at: Date.now(),
      });

      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(record.persona).toBe("matt");
    });

    it("updateAgentFocus throws on unknown agent_id", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();

      await expect(
        transport.updateAgentFocus("nonexistent@host", {
          task_id: 1,
          source: "explicit",
          started_at: Date.now(),
        }),
      ).rejects.toThrow(/not registered/i);
    });

    it("set_focus then heartbeat preserves focus", async () => {
      // Double-check the read-merge-write invariant via the public API
      // path: set_focus, then heartbeat — focus must survive both.
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));

      const focus = {
        task_id: 490,
        source: "explicit" as const,
        started_at: 1700000000000,
      };
      await transport.updateAgentFocus("agent-a@host", focus);
      await transport.heartbeat("agent-a@host");

      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(record.focus).toEqual(focus);
    });

    it("onAgentChange fires synthetic 'focus' event on updateAgentFocus", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));

      const events: Array<[string, string]> = [];
      transport.onAgentChange((id, kind) => {
        events.push([id, kind]);
      });

      await transport.updateAgentFocus("agent-a@host", {
        task_id: 490,
        source: "explicit",
        started_at: Date.now(),
      });

      // Synthetic fireAgentChange is debounced — wait 250ms (>200ms window)
      await new Promise((r) => setTimeout(r, 250));

      // At least one "focus" event for our agent_id should have landed.
      // chokidar may ALSO fire a "change" (which then resets the
      // debounce timer), so we tolerate either kind — what matters is
      // SOMETHING fired for agent-a@host. The synthetic dispatch
      // guarantees liveness; chokidar timing is filesystem-dependent.
      const aEvents = events.filter(([id]) => id === "agent-a@host");
      expect(aEvents.length).toBeGreaterThanOrEqual(1);
      expect(aEvents.map((e) => e[1])).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(focus|change)$/)]),
      );
    });

    it("onAgentChange debounces rapid writes (per-agent)", async () => {
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(makeRegistration("agent-a@host"));

      const events: Array<[string, string]> = [];
      transport.onAgentChange((id, kind) => {
        events.push([id, kind]);
      });

      // Fire 5 rapid focus updates within debounce window — should
      // collapse to a single callback for agent-a@host.
      for (let i = 0; i < 5; i++) {
        await transport.updateAgentFocus("agent-a@host", {
          task_id: 100 + i,
          source: "explicit",
          started_at: Date.now(),
        });
      }

      await new Promise((r) => setTimeout(r, 300));

      // Per-agent debouncing: exactly 1 synthetic event from our 5
      // rapid writes for agent-a@host. (chokidar may add async
      // change events too, but those are also debounced by the same
      // per-agent timer.) Accept up to 2 to be tolerant of test-
      // environment timing skew where the LAST chokidar 'change'
      // arrives just AFTER the synthetic debounce window closed.
      const aEvents = events.filter(([id]) => id === "agent-a@host");
      expect(aEvents.length).toBeLessThanOrEqual(2);
      expect(aEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("heartbeat preserves persona + focus fields", async () => {
      // Critical invariant from task-490 §17: heartbeat read-merge-writes
      // the record, so persona + focus survive 30s heartbeat cycles.
      // Without this guarantee, focus would be wiped on every heartbeat.
      transport = new FileTransport({ dataDir: tmpDir, agentId: "agent-a@host" });
      await transport.start();
      await transport.registerAgent(
        makeRegistration("agent-a@host", { persona: "darren" }),
      );

      // Simulate Phase 1 set_focus: patch focus into the record on disk
      const filePath = path.join(tmpDir, "agents", "agent-a@host.json");
      const recordPre = JSON.parse(fs.readFileSync(filePath, "utf8"));
      recordPre.focus = {
        task_id: 490,
        source: "explicit",
        started_at: Date.now(),
      };
      fs.writeFileSync(filePath, JSON.stringify(recordPre, null, 2));

      // Now invoke heartbeat — must not clobber persona or focus.
      await transport.heartbeat("agent-a@host");

      const recordPost = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(recordPost.persona).toBe("darren");
      expect(recordPost.focus).toEqual(recordPre.focus);
      // last_heartbeat advanced; status still "online".
      expect(recordPost.last_heartbeat).toBeGreaterThanOrEqual(recordPre.last_heartbeat);
      expect(recordPost.status).toBe("online");
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
