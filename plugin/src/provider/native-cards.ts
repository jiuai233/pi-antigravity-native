/**
 * Display-only cards for agy's own tool steps.
 *
 * agy already executed these steps; Pi runs only the `antigravity` replay
 * wrapper, which returns the recorded result. Cards open on ACTIVE (so a
 * long `run_command` shows as pending), close on DONE/ERROR, and are flushed
 * as errors when a turn ends with steps still ACTIVE. If Pi's tool allowlist
 * excludes the wrapper, the step renders as labeled replay-only text.
 */

import type { JsonObject } from "@earendil-works/pi-ai";
import type { AgyActivity } from "../driver/reducer.ts";
import { agyToolStepKey } from "../driver/tool-steps.ts";
import type { BridgeContent } from "../extension/bridge.ts";
import { agyIncompleteToolError, BRIDGE_PENDING_TOOL_MESSAGE, WRAPPER_TOOL_NAME } from "../input/prompt.ts";
import { toJsonObject } from "./mapping.ts";
import type { AssistantMessageWriter } from "./message-writer.ts";
import type { AgyReplayStore } from "./replay.ts";

type ToolStart = Extract<AgyActivity, { type: "tool_start" }>;
type ToolEnd = Extract<AgyActivity, { type: "tool_done" | "tool_error" }>;
type ReplayToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: { tool: string; input: JsonObject };
};
type PendingCard = { id: string; index: number; toolCall: ReplayToolCall };

// Replay ids must stay unique across turns: the replay store is keyed by them.
let replayCallSeq = 0;

function replayToolCall(id: string, activity: { name: string; args: Record<string, unknown> }): ReplayToolCall {
  return {
    type: "toolCall",
    id,
    name: WRAPPER_TOOL_NAME,
    arguments: { tool: activity.name, input: toJsonObject(activity.args) },
  };
}

export class NativeToolCards {
  readonly #writer: AssistantMessageWriter;
  readonly #replay: AgyReplayStore;
  readonly #isActiveTool: (name: string) => boolean;
  readonly #pending = new Map<string, PendingCard>();

  constructor(writer: AssistantMessageWriter, replay: AgyReplayStore, isActiveTool: (name: string) => boolean) {
    this.#writer = writer;
    this.#replay = replay;
    this.#isActiveTool = isActiveTool;
  }

  /**
   * Open a pending card as soon as agy reports ACTIVE. Native read-only calls
   * still wait for DONE because a failed agy read must replay its error.
   */
  start(activity: ToolStart): void {
    this.#writer.closeText();
    const key = agyToolStepKey(activity);
    if (this.#pending.has(key)) return;
    if (!this.#isActiveTool(WRAPPER_TOOL_NAME)) return;
    const id = `agy-replay-${++replayCallSeq}`;
    const toolCall = replayToolCall(id, activity);
    const index = this.#writer.openToolCall(toolCall);
    this.#pending.set(key, { id, index, toolCall });
  }

  /** Close the step's card with its recorded result, or render replay text. */
  finish(activity: ToolEnd, content: BridgeContent[] | undefined): void {
    this.#writer.closeText();
    const key = agyToolStepKey(activity);
    const pending = this.#pending.get(key);
    if (pending) {
      pending.toolCall.arguments = { tool: activity.name, input: toJsonObject(activity.args) };
      this.#record(pending.id, activity, content);
      this.#writer.closeToolCall(pending.index, pending.toolCall);
      this.#pending.delete(key);
      return;
    }
    if (!this.#isActiveTool(WRAPPER_TOOL_NAME)) {
      this.replayText(activity);
      return;
    }
    const id = `agy-replay-${++replayCallSeq}`;
    const toolCall = replayToolCall(id, activity);
    this.#record(id, activity, content);
    const index = this.#writer.openToolCall(toolCall);
    this.#writer.closeToolCall(index, toolCall);
  }

  /** Steps still ACTIVE at a terminal event replay as errors; returns cards emitted. */
  emitIncomplete(incomplete: readonly ToolStart[], resultError?: string): number {
    let emittedCalls = 0;
    for (const activity of incomplete) {
      const key = agyToolStepKey(activity);
      const pending = this.#pending.get(key);
      const error = agyIncompleteToolError(activity.name, resultError);
      if (!pending && !this.#isActiveTool(WRAPPER_TOOL_NAME)) {
        this.replayText({ ...activity, type: "tool_error", message: error });
        continue;
      }
      emittedCalls++;
      const id = pending?.id ?? `agy-replay-${++replayCallSeq}`;
      this.#replay.record(id, { agyTool: activity.name, error });
      const toolCall = pending?.toolCall ?? replayToolCall(id, activity);
      toolCall.arguments = { tool: activity.name, input: toJsonObject(activity.args) };
      const index = pending ? pending.index : this.#writer.openToolCall(toolCall);
      this.#writer.closeToolCall(index, toolCall);
      this.#pending.delete(key);
    }
    return emittedCalls;
  }

  /**
   * A bridged pi tool must execute immediately or agy blocks waiting for its
   * result. Close still-ACTIVE cards as "running" before yielding to pi; the
   * eventual terminal event renders a separate completion card.
   */
  closePendingForBridge(): void {
    for (const [key, pending] of this.#pending) {
      this.#replay.record(pending.id, { agyTool: pending.toolCall.arguments.tool, output: BRIDGE_PENDING_TOOL_MESSAGE });
      this.#writer.closeToolCall(pending.index, pending.toolCall);
      this.#pending.delete(key);
    }
  }

  /**
   * --tools can remove the display-only wrapper from Pi's registry. Keep
   * already-executed native steps in the transcript without asking Pi to
   * execute an unavailable tool or widening its active tool set.
   */
  replayText(activity: ToolEnd): void {
    const body = activity.type === "tool_error" ? `Native tool failed: ${activity.message}` : activity.output || "(no output)";
    const text =
      `[AGY replay only: ${activity.name}; no Pi tool executed]\n` +
      (activity.name === "view_file" ? body : body.slice(0, 16_000));
    this.#writer.appendTextBlock(text);
  }

  #record(id: string, activity: ToolEnd, content: BridgeContent[] | undefined): void {
    this.#replay.record(
      id,
      activity.type === "tool_error"
        ? { agyTool: activity.name, error: activity.message }
        : { agyTool: activity.name, output: activity.output, content, durationSeconds: activity.durationSeconds },
    );
  }
}
