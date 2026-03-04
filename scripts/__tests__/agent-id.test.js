import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveAgentId, findClaudePid, discoverAgentId } from "../lib/agent-id.js";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cm-agentid-test-"));
}

/**
 * Build a mock readStatus function from a process tree definition.
 * Each entry: { pid, name, ppid }
 */
function mockProcTree(tree) {
  const byPid = new Map(tree.map((e) => [e.pid, e]));
  return (pid) => {
    const entry = byPid.get(pid);
    if (!entry) throw new Error(`No such process: ${pid}`);
    return `Name:\t${entry.name}\nPPid:\t${entry.ppid}\n`;
  };
}

describe("deriveAgentId", () => {
  it("derives from session ID and hostname", () => {
    const id = deriveAgentId("abc12345-0000-0000-0000-000000000000");
    expect(id).toBe(`session-abc12345@${os.hostname()}`);
  });

  it("takes first 8 characters of session ID", () => {
    const id = deriveAgentId("deadbeef-cafe-babe-dead-beefcafebabe");
    expect(id).toBe(`session-deadbeef@${os.hostname()}`);
  });
});

describe("findClaudePid", () => {
  it("finds claude as immediate parent", () => {
    const readStatus = mockProcTree([
      { pid: 100, name: "claude", ppid: 1 },
    ]);
    // Mock process.ppid to point at 100
    const origPpid = process.ppid;
    Object.defineProperty(process, "ppid", { value: 100, writable: true });
    try {
      expect(findClaudePid(readStatus)).toBe(100);
    } finally {
      Object.defineProperty(process, "ppid", { value: origPpid, writable: true });
    }
  });

  it("finds claude two levels up", () => {
    const readStatus = mockProcTree([
      { pid: 200, name: "node", ppid: 100 },
      { pid: 100, name: "claude", ppid: 1 },
    ]);
    const origPpid = process.ppid;
    Object.defineProperty(process, "ppid", { value: 200, writable: true });
    try {
      expect(findClaudePid(readStatus)).toBe(100);
    } finally {
      Object.defineProperty(process, "ppid", { value: origPpid, writable: true });
    }
  });

  it("returns null when no claude in ancestry", () => {
    const readStatus = mockProcTree([
      { pid: 200, name: "node", ppid: 100 },
      { pid: 100, name: "bash", ppid: 1 },
    ]);
    const origPpid = process.ppid;
    Object.defineProperty(process, "ppid", { value: 200, writable: true });
    try {
      expect(findClaudePid(readStatus)).toBeNull();
    } finally {
      Object.defineProperty(process, "ppid", { value: origPpid, writable: true });
    }
  });

  it("returns null when hitting PID 1", () => {
    const readStatus = mockProcTree([
      { pid: 200, name: "node", ppid: 1 },
    ]);
    const origPpid = process.ppid;
    Object.defineProperty(process, "ppid", { value: 200, writable: true });
    try {
      expect(findClaudePid(readStatus)).toBeNull();
    } finally {
      Object.defineProperty(process, "ppid", { value: origPpid, writable: true });
    }
  });

  it("returns null when readStatus throws", () => {
    const readStatus = () => { throw new Error("no such file"); };
    expect(findClaudePid(readStatus)).toBeNull();
  });
});

describe("discoverAgentId", () => {
  it("matches agent by claude_pid", () => {
    const tmpDir = makeTmpDir();
    try {
      const agentsDir = path.join(tmpDir, "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, "pid-12345@host.json"),
        JSON.stringify({ agent_id: "pid-12345@host", claude_pid: 100 }),
      );

      const readStatus = mockProcTree([
        { pid: 100, name: "claude", ppid: 1 },
      ]);
      const origPpid = process.ppid;
      Object.defineProperty(process, "ppid", { value: 100, writable: true });
      try {
        expect(discoverAgentId(tmpDir, readStatus)).toBe("pid-12345@host");
      } finally {
        Object.defineProperty(process, "ppid", { value: origPpid, writable: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when no agents match", () => {
    const tmpDir = makeTmpDir();
    try {
      const agentsDir = path.join(tmpDir, "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, "pid-99999@host.json"),
        JSON.stringify({ agent_id: "pid-99999@host", claude_pid: 999 }),
      );

      const readStatus = mockProcTree([
        { pid: 100, name: "claude", ppid: 1 },
      ]);
      const origPpid = process.ppid;
      Object.defineProperty(process, "ppid", { value: 100, writable: true });
      try {
        expect(discoverAgentId(tmpDir, readStatus)).toBeNull();
      } finally {
        Object.defineProperty(process, "ppid", { value: origPpid, writable: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when agents dir does not exist", () => {
    const readStatus = mockProcTree([
      { pid: 100, name: "claude", ppid: 1 },
    ]);
    const origPpid = process.ppid;
    Object.defineProperty(process, "ppid", { value: 100, writable: true });
    try {
      expect(discoverAgentId("/tmp/nonexistent-cm-dir", readStatus)).toBeNull();
    } finally {
      Object.defineProperty(process, "ppid", { value: origPpid, writable: true });
    }
  });

  it("skips malformed agent files", () => {
    const tmpDir = makeTmpDir();
    try {
      const agentsDir = path.join(tmpDir, "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, "bad.json"), "not json{{{");
      fs.writeFileSync(
        path.join(agentsDir, "good.json"),
        JSON.stringify({ agent_id: "pid-123@host", claude_pid: 100 }),
      );

      const readStatus = mockProcTree([
        { pid: 100, name: "claude", ppid: 1 },
      ]);
      const origPpid = process.ppid;
      Object.defineProperty(process, "ppid", { value: 100, writable: true });
      try {
        expect(discoverAgentId(tmpDir, readStatus)).toBe("pid-123@host");
      } finally {
        Object.defineProperty(process, "ppid", { value: origPpid, writable: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
