/** Standard Pi message blocks; announced indices never move. */
import type { AssistantMessage, AssistantMessageEventStream, ToolCall } from "@earendil-works/pi-ai";

interface ThoughtSlot {
  index: number;
  target: string;
  shown: string;
  arrivalAt: number;
  rate: number;
  closed: boolean;
}

const THINKING_TICK_MS = 40;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function prefix(text: string, count: number): string {
  let value = "";
  for (const { segment } of graphemes.segment(text)) {
    value += segment;
    if (--count <= 0) break;
  }
  return value;
}

export class AssistantMessageWriter {
  readonly output: AssistantMessage;
  readonly #stream: AssistantMessageEventStream;
  #textIndex: number | null = null;
  #textBuffer = "";
  #textKey: string | undefined;
  #legacyThought: ThoughtSlot | undefined;
  #nativeThoughts = new Map<string, ThoughtSlot>();
  #thinkingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(output: AssistantMessage, stream: AssistantMessageEventStream) {
    this.output = output;
    this.#stream = stream;
  }

  start(): void {
    this.#stream.push({ type: "start", partial: this.output });
  }

  hasToolCall(): boolean {
    return this.output.content.some((part) => part.type === "toolCall");
  }

  hasNativeThought(key: string): boolean {
    return this.#nativeThoughts.has(key);
  }

  /** A public snapshot is a target buffer, never a second source of answer text. */
  updateNativeThinking(key: string, text: string): void {
    if (!text && !this.#nativeThoughts.has(key)) return;
    const slot = this.#reserveNativeThought(key);
    if (slot.closed || text === slot.target) return;
    const now = Date.now();
    const gap = slot.arrivalAt ? Math.max(1_200, Math.min(5_000, now - slot.arrivalAt)) : 3_000;
    slot.arrivalAt = now;
    slot.target = text;
    slot.rate = Math.max(24, Math.min(180, Array.from(text.slice(slot.shown.length)).length * 1000 / gap));
    // Show the first word immediately, then spread the received batch over ticks.
    // A revision is not an append: the authoritative end will replace that block.
    if (!slot.shown && text) this.#emitThinking(slot, prefix(text, 4));
    this.#scheduleThinking();
  }

  endNativeThinking(key: string, text: string): void {
    if (!text && !this.#nativeThoughts.has(key)) return;
    const slot = this.#reserveNativeThought(key);
    if (slot.closed) return;
    slot.target = text;
    this.#endThought(slot);
  }

  /** Count-only markers and runtime notices do not use the animation buffer. */
  fillThought(summary: string, key?: string): void {
    const slot = key === undefined ? this.#reserveThought() : this.#reserveNativeThought(key);
    if (slot.closed) return;
    slot.target = summary;
    this.#endThought(slot);
  }

  closeUnfilledThought(): void {
    if (this.#legacyThought && !this.#legacyThought.closed) this.#endThought(this.#legacyThought);
  }

  /** Boundaries flush received text immediately; animation never holds a tool. */
  closeText(): void {
    this.closeUnfilledThought();
    for (const slot of this.#nativeThoughts.values()) if (!slot.closed) this.#endThought(slot);
    this.#closeTextRun();
  }

  /** A late stdout end belongs only to that response, not newer DB snapshots. */
  closeResponse(key?: string): void {
    if (key === undefined) { this.closeText(); return; }
    const slot = this.#nativeThoughts.get(key);
    if (slot && !slot.closed) this.#endThought(slot);
    if (this.#textKey === key) this.#closeTextRun();
  }

  #closeTextRun(): void {
    if (this.#textIndex === null) return;
    this.#stream.push({ type: "text_end", contentIndex: this.#textIndex, content: this.#textBuffer, partial: this.output });
    this.#textIndex = null;
    this.#textBuffer = "";
    this.#textKey = undefined;
  }

  appendTextDelta(delta: string, key?: string): void {
    if (this.#textIndex !== null && key !== undefined && this.#textKey !== key) this.closeText();
    if (this.#textIndex === null) {
      // A late public snapshot must still have a stable slot above its answer.
      if (key === undefined) this.#reserveThought();
      else this.#reserveNativeThought(key);
      this.output.content.push({ type: "text", text: "" });
      this.#textIndex = this.output.content.length - 1;
      this.#textKey = key;
      this.#textBuffer = "";
      this.#stream.push({ type: "text_start", contentIndex: this.#textIndex, partial: this.output });
    }
    if (key !== undefined) {
      const slot = this.#reserveNativeThought(key);
      if (!slot.closed) this.#flushThought(slot);
    }
    this.#textBuffer += delta;
    const block = this.output.content[this.#textIndex];
    if (block.type === "text") block.text = this.#textBuffer;
    this.#stream.push({ type: "text_delta", contentIndex: this.#textIndex, delta, partial: this.output });
  }

  appendResponseSuffix(suffix: string): void {
    if (this.#textIndex !== null) this.appendTextDelta(suffix, this.#textKey);
    else this.appendTextBlock(suffix);
  }

  appendTextBlock(text: string): void {
    this.closeText();
    this.output.content.push({ type: "text", text });
    const index = this.output.content.length - 1;
    this.#stream.push({ type: "text_start", contentIndex: index, partial: this.output });
    this.#stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: this.output });
    this.#stream.push({ type: "text_end", contentIndex: index, content: text, partial: this.output });
  }

  openToolCall(toolCall: ToolCall): number {
    this.closeText();
    this.output.content.push(toolCall);
    const index = this.output.content.length - 1;
    this.#stream.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
    return index;
  }

  closeToolCall(index: number, toolCall: ToolCall): void {
    this.#stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: this.output });
  }

  done(reason: "stop" | "toolUse"): void {
    this.closeText();
    this.#stream.push({ type: "done", reason, message: this.output });
  }

  error(reason: "error" | "aborted"): void {
    this.closeText();
    this.#stream.push({ type: "error", reason, error: this.output });
  }

  end(): void {
    if (this.#thinkingTimer !== undefined) clearTimeout(this.#thinkingTimer);
    this.#thinkingTimer = undefined;
    this.#stream.end();
  }

  #openThought(): ThoughtSlot {
    const slot: ThoughtSlot = { index: this.output.content.length, target: "", shown: "", arrivalAt: 0, rate: 24, closed: false };
    this.output.content.push({ type: "thinking", thinking: "" });
    this.#stream.push({ type: "thinking_start", contentIndex: slot.index, partial: this.output });
    return slot;
  }

  #reserveThought(): ThoughtSlot {
    if (!this.#legacyThought || this.#legacyThought.closed) this.#legacyThought = this.#openThought();
    return this.#legacyThought;
  }

  #reserveNativeThought(key: string): ThoughtSlot {
    let slot = this.#nativeThoughts.get(key);
    if (!slot) {
      slot = this.#openThought();
      this.#nativeThoughts.set(key, slot);
    }
    return slot;
  }

  #emitThinking(slot: ThoughtSlot, delta: string): void {
    if (!delta) return;
    slot.shown += delta;
    const block = this.output.content[slot.index];
    if (block.type === "thinking") block.thinking = slot.shown;
    this.#stream.push({ type: "thinking_delta", contentIndex: slot.index, delta, partial: this.output });
  }

  #flushThought(slot: ThoughtSlot): void {
    if (slot.target.startsWith(slot.shown)) this.#emitThinking(slot, slot.target.slice(slot.shown.length));
    else {
      slot.shown = slot.target;
      const block = this.output.content[slot.index];
      if (block.type === "thinking") block.thinking = slot.target;
    }
  }

  #endThought(slot: ThoughtSlot): void {
    this.#flushThought(slot);
    slot.closed = true;
    this.#stream.push({ type: "thinking_end", contentIndex: slot.index, content: slot.target, partial: this.output });
    this.#cancelIdleThinkingTimer();
  }

  #pendingThinking(): ThoughtSlot[] {
    return [...this.#nativeThoughts.values()].filter(slot => !slot.closed && slot.target !== slot.shown && slot.target.startsWith(slot.shown));
  }

  #cancelIdleThinkingTimer(): void {
    if (this.#thinkingTimer !== undefined && this.#pendingThinking().length === 0) {
      clearTimeout(this.#thinkingTimer);
      this.#thinkingTimer = undefined;
    }
  }

  #scheduleThinking(): void {
    if (this.#thinkingTimer !== undefined || this.#pendingThinking().length === 0) return;
    this.#thinkingTimer = setTimeout(() => {
      this.#thinkingTimer = undefined;
      for (const slot of this.#pendingThinking()) {
        this.#emitThinking(slot, prefix(slot.target.slice(slot.shown.length), Math.max(1, Math.ceil(slot.rate * THINKING_TICK_MS / 1000))));
      }
      this.#scheduleThinking();
    }, THINKING_TICK_MS);
    this.#thinkingTimer.unref?.();
  }
}
