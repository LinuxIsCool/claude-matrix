import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPTS_DIR = path.resolve(import.meta.dirname, "..");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cm-hook-test-"));
}

/**
 * Run a hook script with given stdin JSON and env vars.
 * Returns { stdout, stderr, exitCode }.
 */
function runHook(scriptName, stdinData, env = {}) {
  return new Promise((resolve) => {
    // Use a clean env to avoid inheriting session vars from the current Claude session
    const cleanEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH,
      ...env,
    };
    const proc = spawn("node", [path.join(SCRIPTS_DIR, scriptName)], {
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });

    if (stdinData !== null) {
      proc.stdin.write(JSON.stringify(stdinData));
    }
    proc.stdin.end();
  });
}

describe("on-session-start.js", () => {
  let tmpDir;
  let envFile;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    envFile = path.join(tmpDir, "env");
    fs.writeFileSync(envFile, "");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("outputs context JSON with agent identity", async () => {
    const result = await runHook("on-session-start.js", {
      session_id: "abc12345-0000-0000-0000-000000000000",
    }, {
      CLAUDEMATRIX_DATA_DIR: tmpDir,
      CLAUDE_ENV_FILE: envFile,
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput.additionalContext).toContain("You are agent:");
  });

  it("persists session ID and agent ID to env file", async () => {
    await runHook("on-session-start.js", {
      session_id: "abc12345-0000-0000-0000-000000000000",
    }, {
      CLAUDEMATRIX_DATA_DIR: tmpDir,
      CLAUDE_ENV_FILE: envFile,
    });

    const envContent = fs.readFileSync(envFile, "utf8");
    expect(envContent).toContain("CLAUDEMATRIX_SESSION_ID='abc12345-0000-0000-0000-000000000000'");
    expect(envContent).toContain("CLAUDEMATRIX_AGENT_ID=");
  });

  it("exits 0 on invalid session_id", async () => {
    const result = await runHook("on-session-start.js", {
      session_id: "not-valid!!!",
    }, { CLAUDEMATRIX_DATA_DIR: tmpDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 on missing stdin", async () => {
    const result = await runHook("on-session-start.js", null, {
      CLAUDEMATRIX_DATA_DIR: tmpDir,
    });

    expect(result.exitCode).toBe(0);
  });
});

describe("on-prompt-submit.js", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("outputs unread summary when notifications exist", async () => {
    const agentId = `session-abc12345@${os.hostname()}`;
    const notifDir = path.join(tmpDir, "notifications");
    fs.mkdirSync(notifDir, { recursive: true });
    fs.writeFileSync(
      path.join(notifDir, `${agentId}.json`),
      JSON.stringify({
        generated_at: Date.now(),
        agent_id: agentId,
        unread_count: 2,
        summaries: [
          {
            from_agent: "other@host",
            from_display: "other",
            from_project_dir: "/project-b",
            preview: "Hello!",
            received_at: Date.now(),
            event_id: "uuid-1",
          },
        ],
      }),
    );

    const result = await runHook("on-prompt-submit.js", {}, {
      CLAUDEMATRIX_DATA_DIR: tmpDir,
      CLAUDEMATRIX_AGENT_ID: agentId,
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain("2 unread");
    expect(output.hookSpecificOutput.additionalContext).toContain("Hello!");
  });

  it("exits 0 silently when no notifications", async () => {
    const result = await runHook("on-prompt-submit.js", {}, {
      CLAUDEMATRIX_DATA_DIR: tmpDir,
      CLAUDEMATRIX_AGENT_ID: `session-abc12345@${os.hostname()}`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when no agent ID available", async () => {
    const result = await runHook("on-prompt-submit.js", {}, {
      CLAUDEMATRIX_DATA_DIR: tmpDir,
      // No CLAUDEMATRIX_AGENT_ID, no CLAUDEMATRIX_SESSION_ID
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("on-session-end.js", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleans up agent file, notification file, and inbox", async () => {
    const agentId = `session-abc12345@${os.hostname()}`;

    // Create artifacts
    const agentFile = path.join(tmpDir, "agents", `${agentId}.json`);
    const notifFile = path.join(tmpDir, "notifications", `${agentId}.json`);
    const inboxDir = path.join(tmpDir, "messages", agentId);
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.mkdirSync(path.dirname(notifFile), { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(agentFile, "{}");
    fs.writeFileSync(notifFile, "{}");
    fs.writeFileSync(path.join(inboxDir, "msg1.json"), "{}");

    const result = await runHook("on-session-end.js", "", {
      CLAUDEMATRIX_DATA_DIR: tmpDir,
      CLAUDEMATRIX_AGENT_ID: agentId,
    });

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(agentFile)).toBe(false);
    expect(fs.existsSync(notifFile)).toBe(false);
    expect(fs.existsSync(inboxDir)).toBe(false);
  });

  it("exits 0 when no agent ID available", async () => {
    const result = await runHook("on-session-end.js", "", {
      CLAUDEMATRIX_DATA_DIR: tmpDir,
      // No agent ID env vars
    });

    expect(result.exitCode).toBe(0);
  });
});
