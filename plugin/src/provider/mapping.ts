/** Pure mappings between agy events and Pi messages; no stream or runtime state. */

import { createHash } from "node:crypto";
import type { AssistantMessage, JsonObject, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgyEffort } from "../driver/agy-client.ts";
import type { AgyActivity, AgyUsage } from "../driver/reducer.ts";

const OVERFLOW_PATTERN = /context (length|window|size).*(exceed|limit)|exceeds.*context/i;

/** Map agy usage fields to pi usage fields. */
export function mapUsage(u: AgyUsage | undefined): AssistantMessage["usage"] {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    // agy never streams thought text (print mode exposes counts only);
    // report thinking_tokens as the reasoning subset of output regardless.
    reasoning: u?.thinking_tokens,
    cacheRead: u?.cache_read_tokens ?? 0,
    cacheWrite: 0,
    // AGY total_tokens excludes cached input; Pi's total includes it.
    // thinking_tokens is already a subset of output, not an extra component.
    totalTokens: (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_read_tokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * pi's compaction and branch summarization arrive as standalone requests
 * whose only user message is `<conversation>\n…</conversation>\n\n` plus
 * instructions. They run in disposable agy conversations so internal summary
 * prompts never become fake user input in the real conversation. Their cached
 * transcript re-reads also produce fictional per-token costs (agy is
 * subscription-billed), so these requests report no usage.
 */
export function isSummarizationRequest(prompt: string): boolean {
  return prompt.startsWith("<conversation>\n");
}

/** Map an explicit pi thinking level to agy's `--effort` (low|medium|high). */
export function mapThinkingToEffort(level: ThinkingLevel | undefined): AgyEffort | undefined {
  if (level === undefined) return undefined;
  if (level === "low" || level === "minimal") return "low";
  if (level === "medium") return "medium";
  return "high"; // high, xhigh, and max
}

/** Hash of the Pi system snapshot, insensitive to line endings and trailing blanks. */
export function hashSystemPrompt(systemPrompt: string): string {
  return createHash("sha256")
    .update(systemPrompt.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, ""))
    .digest("hex");
}

/**
 * agy step and bridge arguments arrive as parsed stream-json / JSON-RPC, so
 * every value is already JSON. This is the single place that states so.
 */
export function toJsonObject(args: Record<string, unknown>): JsonObject {
  return args as JsonObject;
}

/**
 * True for agy `call_mcp_tool` steps that target our own bridge server.
 * Those calls surface as synthetic bridge_call activities (emitted as the
 * real pi tool), so the raw call_mcp_tool step must not render a duplicate
 * display-only card. MCP calls against OTHER servers render normally.
 */
export function isBridgedMcpStep(activity: { name: string; args: Record<string, unknown> }, serverName: string): boolean {
  return activity.name === "call_mcp_tool" && activity.args?.ServerName === serverName;
}

/**
 * agy's interactive TUI collapses hidden reasoning into one line ("Thought
 * for 3s, 289 tokens"). The step duration covers thinking plus writing — the
 * closest signal agy exposes to its own thought timer.
 */
export function thoughtSummary(activity: Extract<AgyActivity, { type: "thought" }>): string {
  const seconds =
    activity.durationSeconds === undefined ? undefined : Math.max(1, Math.round(activity.durationSeconds));
  return seconds === undefined
    ? `Thought ${activity.tokens} tokens`
    : `Thought for ${seconds}s, ${activity.tokens} tokens`;
}

/** Explain a runtime stall/retry instead of a silent multi-minute spinner. */
export function stallSummary(activity: Extract<AgyActivity, { type: "stall" }>): string {
  const seconds = Math.max(1, Math.round(activity.stalledMs / 1000));
  return (
    `agy stream stalled for ${seconds}s with no events` +
    `${activity.toolActive ? " while a tool step was active" : ""}` +
    ` — restarting the turn (retry ${activity.retry} of ${activity.maxRetries})`
  );
}

export function withPermissionHint(message: string): string {
  const hint = message.includes("permission check failed for command")
    ? " — add an allow-rule (e.g. command(*)) to permissions.allow in ~/.gemini/antigravity-cli/settings.json for autonomous agy turns"
    : "";
  return `${message}${hint}`;
}

/** Terminal CLI error, tagged so Pi recognizes a context overflow. */
export function terminalErrorMessage(error: string | undefined): string {
  const message = error || "agy reported an error for this turn.";
  return OVERFLOW_PATTERN.test(message) ? `context_length_exceeded: ${message}` : message;
}
