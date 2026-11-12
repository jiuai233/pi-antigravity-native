/** Side-band fingerprints only: never modifies prompts, tools, history or native databases. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import type { AgyTurnDiagnostic } from "../driver/agy-client.ts";
import type { AgyActivity } from "../driver/reducer.ts";
import type { PiToolInfo } from "../extension/bridge.ts";
import { resolveAgyDataDirectory } from "./native-workspace.ts";

export const PREFIX_AUDIT_ENTRY = "pi-antigravity-prefix-audit";

type ToolFingerprint = { name: string; description: string; schema: string; semanticSchema: string };
type LocalSnapshot = {
  system: string; systemLF: string; agent: string | null; agentName: string;
  tools: ToolFingerprint[];
};
type NativeSnapshot = {
  conversationId: string; generation: number;
  system: string; systemLF: string; tools: string; config: string;
  messageCount: number; messageChain: string;
  inputTokens: number; cacheReadTokens: number; outputTokens: number;
  ttftMs?: number;
};
type LocalEvent = { kind: "local"; snapshot: LocalSnapshot; changes: string[] };
type NativeEvent = {
  kind: "native"; snapshot: NativeSnapshot; changes: string[];
  previousGeneration?: number; historyPrefixPreserved?: boolean; missingGenerations: number;
  recordFingerprint?: string; comparisonFingerprint?: string; recordUpdated?: boolean;
};
type NativeStatus = "complete" | "pending" | "usage_only" | "failed" | "invalid";
type ObservationEvent = {
  kind: "native_observation"; conversationId: string; generation: number;
  status: Exclude<NativeStatus, "complete">; recordFingerprint: string;
};
type ObservedGeneration = {
  fingerprint: string; status: NativeStatus;
  native?: NativeEvent & { atMs: number }; observation?: ObservationEvent & { atMs: number };
};
type WarningEvent = { kind: "warning"; stage: string; code: string };
export type PrefixAuditEvent = (LocalEvent | NativeEvent | ObservationEvent | WarningEvent) & { version: 1; atMs: number };

type Field = { number: number; wire: WireType; raw: Uint8Array; value?: Uint8Array; integer?: number };
const EMPTY = new Uint8Array();
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => JSON.stringify(value) ?? "null";
const lfHash = (value: string): string => hash(value.replace(/\r\n/g, "\n"));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

// Field numbers are from AGY 1.5.6's embedded CortexGenerationMetadata descriptors.
// Unrecognized fields stay opaque. In particular, thinking/signatures are NEVER decoded or logged.
function fields(data: Uint8Array): Field[] {
  const reader = new BinaryReader(data);
  const result: Field[] = [];
  while (reader.pos < reader.len) {
    const start = reader.pos;
    const [number, wire] = reader.tag();
    let value: Uint8Array | undefined;
    let integer: number | undefined;
    if (wire === WireType.LengthDelimited) value = reader.bytes();
    else if (wire === WireType.Varint) integer = Number(reader.uint64());
    else reader.skip(wire, number);
    result.push({ number, wire, value, integer, raw: data.subarray(start, reader.pos) });
  }
  return result;
}
const bytes = (parts: Field[], number: number): Uint8Array => parts.find(f => f.number === number)?.value ?? EMPTY;
const count = (parts: Field[], number: number): number => parts.find(f => f.number === number)?.integer ?? 0;
const text = (value: Uint8Array): string => Buffer.from(value).toString("utf8");
function hashFields(parts: Field[], include: (number: number) => boolean): string {
  const digest = createHash("sha256");
  for (const field of parts) if (include(field.number)) digest.update(field.raw);
  return digest.digest("hex");
}

function captureLocal(systemPrompt: string, tools: readonly PiToolInfo[], agent: { name: string; agentBody?: string }): LocalSnapshot {
  return {
    system: hash(systemPrompt), systemLF: lfHash(systemPrompt), agent: agent.agentBody === undefined ? null : hash(agent.agentBody), agentName: agent.name,
    tools: tools.map(tool => ({
      name: tool.name, description: hash(tool.description ?? ""),
      schema: hash(json(tool.parameters)), semanticSchema: hash(json(canonical(tool.parameters))),
    })),
  };
}
function localChanges(previous: LocalSnapshot, next: LocalSnapshot): string[] {
  const changes: string[] = [];
  if (previous.system !== next.system) changes.push(previous.systemLF === next.systemLF ? "system_line_endings" : "system_prompt");
  if (previous.agentName !== next.agentName) changes.push("bridge_identity");
  if (json(previous.tools.map(t => t.name)) !== json(next.tools.map(t => t.name))) changes.push("tool_list_or_order");
  const old = new Map(previous.tools.map(tool => [tool.name, tool]));
  for (const tool of next.tools) {
    const before = old.get(tool.name);
    if (!before) { changes.push(`tool_added:${tool.name}`); continue; }
    if (before.description !== tool.description) changes.push(`tool_description:${tool.name}`);
    if (before.schema !== tool.schema) changes.push(`${before.semanticSchema === tool.semanticSchema ? "schema_order" : "tool_schema"}:${tool.name}`);
  }
  const names = new Set(next.tools.map(t => t.name));
  for (const tool of previous.tools) if (!names.has(tool.name)) changes.push(`tool_removed:${tool.name}`);
  if (previous.agent !== next.agent) changes.push("agent_body");
  return changes;
}

function captureNative(data: Uint8Array, conversationId: string, generation: number, previous?: NativeSnapshot):
  { snapshot: NativeSnapshot; historyPrefixPreserved?: boolean } | { status: Exclude<NativeStatus, "complete"> } {
  const root = fields(data);
  if (bytes(root, 5).length) return { status: "failed" }; // Not a cache miss.
  const chat = fields(bytes(root, 1));
  const usage = fields(bytes(chat, 4));
  const inputTokens = count(usage, 2);
  const cacheReadTokens = count(usage, 5);
  const outputTokens = count(usage, 3);
  const system = bytes(chat, 1);
  const messages = chat.flatMap(f => f.number === 2 && f.value ? [f.value] : []);
  // Older generations may already have been reduced to usage-only skeletons.
  if (!system.length || !messages.length) {
    return { status: inputTokens + cacheReadTokens + outputTokens ? "usage_only" : "pending" };
  }
  if (!outputTokens || !(inputTokens + cacheReadTokens)) return { status: "pending" };
  let messageChain = hash(EMPTY);
  let previousPrefix = previous?.messageCount === 0 ? messageChain : undefined;
  for (let i = 0; i < messages.length; i++) {
    // Exclude only three known non-content annotations: message_id, num_tokens,
    // provider_assigned_message_id. All other fields contribute opaque bytes.
    const content = hashFields(fields(messages[i]), n => n !== 1 && n !== 4 && n !== 21);
    messageChain = hash(`${messageChain}:${content}`);
    if (i + 1 === previous?.messageCount) previousPrefix = messageChain;
  }
  const duration = bytes(chat, 11);
  const durationFields = fields(duration);
  return {
    snapshot: {
      conversationId, generation, system: hash(system), systemLF: lfHash(text(system)),
      tools: hashFields(chat, n => n === 8), config: hashFields(chat, n => n === 3 || n === 7 || n === 15),
      messageCount: messages.length, messageChain, inputTokens, cacheReadTokens, outputTokens,
      ...(duration.length ? { ttftMs: count(durationFields, 1) * 1000 + count(durationFields, 2) / 1e6 } : {}),
    },
    ...(previous ? { historyPrefixPreserved: previousPrefix === previous.messageChain } : {}),
  };
}

const CHANGE_LABELS: Record<string, string> = {
  baseline: "首份采样", system_line_endings: "系统提示换行", system_prompt: "系统提示",
  bridge_identity: "工具桥身份", tool_list_or_order: "工具列表/顺序", tool_added: "新增工具",
  tool_removed: "移除工具", tool_description: "工具描述", schema_order: "参数排列",
  tool_schema: "参数定义", agent_body: "agent 正文", native_tools: "原生工具定义",
  request_config: "请求配置", history_record_changed: "既有消息记录（含不透明字段）",
};
function formatChanges(changes: string[]): string {
  return changes.map(change => {
    const [key, ...rest] = change.split(":");
    return `${CHANGE_LABELS[key] ?? key}${rest.length ? `: ${rest.join(":")}` : ""}`;
  }).join("、");
}

const STATUS_LABELS: Record<NativeStatus, string> = {
  complete: "完整成功请求", pending: "用量待完成", usage_only: "仅用量，完整请求不可见",
  failed: "失败请求（不计冷缓存）", invalid: "元数据无法解析",
};
// Error names/messages can be user-controlled. Persist only fixed categories.
function diagnosticCode(error: unknown): string {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  return error instanceof Error ? "Error" : "UnknownError";
}

function comparisonFingerprint(snapshot?: NativeSnapshot): string {
  if (!snapshot) return "baseline";
  return hash(json([snapshot.generation, snapshot.system, snapshot.systemLF, snapshot.tools,
    snapshot.config, snapshot.messageCount, snapshot.messageChain]));
}

const TIMING_LABELS: Partial<Record<AgyTurnDiagnostic["phase"], string>> = {
  local_run_start: "本地执行起点", stdin_ready: "子进程管道可写", stdin_write_start: "开始写入管道",
  stdin_write_complete: "管道写入完成", argv_spawn_start: "开始创建进程", argv_spawned: "进程已创建",
  stdout_first_byte: "首个 stdout 字节", activity_first: "首个结构化活动", response_text_first: "首段回复正文",
};
const DIAGNOSTIC_PHASES = new Set([...Object.keys(TIMING_LABELS), "attempt_start", "stall", "retry",
  "retry_continuation", "attempt_end", "historical_terminal_error", "healed_in_turn_error",
  "native_thinking_warning", "driver_recycle"]);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function validAuditEvent(value: unknown): value is PrefixAuditEvent {
  if (!isObject(value) || value.version !== 1 || !isTime(value.atMs)) return false;
  if (value.kind === "warning") return typeof value.stage === "string" && typeof value.code === "string";
  if (value.kind === "native_observation") return isId(value.conversationId) && isCount(value.generation)
    && ["pending", "usage_only", "failed", "invalid"].includes(String(value.status))
    && (isHash(value.recordFingerprint) || value.recordFingerprint === "non_blob");
  const s = value.snapshot;
  if (!isObject(s) || !isStrings(value.changes)) return false;
  if (value.kind === "local") return isHash(s.system) && isHash(s.systemLF)
    && (s.agent === null || isHash(s.agent)) && typeof s.agentName === "string" && Array.isArray(s.tools)
    && s.tools.every(tool => isObject(tool) && typeof tool.name === "string" && isHash(tool.description)
      && isHash(tool.schema) && isHash(tool.semanticSchema));
  if (value.kind !== "native") return false;
  return isId(s.conversationId) && isCount(s.generation) && isHash(s.system) && isHash(s.systemLF)
    && isHash(s.tools) && isHash(s.config) && isCount(s.messageCount) && isHash(s.messageChain)
    && isCount(s.inputTokens) && isCount(s.cacheReadTokens) && isCount(s.outputTokens)
    && (s.ttftMs === undefined || isTime(s.ttftMs)) && isCount(value.missingGenerations)
    && (value.previousGeneration === undefined || isCount(value.previousGeneration))
    && (value.historyPrefixPreserved === undefined || typeof value.historyPrefixPreserved === "boolean");
}
function validDiagnostic(value: unknown): value is AgyTurnDiagnostic {
  return isObject(value) && typeof value.phase === "string" && DIAGNOSTIC_PHASES.has(value.phase)
    && isTime(value.atMs) && (value.attempt === undefined || isCount(value.attempt))
    && (value.conversationId === undefined || isId(value.conversationId))
    && (value.status === undefined || typeof value.status === "string")
    && (value.message === undefined || typeof value.message === "string");
}

/** Event-triggered only. Owns no timer, watcher, process or long-lived connection. */
export class AgyPrefixAudit {
  #writeEntry: (event: PrefixAuditEvent) => void;
  #local: (LocalEvent & { atMs: number }) | undefined;
  #native: (NativeEvent & { atMs: number }) | undefined;
  #runtime: AgyTurnDiagnostic | undefined;
  #recycle: string | undefined;
  #faults = new Map<string, string>();
  #conversationId: string | undefined;
  #generations = new Map<number, ObservedGeneration>();
  #cursor = -1;
  #onUpdate: () => void;
  #timings = new Map<AgyTurnDiagnostic["phase"], number>();
  #timingAttempt: number | undefined;
  #timingConversation: string | undefined;

