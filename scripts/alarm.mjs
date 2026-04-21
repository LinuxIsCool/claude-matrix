#!/usr/bin/env node

/**
 * claude-matrix alarm daemon — LEGACY (superseded by backlog 223 Phase 0)
 *
 * Superseded 2026-04-20 by the `claude-legion-dialog` MCP plugin. Drivers now
 * launch WITH `--dangerously-load-development-channels` (restoring KAIROS
 * channel push) and use `mcp__plugin_claude-dialog_ui__ask`
 * for interactive dialogs. The channels flag disables the native
 * `AskUserQuestion` via `isEnabled()`, but MCP tools bypass that gate
 * (validated by Spike R1, 2026-04-20 20:00 PDT).
 *
 * This file and its systemd unit are retained as the rollback path: if the
 * Phase 0 architecture regresses, re-enable with:
 *
 *   systemctl --user enable --now claude-matrix-alarm.service
 *
 * and restore the `CLAUDEMATRIX_DRIVER=1 claude --agent <persona>` launch
 * template. Do not start this service for normal use.
 *
 * See ~/.claude/local/backlog/driver-orchestrator-architecture.md (id 223)
 * and ~/.claude/plans/2026-04-20-driver-v2-phase-0.md for full context.
 *
 * --- original header below ---
 *
 * Watches ~/.claude/local/claudematrix/notifications/ for writes. On event,
 * resolves the recipient agent's tmux pane via the panes/<agent-id>.json
 * registry and pokes the pane with `tmux send-keys Enter`. This replicates
 * the KAIROS channels auto-trigger without requiring the
 * `--dangerously-load-development-channels` flag — so the driver persona
 * retains AskUserQuestion.
 *
 * Scope:
 *   - Single-host local IPC (matches claude-matrix Phase 1 transport)
 *   - One poke per agent per debounce window (default 2s)
 *   - Stateless registry reads on every event
 *   - Token-bucket runaway guard: PAUSE_THRESHOLD pokes / PAUSE_WINDOW_MS
 *     triggers PAUSE_DURATION_MS per-agent cooldown
 *
 * Out of scope:
 *   - Content pre-fetch (hook reads notification file itself)   — P6
 *   - Cross-host / federation                                   — P7
 *
 * Env:
 *   CLAUDEMATRIX_DATA_DIR      override data root
 *   ALARM_DEBOUNCE_MS          per-agent debounce (default 2000)
 *   ALARM_PAUSE_THRESHOLD      pokes before runaway pause (default 20)
 *   ALARM_PAUSE_WINDOW_MS      sliding window for threshold (default 60000)
 *   ALARM_PAUSE_DURATION_MS    cooldown duration (default 300000)
 *   ALARM_LOG                  log file path
 */

