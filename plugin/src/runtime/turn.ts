/**
 * AgyTurnController — one agy turn shared across sequential pi requests.
 *
 * The provider hands recorded native cards to pi at model-response boundaries
 * (stopReason "toolUse"), or yields immediately for a real Pi bridge call.
 * Pi executes the display-only replay wrappers then re-invokes the provider, which
 * re-attaches to the same controller and keeps consuming buffered events
 * while the agy process continues running underneath.
 */

import type { AgyEffort } from "../driver/agy-client.ts";
import type { AgyActivity, AgyUsage } from "../driver/reducer.ts";
import { agyToolStepKey as toolStepKey } from "../driver/tool-steps.ts";
import type { NativeThinkingSnapshot } from "../native/native-thinking.ts";

type Waiter = (activity: AgyActivity | null, error: Error | undefined) => void;
type NativeToolStart = Extract<AgyActivity, { type: "tool_start" }>;
interface ThinkingBridge {
  serverName?: string;
  toolName?: string;
  stepId?: number;
  floor: number;
}

export class AgyTurnController {
  #prompt: string;
  /** Pi steers adopted by this live turn and not yet handed to agy. */
  #steers: string[] = [];
  /** Native effort fixed at turn creation, not Pi's later tool-loop selection. */
  readonly effectiveEffort: AgyEffort | undefined;
  #queue: AgyActivity[] = [];
  #waiters: Waiter[] = [];
  #closed = false;
  #failure: Error | undefined;
  #incompleteTools = new Map<string, Extract<AgyActivity, { type: "tool_start" }>>();
  #reportedUsage: AgyUsage;
  #thoughtReported = false;
  #emittedText = "";
  #terminalDelivered = false;
  #nativeConversationId: string | undefined;
  #thinking = new Map<string, { snapshot: NativeThinkingSnapshot; sealed: boolean }>();
  #nativeProgress = new Set<() => void>();
  #thinkingStep: number | undefined;
  #thinkingAfter = -1;
  #thinkingClosedThrough = -1;
  #thinkingMayStart = true;
  #thinkingBridges = new Map<string, ThinkingBridge>();
  #nativeMcpSteps = new Map<number, NativeToolStart>();

  constructor(prompt: string, conversationUsage: AgyUsage = {}, effectiveEffort?: AgyEffort) {
    this.#prompt = prompt;
    this.effectiveEffort = effectiveEffort;
    // agy's terminal result counters are cumulative across every resumed turn
    // in the conversation. Begin at the previous result so a result-only turn
    // claims only its new work instead of the whole conversation again.
    this.#reportedUsage = { ...conversationUsage };
  }

  /** The latest Pi user batch this turn answers: its tool-loop identity. */
  get prompt(): string {
    return this.#prompt;
  }

  /**
   * A Pi steer arrived while agy is still working on this turn. It becomes the
   * loop identity and waits for the next native input (the tool result agy is
   * waiting for, or a follow-up turn) instead of replacing the agy process.
   */
  adoptSteer(prompt: string): void {
    if (prompt === this.#prompt) return;
    this.#prompt = prompt;
    this.#steers.push(prompt);
  }

  /** Undelivered steer text, oldest first. */
  pendingSteer(): string | undefined {
    return this.#steers.length ? this.#steers.join("\n\n") : undefined;
  }

  /** Hand every pending steer to agy: returns the text and clears the queue. */
  takeSteer(): string | undefined {
    const text = this.pendingSteer();
    this.#steers = [];
    return text;
  }

  isClosed(): boolean {
    return this.#closed;
  }

  /** True once next() handed out the terminal result and it was not deferred back. */
  terminalDelivered(): boolean {
    return this.#terminalDelivered;
  }

  #markDelivered(activity: AgyActivity): void {
    if (activity.type === "result") this.#terminalDelivered = true;
  }

  /** True when unconsumed events are buffered (e.g. after the process exited). */
  hasPending(): boolean {
    return this.#queue.length > 0;
  }