  constructor(writeEntry: (event: PrefixAuditEvent) => void, onUpdate: () => void = () => {}) {
    this.#writeEntry = writeEntry;
    this.#onUpdate = onUpdate;
  }

  restore(entries: readonly { type: string; customType?: string; data?: unknown }[]): void {
    this.#local = undefined;
    this.#native = undefined;
    this.#runtime = undefined;
    this.#recycle = undefined;
    this.#faults.clear();
    this.#conversationId = undefined;
    this.#generations.clear();
    this.#cursor = -1;
    this.#timings.clear();
    this.#timingAttempt = undefined;
    this.#timingConversation = undefined;
    for (const entry of entries) {
      if (!entry || entry.type !== "custom") continue;
      if (entry.customType === PREFIX_AUDIT_ENTRY) {
        const event = entry.data;
        if (!validAuditEvent(event)) { this.#faults.set("restore", "InvalidEntry"); continue; }
        if (event.kind === "local") this.#local = event;
        if (event.kind === "native") {
          this.#selectConversation(event.snapshot.conversationId);
          this.#rememberNative(event);
        }
        if (event.kind === "native_observation") {
          this.#selectConversation(event.conversationId);
          this.#rememberObservation(event);
        }
      } else if (entry.customType === "pi-antigravity-turn-diagnostic") {
        if (!validDiagnostic(entry.data)) { this.#faults.set("restore", "InvalidEntry"); continue; }
        this.recordDiagnostic(entry.data, false);
      }
    }
    this.#refresh();
  }

  recordLocal(systemPrompt: string, tools: readonly PiToolInfo[], agent: { name: string; agentBody?: string }): void {
    try {
      const snapshot = captureLocal(systemPrompt, tools, agent);
      const changes = this.#local ? localChanges(this.#local.snapshot, snapshot) : ["baseline"];
      const changed = !this.#local || json(this.#local.snapshot) !== json(snapshot);
      const event: LocalEvent & { atMs: number } = { kind: "local", atMs: Date.now(), snapshot, changes };
      this.#faults.delete("local");
      // Do not advance a durable baseline until the journal accepted it.
      if (!changed || this.#emit(event)) this.#local = event;
    } catch (error) { this.#warn("local", error); }
    this.#refresh();
  }

  /** Only completed-response/tool-handoff/result events may read native metadata. */
  observeActivity(activity: Pick<AgyActivity, "type">, conversationId: () => string | undefined, cwd?: string): void {
    if (activity.type === "response_end" || activity.type === "bridge_call" || activity.type === "result") {
      try { this.sample(conversationId(), cwd); }
      catch (error) { this.#warn("native_source", error); this.#refresh(); }
    }
  }

  sample(conversationId?: string, cwd?: string): void {
    if (!conversationId) return;
    let db: DatabaseSync | undefined;
    try {
      if (!/^[a-f0-9-]{36}$/i.test(conversationId)) throw new Error("Invalid native conversation ID");
      const file = path.join(resolveAgyDataDirectory(cwd), "conversations", `${conversationId}.db`);
      if (!fs.existsSync(file)) return;
      db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
      this.observeNative(conversationId, db);
    } catch (error) { this.#warn("native", error); }
    finally {
      try { db?.close(); } catch (error) { this.#warn("native_close", error); }
      this.#refresh();
    }
  }

  observeNative(conversationId: string, db: DatabaseSync): void {
    try {
      this.#selectConversation(conversationId);
      // Enumerate integer ids, not historical payloads: an older missing id can
      // appear late. Revisit only the latest/successful/pending payloads.
      const pending = new Set<number>();
      const present = db.prepare("SELECT idx FROM gen_metadata ORDER BY idx").all();
      for (const row of present) if (typeof row.idx === "number" && !this.#generations.has(row.idx)) pending.add(row.idx);
      for (const [idx, state] of this.#generations) if (state.status === "pending") pending.add(idx);
      if (this.#cursor >= 0) pending.add(this.#cursor);
      if (this.#native) pending.add(this.#native.snapshot.generation);
      const read = db.prepare("SELECT data FROM gen_metadata WHERE idx = ?");
      const queue = [...pending].sort((a, b) => a - b);
      for (let position = 0; position < queue.length; position++) {
        const idx = queue[position];
        pending.delete(idx);
        const row = read.get(idx);
        if (!row) continue;
        const data = row.data;
        const fingerprint = data instanceof Uint8Array ? hash(data) : "non_blob";
        const before = this.#generations.get(idx);
        const previous = this.#previousNative(idx)?.snapshot;
        const comparison = comparisonFingerprint(previous);
        if (before?.fingerprint === fingerprint &&
            (before.status !== "complete" || before.native?.comparisonFingerprint === comparison)) continue;
        let captured: ReturnType<typeof captureNative>;
        try {
          captured = data instanceof Uint8Array ? captureNative(data, conversationId, idx, previous) : { status: "invalid" };
        } catch { captured = { status: "invalid" }; }
        if ("status" in captured) {
          const event: ObservationEvent & { atMs: number } = {
            kind: "native_observation", atMs: Date.now(), conversationId, generation: idx,
            status: captured.status, recordFingerprint: fingerprint,
          };
          if (!this.#emit(event)) return;
          this.#rememberObservation(event);
          continue;
        }
        const { snapshot, historyPrefixPreserved } = captured;
        const changes: string[] = [];
        if (!previous) changes.push("baseline");
        else {
          if (snapshot.system !== previous.system) changes.push(snapshot.systemLF === previous.systemLF ? "system_line_endings" : "system_prompt");
          if (snapshot.tools !== previous.tools) changes.push("native_tools");
          if (snapshot.config !== previous.config) changes.push("request_config");
          if (!historyPrefixPreserved) changes.push("history_record_changed");
        }
        const event: NativeEvent & { atMs: number } = {
          kind: "native", atMs: Date.now(), snapshot, changes, historyPrefixPreserved,
          previousGeneration: previous?.generation,
          missingGenerations: previous ? snapshot.generation - previous.generation - 1 : 0,
          recordFingerprint: fingerprint,
          comparisonFingerprint: comparison,
          ...(before?.native ? { recordUpdated: true } : {}),
        };
        if (!this.#emit(event)) return;
        this.#rememberNative(event);
        // A pending generation completed late. Recompute the next retained
        // comparison as well; otherwise its reported sampling gap stays stale.
        let successor: number | undefined;
        if (this.#native && this.#native.snapshot.generation > idx) {
          for (const [generation, state] of this.#generations) {
            if (generation > idx && state.native && (successor === undefined || generation < successor)) successor = generation;
          }
        }
        if (successor !== undefined && !pending.has(successor)) {
          pending.add(successor);
          let insert = position + 1;
          while (insert < queue.length && queue[insert] < successor) insert++;
          queue.splice(insert, 0, successor);
        }
      }
      this.#faults.delete("native");
    } catch (error) { this.#warn("native", error); }
    finally { this.#refresh(); }
  }

  #selectConversation(conversationId: string): void {
    if (this.#conversationId === conversationId) return;
    this.#conversationId = conversationId;
    this.#generations.clear();
    this.#cursor = -1;
    this.#native = undefined;
  }

  #previousNative(generation: number): (NativeEvent & { atMs: number }) | undefined {
    if (!this.#native || this.#native.snapshot.generation < generation) return this.#native;
    let previous: (NativeEvent & { atMs: number }) | undefined;
    for (const [idx, state] of this.#generations) {
      if (idx < generation && state.native && (!previous || idx > previous.snapshot.generation)) previous = state.native;
    }
    return previous;
  }

  #rememberNative(event: NativeEvent & { atMs: number }): void {
    const idx = event.snapshot.generation;
    this.#generations.set(idx, { fingerprint: event.recordFingerprint ?? "", status: "complete", native: event });
    this.#cursor = Math.max(this.#cursor, idx);
    if (!this.#native || idx >= this.#native.snapshot.generation) this.#native = event;
  }

  #rememberObservation(event: ObservationEvent & { atMs: number }): void {
    this.#generations.set(event.generation, {
      ...this.#generations.get(event.generation), fingerprint: event.recordFingerprint,
      status: event.status, observation: event,
    });
    this.#cursor = Math.max(this.#cursor, event.generation);
  }

  recordDiagnostic(event: AgyTurnDiagnostic, refresh = true): void {
    if (!validDiagnostic(event)) { this.#faults.set("diagnostic", "InvalidEntry"); if (refresh) this.#refresh(); return; }
    this.#runtime = event;
    if (event.phase === "driver_recycle") this.#recycle = event.message;
    if (event.phase === "attempt_start" || event.phase === "local_run_start") {
      this.#timings.clear();
      this.#timingAttempt = event.attempt;
      this.#timingConversation = event.conversationId;
    }
    if (TIMING_LABELS[event.phase] && event.attempt === this.#timingAttempt
        && (!this.#timingConversation || !event.conversationId || this.#timingConversation === event.conversationId)) {
      if (event.conversationId) this.#timingConversation = event.conversationId;
      if (!this.#timings.has(event.phase)) this.#timings.set(event.phase, event.atMs);
    }
    if (refresh) this.#refresh();
  }

  summary(): string {
    const native = this.#native;
    const latest = this.#generations.get(this.#cursor);
    const observed = latest && latest.status !== "complete" ? `最新 #${this.#cursor} ${STATUS_LABELS[latest.status]}` : "";
    if (!native) return this.#faults.size ? "AGY 审计暂不可用（/agy 查看）" : observed ? `AGY ${observed}` : "AGY 缓存：等待原生采样";
    const s = native.snapshot;
    const percent = (100 * s.cacheReadTokens / (s.inputTokens + s.cacheReadTokens)).toFixed(1);
    const change = native.changes.length ? formatChanges(native.changes) : "采样前缀未变";
    return `AGY 上次缓存 ${percent}% · ${change}${native.missingGenerations ? " · 有采样缺口" : ""}${observed ? ` · ${observed}` : ""}${this.#faults.size ? " · 审计告警" : ""}`;
  }

  details(): string[] {
    const lines = ["prefix audit: v1（只读指纹；非最终出站 wire）", this.summary()];
    if (this.#local) {
      lines.push(`本地前缀: ${formatChanges(this.#local.changes.slice(0, 8)) || "本次检查未变"}${this.#local.changes.length > 8 ? ` 等 ${this.#local.changes.length} 项（全量见日志）` : ""}`);
      lines.push(`本地指纹: system=${this.#local.snapshot.system.slice(0, 12)} agent=${this.#local.snapshot.agent?.slice(0, 12) ?? "未提供"}`);
    }
    if (this.#native) {
      const { snapshot: s, changes, previousGeneration, missingGenerations } = this.#native;
      lines.push(`原生采样: ${s.conversationId} #${s.generation} · 对照=${previousGeneration ?? "无（首份）"} · 缺口=${missingGenerations}`);
      lines.push(`缓存 token: 读取=${s.cacheReadTokens} 未缓存输入=${s.inputTokens} 输出=${s.outputTokens}`);
      lines.push(`原生变化: ${formatChanges(changes) || "可见头未变，历史按采样纯追加"}`);
      if (!s.cacheReadTokens) lines.push("零缓存原因: 未定；本地/原生元数据指纹不能替代最终请求与服务端缓存键。");
      if (s.ttftMs !== undefined) lines.push(`原生首 token 等待: ${(s.ttftMs / 1000).toFixed(3)} 秒（未拆分网络/服务端）`);
      lines.push(`采样时间: ${new Date(this.#native.atMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} UTC+8`);
    } else lines.push("原生请求: 尚无完整成功请求采样；缺记录不按零缓存计算。");
    if (this.#generations.size) {
      const counts = { complete: 0, pending: 0, usage_only: 0, failed: 0, invalid: 0 };
      for (const state of this.#generations.values()) counts[state.status]++;
      lines.push(`元数据覆盖: 已观察 ${this.#generations.size} 代；完整=${counts.complete} 待完成=${counts.pending} 仅用量=${counts.usage_only} 失败=${counts.failed} 无法解析=${counts.invalid}`);
      lines.push("采样边界: 按事件补采新代，复查最新代、最近成功代和待完成代；不代表最终 HTTPS 或服务端缓存键。");
    }
    if (this.#runtime) lines.push(`回合诊断: ${this.#runtime.phase}${this.#runtime.status ? ` ${this.#runtime.status}` : ""}`);
    const started = this.#timings.get("local_run_start");
    if (started !== undefined) {
      lines.push(`本地阶段（尝试 ${this.#timingAttempt ?? "未知"}，从执行起点计时）: ${[...this.#timings]
        .filter(([phase]) => phase !== "local_run_start").sort((a, b) => a[1] - b[1])
        .map(([phase, at]) => `${TIMING_LABELS[phase]}=${((at - started) / 1000).toFixed(3)}秒`).join("；") || "等待子进程边界"}`);
      lines.push("管道交付和 stdout 时间仅为宿主观测，不等于 HTTPS 发出、模型首 token 或 Google 处理耗时。");
    }
    if (this.#recycle) lines.push(`最近配置回收: ${this.#recycle}`);
    for (const [stage, code] of this.#faults) lines.push(`审计告警: ${stage}/${code}`);
    lines.push(`日志条目: ${PREFIX_AUDIT_ENTRY}（当前 Pi 会话 JSONL）`);
    return lines;
  }

  #refresh(): void {
    try { this.#onUpdate(); } catch { /* A detached UI cannot affect the model turn. */ }
  }

  #emit(event: LocalEvent | NativeEvent | ObservationEvent | WarningEvent): boolean {
    try {
      this.#writeEntry({ version: 1, atMs: Date.now(), ...event });
      this.#faults.delete("journal");
      return true;
    } catch (error) {
      // Observability failure must not abort a model turn or lose a real tool result.
      const code = diagnosticCode(error);
      if (this.#faults.get("journal") !== code) console.warn(`[antigravity prefix audit] journal/${code}`);
      this.#faults.set("journal", code);
      return false;
    }
  }

  #warn(stage: string, error: unknown): void {
    const code = diagnosticCode(error);
    if (this.#faults.get(stage) === code) return;
    this.#faults.set(stage, code);
    this.#emit({ kind: "warning", stage, code });
  }
}
