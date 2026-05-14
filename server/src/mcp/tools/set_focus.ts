import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRegistry } from "../../core/AgentRegistry.js";
import type { AgentFocus } from "../../types/agent.js";

/**
 * MCP tool: set_focus
 *
 * Sets the live focus task for THIS agent. Persisted to disk via the
 * transport's `updateAgentFocus`. Read-merge-write — other fields
 * (persona, heartbeat, etc.) are preserved.
 *
 * Phase 1 of task-490 (Live Focus & Attention Graph). Backlog ID 490.
 *
 * Argument shape (Zod raw shape per matrix doctrine):
 *   - task_id: integer or "task-NNN" string. Normalized to integer
 *     internally. Required.
 *   - source: 4-tier confidence enum from task-490 §17.
 *     Default: "explicit" (this tool's call site is always operator-
 *     or-agent intent, never inference).
 *   - confidence: optional 0..1 scalar. Helpful when set_focus is
 *     called from an inference pipeline that wants to be honest
 *     about its uncertainty. Defaults derived from `source` when
 *     absent (1.0 / 0.7 / 0.4 / 0.1).
 */
export function registerSetFocus(
  server: McpServer,
  registry: AgentRegistry,
  selfAgentId: string,
): void {
  server.registerTool(
    "set_focus",
    {
      title: "Set Focus",
      description:
        "Mark this agent as actively working on a specific backlog task. " +
        "The focus appears in list_agents output and powers UIs that " +
        "render 'what is everyone working on'. Pass task_id as integer " +
        "or 'task-NNN' string. Call /focus from a slash command for " +
        "interactive use.",
      inputSchema: {
        task_id: z
          .union([
            z.number().int().positive(),
            z.string().regex(/^task-\d+$/i, "Must be 'task-NNN' format"),
          ])
          .describe(
            "Backlog task ID to focus on. Accepts bare integer (e.g. 490) " +
            "or 'task-490' string form. Both normalize to integer internally.",
          ),
        source: z
          .enum(["explicit", "inferred-strong", "inferred-weak", "stale"])
          .default("explicit")
          .describe(
            "Source confidence tier. Default 'explicit' — change only " +
            "when calling from an inference pipeline.",
          ),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Optional 0..1 scalar. Defaults from source tier: " +
            "explicit=1.0, inferred-strong=0.7, inferred-weak=0.4, stale=0.1.",
          ),
      },
    },
    async ({ task_id, source, confidence }) => {
      try {
        // Normalize task_id to integer for canonical storage
        const taskIdInt = typeof task_id === "number"
          ? task_id
          : parseInt(task_id.replace(/^task-/i, ""), 10);

        const focus: AgentFocus = {
          task_id: taskIdInt,
          source: source ?? "explicit",
          started_at: Date.now(),
          ...(confidence !== undefined ? { confidence } : {}),
        };

        await registry.setFocus(focus);

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Focus set: task-${taskIdInt} (source: ${focus.source})` +
                (confidence !== undefined ? ` (confidence: ${confidence})` : ""),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to set focus: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