import { watch, readFileSync, existsSync, appendFileSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const DATA_DIR =
  process.env.CLAUDEMATRIX_DATA_DIR ||
  join(homedir(), ".claude", "local", "claudematrix");
const NOTIF_DIR = join(DATA_DIR, "notifications");
const PANES_DIR = join(DATA_DIR, "panes");
const LOG_FILE = process.env.ALARM_LOG || join(DATA_DIR, "alarm.log");

const DEBOUNCE_MS = parseInt(process.env.ALARM_DEBOUNCE_MS || "2000", 10);
const PAUSE_THRESHOLD = parseInt(process.env.ALARM_PAUSE_THRESHOLD || "20", 10);
const PAUSE_WINDOW_MS = parseInt(process.env.ALARM_PAUSE_WINDOW_MS || "60000", 10);
const PAUSE_DURATION_MS = parseInt(process.env.ALARM_PAUSE_DURATION_MS || "300000", 10);

// agent-id grammar matches claude-matrix: word chars, dash, dot, @.
// (Colon excluded to prevent tmux target-string injection via filename.)
const AGENT_ID_RE = /^[\w\-.@]+$/;
const PANE_TARGET_RE = /^[\w\-.]+:[\w\-.]+(\.\d+)?$/;

// Per-agent debounce state: agent-id → last poke epoch ms.
const lastPoke = new Map();
// Per-agent poke history for runaway detection: agent-id → [epochMs].
const pokeHistory = new Map();
// Per-agent pause state: agent-id → until epoch ms.
const pausedUntil = new Map();

function log(line) {
  const ts = new Date().toISOString();
  try {
    appendFileSync(LOG_FILE, `${ts} ${line}\n`);
  } catch {
    // Non-fatal — stderr still captures via systemd.
  }
  process.stderr.write(`[alarm] ${line}\n`);
}

/**
 * Derive agent-id from a notification filename. Invalid → null.
 */
function agentIdFromFilename(fname) {
  if (!fname || !fname.endsWith(".json")) return null;
  const id = fname.slice(0, -5);
  if (!AGENT_ID_RE.test(id)) return null;
  return id;
}

/**
 * Read pane registry for an agent. Returns target or null.
 * Deletes the registry entry if pane format is invalid.
 */
function resolvePane(agentId) {
  const regPath = join(PANES_DIR, `${agentId}.json`);
  if (!existsSync(regPath)) return null;
  try {
    const reg = JSON.parse(readFileSync(regPath, "utf8"));
    if (typeof reg.pane !== "string" || !PANE_TARGET_RE.test(reg.pane)) {
      log(`cleanup-invalid-registry agent=${agentId} pane=${reg.pane}`);
      try { unlinkSync(regPath); } catch {}
      return null;
    }
    return reg.pane;
  } catch (err) {
    log(`registry-read-error agent=${agentId} err=${err.message}`);
    return null;
  }
}

/**
 * Verify the tmux pane still exists. Returns true if alive.
 */
function paneAlive(target) {
  const session = target.split(":")[0];
  const r = spawnSync("tmux", ["has-session", "-t", session], {
    stdio: "ignore",
  });
  if (r.status !== 0) return false;
  const list = spawnSync("tmux", ["list-panes", "-t", target, "-F", "ok"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  return list.status === 0 && list.stdout.toString().includes("ok");
}

/**
 * Delete a stale registry entry (pane no longer exists).
 */
function cleanupRegistry(agentId, reason) {
  const regPath = join(PANES_DIR, `${agentId}.json`);
  try {
    unlinkSync(regPath);
    log(`cleanup-stale-registry agent=${agentId} reason=${reason}`);
  } catch {
    // Already gone
  }
}

/**
 * Poke the tmux pane with a minimal prompt (`.`) + Enter. Claude's REPL
 * treats whitespace-only input as a no-op — a visible character is needed
 * to trigger UserPromptSubmit (which fires the claude-matrix hook). `.` is
 * the minimum-noise sentinel; future v2 may swap for a hook-stripped
 * sentinel like `[matrix-poke]`.
 */
function pokePane(target) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync("tmux", ["send-keys", "-t", target, ".", "Enter"], {
    stdio: "ignore",
  });
  const t1 = process.hrtime.bigint();
  return { ok: r.status === 0, ms: Number((t1 - t0) / 1_000_000n) };
}

/**
 * Record poke in history + check for runaway (threshold/window breach).
 * Returns true if agent should be paused.
 */
function recordPokeAndCheckRunaway(agentId, now) {
  const hist = pokeHistory.get(agentId) || [];
  // Drop entries outside window
  const cutoff = now - PAUSE_WINDOW_MS;
  const pruned = hist.filter((t) => t >= cutoff);
  pruned.push(now);
  pokeHistory.set(agentId, pruned);
  return pruned.length > PAUSE_THRESHOLD;
}

/**
 * Handle a single inotify event. Debounce, resolve, validate, poke.
 */
function handleEvent(eventType, fname) {
  const agentId = agentIdFromFilename(fname);
  if (!agentId) return;

  const now = Date.now();

  // Paused? Drop.
  const pausedUnt = pausedUntil.get(agentId) || 0;
  if (now < pausedUnt) {
    // Log once on first rejection per pause period would be quieter, but
    // we accept the verbosity for observability.
    log(`skip-paused agent=${agentId} for_ms=${pausedUnt - now}`);
    return;
  }

  // Debounce
  const last = lastPoke.get(agentId) || 0;
  if (now - last < DEBOUNCE_MS) {
    log(`skip-debounce agent=${agentId} since_ms=${now - last}`);
    return;
  }

  const pane = resolvePane(agentId);
  if (!pane) return; // No registry = not a driver; silent skip.

  if (!paneAlive(pane)) {
    cleanupRegistry(agentId, "pane-not-found");
    return;
  }

  const { ok, ms } = pokePane(pane);
  lastPoke.set(agentId, now);

  if (recordPokeAndCheckRunaway(agentId, now)) {
    const until = now + PAUSE_DURATION_MS;
    pausedUntil.set(agentId, until);
    pokeHistory.delete(agentId);
    log(`runaway-pause agent=${agentId} until_ms=${until} threshold=${PAUSE_THRESHOLD} window_ms=${PAUSE_WINDOW_MS}`);
  }

  log(`poke agent=${agentId} pane=${pane} event=${eventType} ok=${ok} ms=${ms}`);
}

function main() {
  mkdirSync(NOTIF_DIR, { recursive: true });
  mkdirSync(PANES_DIR, { recursive: true });
  // Tighten panes dir perms (registry contains pid + session_id)
  try { chmodSync(PANES_DIR, 0o700); } catch {}

  log(
    `starting data_dir=${DATA_DIR} debounce_ms=${DEBOUNCE_MS} ` +
    `pause=${PAUSE_THRESHOLD}/${PAUSE_WINDOW_MS}ms→${PAUSE_DURATION_MS}ms`
  );

  const watcher = watch(NOTIF_DIR, { persistent: true }, (eventType, fname) => {
    if (!fname) return;
    try {
      handleEvent(eventType, fname);
    } catch (err) {
      log(`handler-error fname=${fname} err=${err.message}`);
    }
  });

  const shutdown = (sig) => {
    log(`shutdown sig=${sig}`);
    watcher.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