  push(activity: AgyActivity): void {
    if (this.#closed) return;
    let delivered = activity;
    if (activity.type === "tool_start") {
      this.#incompleteTools.set(toolStepKey(activity), activity);
    } else if (activity.type === "tool_done" || activity.type === "tool_error") {
      const key = toolStepKey(activity);
      const started = this.#incompleteTools.get(key);
      if (started) delivered = { ...activity, args: { ...started.args, ...activity.args } };
      this.#incompleteTools.delete(key);
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter(delivered, undefined);
    else this.#queue.push(delivered);
  }

  /** Tool starts that never produced a DONE/ERROR event. */
  takeIncompleteTools(): Array<Extract<AgyActivity, { type: "tool_start" }>> {
    const tools = [...this.#incompleteTools.values()];
    this.#incompleteTools.clear();
    return tools;
  }

  /** Keep a response boundary pending while Pi delivers recorded tool results.
   * Unlike push(), this also works after the executor has closed the turn.
   */
  deferActivity(activity: AgyActivity): void {
    if (activity.type === "result") this.#terminalDelivered = false;
    this.#queue.unshift(activity);
  }

  /** Track rendered deltas across Pi messages, including closed text blocks. */
  recordEmittedText(delta: string): void {
    this.#emittedText += delta;
  }

  /** The terminal response normally concatenates the turn's streamed deltas.
   * On divergence, preserve already-rendered text rather than repeat/replace it.
   */
  remainingResponseText(response: string): string {
    return response.startsWith(this.#emittedText) ? response.slice(this.#emittedText.length) : "";
  }

  bindNativeConversation(conversationId: string): void {
    if (this.#nativeConversationId !== conversationId) {
      this.#thinkingStep = undefined;
      this.#thinkingAfter = this.#thinkingClosedThrough = -1;
      this.#thinkingMayStart = true;
      this.#thinkingBridges.clear();
      this.#nativeMcpSteps.clear();
    }
    this.#nativeConversationId = conversationId;
  }

  /** DB may run ahead of stdout: only one response can enter the display queue. */
  prepareNativeThinking(activity: AgyActivity): void {
    if (activity.type !== "response_start" && activity.type !== "response_end" &&
        activity.type !== "text" && activity.type !== "thought") return;
    const step = activity.stepId;
    if (step === undefined) return;
    // Direct runtime callers may lack MCP identity. Keep their bridge fence
    // until an old response ends, or a response beyond its known floor begins.
    for (const [id, bridge] of this.#thinkingBridges) {
      if (bridge.serverName !== undefined) continue;
      if (activity.type === "response_end" || (bridge.floor >= 0 && step > bridge.floor)) {
        this.#discardThinkingThrough(activity.type === "response_end" ? step : bridge.floor);
        this.#thinkingBridges.delete(id);
        this.#thinkingMayStart = true;
      }
    }
    if (this.#thinkingBridges.size) {
      if (activity.type === "response_end") this.#discardThinkingThrough(step);
      return;
    }
    if (step > this.#thinkingClosedThrough) {
      this.#thinkingStep = step;
      this.#thinkingMayStart = false;
    }
  }

  finishNativeThinkingResponse(step?: number): void {
    if (step === undefined) this.sealNativeThinking();
    else this.#discardThinkingThrough(step);
  }

  beginNativeThinkingTool(activity: NativeToolStart): void {
    const step = activity.stepId;
    this.sealNativeThinking(undefined, step);
    if (step !== undefined) {
      this.#discardThinkingThrough(step - 1);
      if (activity.name === "call_mcp_tool") {
        this.#nativeMcpSteps.set(step, activity);
        for (const bridge of this.#thinkingBridges.values()) {
          if (bridge.stepId === undefined && this.#matchesThinkingBridge(activity, bridge)) {
            bridge.stepId = step;
            this.#discardThinkingThrough(step);
            break;
          }
        }
      }
    }
    this.#thinkingMayStart = false;
  }

  /** Called AFTER queuing the tool result, never ahead of its replay card. */
  finishNativeThinkingTool(step?: number): void {
    if (step !== undefined) {
      this.#discardThinkingThrough(step);
      this.#nativeMcpSteps.delete(step);
      for (const [id, bridge] of this.#thinkingBridges) if (bridge.stepId === step) this.#thinkingBridges.delete(id);
    }
    this.#thinkingAfter = Math.max(this.#thinkingClosedThrough, this.#thinkingStep ?? -1);
    this.#thinkingStep = undefined;
    this.#thinkingMayStart = true;
  }

  beginNativeThinkingBridge(id: string, serverName?: string, toolName?: string): void {
    const floor = Math.max(this.#thinkingClosedThrough, this.#thinkingStep ?? -1);
    this.#discardThinkingThrough(floor);
    const bridge: ThinkingBridge = { serverName, toolName, floor };
    for (const [step, activity] of this.#nativeMcpSteps) {
      if ([...this.#thinkingBridges.values()].some(other => other.stepId === step)) continue;
      if (this.#matchesThinkingBridge(activity, bridge)) {
        bridge.stepId = step;
        this.#discardThinkingThrough(step);
        break;
      }
    }
    this.#thinkingBridges.set(id, bridge);
    this.#thinkingMayStart = false;
  }

  #matchesThinkingBridge(activity: NativeToolStart, bridge: ThinkingBridge): boolean {
    return (bridge.serverName === undefined || activity.args.ServerName === bridge.serverName) &&
      (bridge.toolName === undefined || activity.args.ToolName === bridge.toolName);
  }

  #discardThinkingThrough(step: number): void {
    this.#thinkingClosedThrough = Math.max(this.#thinkingClosedThrough, step);
    for (const [key, entry] of this.#thinking) {
      if (entry.snapshot.conversationId === this.#nativeConversationId && entry.snapshot.stepId <= step) this.#sealThinking(key);
    }
    if (this.#thinkingStep !== undefined && this.#thinkingStep <= step) this.#thinkingStep = undefined;
  }

  thinkingKey(stepId: number): string {
    return `${this.#nativeConversationId ?? "unbound"}:${stepId}`;
  }

  /** One owner for deduplication across polls, retries and Pi tool re-entry. */
  acceptNativeThinking(snapshot: NativeThinkingSnapshot): boolean {
    if (this.#closed || snapshot.stepId <= this.#thinkingClosedThrough) return true;
    const key = `${snapshot.conversationId}:${snapshot.stepId}`;
    const previous = this.#thinking.get(key);
    if (previous?.sealed) return true;
    if (this.#thinkingBridges.size) return false;
    if (snapshot.stepId !== this.#thinkingStep) {
      if (!this.#thinkingMayStart || snapshot.stepId <= this.#thinkingAfter) return false;
      this.#thinkingStep = snapshot.stepId;
      this.#thinkingMayStart = false;
    }
    const changed = snapshot.text !== previous?.snapshot.text;
    const entry = { snapshot, sealed: false };
    this.#thinking.set(key, entry);
    if (changed && (snapshot.text || previous?.snapshot.text)) {
      this.push({ type: "native_thinking_snapshot", ...snapshot });
      if (snapshot.text) for (const listener of this.#nativeProgress) listener();
    }
    if ([3, 4, 5, 6, 7, 12].includes(snapshot.status)) this.#sealThinking(key);
    return entry.sealed;
  }

  /** Close known thinking before a native tool, bridge call or terminal result. */
  sealNativeThinking(stepId?: number, beforeStep?: number): void {
    if (stepId !== undefined && this.#nativeConversationId) {
      const key = this.thinkingKey(stepId);
      if (!this.#thinking.has(key)) this.#thinking.set(key, {
        snapshot: { conversationId: this.#nativeConversationId, stepId, text: "", status: 3 }, sealed: false,
      });
      this.#sealThinking(key);
      return;
    }
    for (const [key, entry] of this.#thinking) {
      if (beforeStep === undefined || entry.snapshot.stepId < beforeStep) this.#sealThinking(key);
    }
  }

  #sealThinking(key: string): void {
    const entry = this.#thinking.get(key);
    if (!entry || entry.sealed) return;
    entry.sealed = true;
    const { conversationId, stepId, text } = entry.snapshot;
    this.push({ type: "native_thinking_end", conversationId, stepId, text });
  }

  subscribeNativeProgress(listener: () => void): () => void {
    this.#nativeProgress.add(listener);
    return () => { this.#nativeProgress.delete(listener); };
  }

  /** Cancellation drains only display work before the next unexecuted tool. */
  takePendingThinking(): AgyActivity[] {
    const thinking: AgyActivity[] = [];
    const remaining: AgyActivity[] = [];
    let beforeTool = true;
    for (const activity of this.#queue) {
      if (activity.type === "tool_start" || activity.type === "bridge_call") beforeTool = false;
      if (beforeTool && (activity.type === "native_thinking_snapshot" || activity.type === "native_thinking_end")) {
        thinking.push(activity);
      } else remaining.push(activity);
    }
    this.#queue = remaining;
    return thinking;
  }

  /** At most one count-only fallback; never duplicate actual public thinking. */
  claimThought(): boolean {
    if (this.#thoughtReported || [...this.#thinking.values()].some(entry => entry.snapshot.text)) return false;
    this.#thoughtReported = true;
    return true;
  }

  /**
   * Attribute usage exactly once across the several pi messages that make up
   * one agy turn. Step usage is per response; the result usage is cumulative
   * across the resumed agy conversation.
   */
  claimUsage(usage: AgyUsage | undefined, final: boolean): AgyUsage | undefined {
    if (!usage) return undefined;
    if (final) {
      const claimed = subtractUsage(usage, this.#reportedUsage);
      // The result is the authoritative conversation total. Assign it rather
      // than adding the delta so counter resets after agy's own compaction heal.
      this.#reportedUsage = { ...usage };
      return claimed;
    }
    this.#reportedUsage = addUsage(this.#reportedUsage, usage);
    return { ...usage };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#nativeProgress.clear();
    this.#thinkingBridges.clear();
    this.#nativeMcpSteps.clear();
    for (const waiter of this.#waiters.splice(0)) waiter(null, undefined);
  }

  fail(error: Error): void {
    if (this.#closed) return;
    this.#failure = error;
    this.#nativeProgress.clear();
    this.#thinkingBridges.clear();
    this.#nativeMcpSteps.clear();
    for (const waiter of this.#waiters.splice(0)) waiter(null, error);
    this.#closed = true;
  }

  /**
   * Resolve the next activity, waiting for one when the queue is empty.
   * Returns null when the turn ended; rejects when the turn failed.
   */
  next(): Promise<AgyActivity | null> {
    return new Promise<AgyActivity | null>((resolve, reject) => {
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        this.#markDelivered(queued);
        resolve(queued);
        return;
      }
      if (this.#failure) {
        reject(this.#failure);
        return;
      }
      if (this.#closed) {
        resolve(null);
        return;
      }
      this.#waiters.push((activity, error) => {
        if (error) reject(error);
        else if (activity) {
          this.#markDelivered(activity);
          resolve(activity);
        }
        else resolve(null);
      });
    });
  }
}

const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "thinking_tokens",
  "cache_read_tokens",
  "total_tokens",
] as const;

function addUsage(left: AgyUsage, right: AgyUsage): AgyUsage {
  const out: AgyUsage = {};
  for (const key of USAGE_KEYS) {
    const value = (left[key] ?? 0) + (right[key] ?? 0);
    if (value > 0 || left[key] !== undefined || right[key] !== undefined) out[key] = value;
  }
  return out;
}

function subtractUsage(total: AgyUsage, reported: AgyUsage): AgyUsage {
  const out: AgyUsage = {};
  for (const key of USAGE_KEYS) {
    if (total[key] === undefined) continue;
    const previous = reported[key] ?? 0;
    // agy can reset counters when it compacts internally. In that case the
    // current value is all new usage rather than a negative delta.
    out[key] = total[key] < previous ? total[key] : total[key] - previous;
  }
  return out;
}
