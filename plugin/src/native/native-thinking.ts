import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { resolveAgyDataDirectory } from "./native-workspace.ts";

export interface NativeThinkingSnapshot {
  conversationId: string;
  stepId: number;
  text: string;
  status: number;
}

/** Select only length-delimited fields; all other fields remain opaque. */
function fieldBytes(bytes: Uint8Array, field: number): Uint8Array[] {
  const reader = new BinaryReader(bytes);
  const values: Uint8Array[] = [];
  while (reader.pos < reader.len) {
    const [number, wire] = reader.tag();
    if (number === field && wire === WireType.LengthDelimited) values.push(reader.bytes());
    else reader.skip(wire, number);
  }
  return values;
}

function publicThinking(payload: Uint8Array): string {
  const planner = fieldBytes(payload, 20);
  const text = planner.flatMap((bytes) => fieldBytes(bytes, 3));
  return text.length ? Buffer.from(text[text.length - 1]).toString("utf8") : "";
}

/** One logical native turn's read-only observer. Sealing/deduplication belongs to its consumer. */
export class NativeThinkingObserver {
  #cwd: string | undefined;
  #onSnapshot: (snapshot: NativeThinkingSnapshot) => boolean;
  #onDiagnostic: ((message: string) => void) | undefined;
  #intervalMs: number;
  #conversationId: string | undefined;
  #cursor = -1;
  #disabled = new Set<string>();
  #database: DatabaseSync | undefined;
  #query: StatementSync | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #flushing = false;
  #generation = 0;
  #fault: string | undefined;

  constructor(options: {
    cwd?: string;
    onSnapshot: (snapshot: NativeThinkingSnapshot) => boolean;
    onDiagnostic?: (message: string) => void;
    intervalMs?: number;
  }) {
    this.#cwd = options.cwd;
    this.#onSnapshot = options.onSnapshot;
    this.#onDiagnostic = options.onDiagnostic;
    this.#intervalMs = options.intervalMs ?? 200;
  }

  /** Capture an existing conversation's boundary BEFORE sending the user request. */
  prepare(conversationId?: string): void {
    this.close();
    this.#closed = false;
    this.#conversationId = conversationId;
    this.#cursor = -1;
    this.#disabled.clear();
    this.#fault = undefined;
    if (!conversationId) return;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.#file(conversationId), { readOnly: true, timeout: 0 });
      const row = database.prepare("SELECT MAX(idx) AS maximum FROM steps").get();
      const maximum = row?.maximum;
      if (maximum !== null && (typeof maximum !== "number" || !Number.isSafeInteger(maximum))) {
        throw new Error("Invalid steps baseline");
      }
      this.#cursor = maximum ?? -1;
    } catch (error) {
      // Never fall back to -1 for a resumed conversation: that would replay history.
      this.#disabled.add(conversationId);
      this.#diagnose("baseline", error);
    } finally {
      database?.close();
    }
  }

  /** Init may arrive after the first step is persisted; new IDs always start at -1. */
  bind(conversationId: string): void {
    if (this.#closed) return;
    if (conversationId !== this.#conversationId) {
      this.#release();
      this.#generation++;
      this.#conversationId = conversationId;
      this.#cursor = -1;
      this.#fault = undefined;
    }
    if (this.#disabled.has(conversationId)) return;
    this.flush();
    this.#schedule();
  }

  /** Short synchronous read, also used immediately before stdout/bridge boundaries. */
  flush(): void {
    const conversationId = this.#conversationId;
    if (this.#closed || this.#flushing || !conversationId || this.#disabled.has(conversationId)) return;
    const generation = this.#generation;
    let snapshots: NativeThinkingSnapshot[];
    this.#flushing = true;
    try {
      try {
        if (!this.#query) {
          const file = this.#file(conversationId);
          // A newly initialized conversation may not have a database yet.
          if (!fs.existsSync(file)) return;
          this.#database = new DatabaseSync(file, { readOnly: true, timeout: 0 });
          this.#query = this.#database.prepare(
            "SELECT idx, status, step_payload FROM steps WHERE step_type = 15 AND idx > ? ORDER BY idx",
          );
        }
        const rows = this.#query.all(this.#cursor) as Array<{
          idx: number; status: number; step_payload: Uint8Array;
        }>;
        // Decode the entire read first. A corrupt row cannot be skipped by the watermark.
        snapshots = rows.map((row) => ({
          conversationId, stepId: row.idx, status: row.status, text: publicThinking(row.step_payload),
        }));
        this.#fault = undefined;
      } catch (error) {
        this.#releaseDatabase();
        this.#diagnose("read", error);
        return;
      }
      let contiguous = true;
      for (const snapshot of snapshots) {
        if (this.#closed || generation !== this.#generation) break;
        const consumed = this.#onSnapshot(snapshot);
        if (this.#closed || generation !== this.#generation) break;
        contiguous = contiguous && consumed;
        if (contiguous) this.#cursor = snapshot.stepId;
      }
    } finally {
      this.#flushing = false;
    }
  }

  close(): void {
    this.#closed = true;
    this.#generation++;
    this.#release();
  }

  #file(conversationId: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(conversationId)) throw new Error("Invalid native conversation ID");
    return path.join(resolveAgyDataDirectory(this.#cwd), "conversations", `${conversationId}.db`);
  }

  #schedule(): void {
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
      this.#schedule();
    }, this.#intervalMs);
  }

  #releaseDatabase(): void {
    this.#query = undefined;
    this.#database?.close();
    this.#database = undefined;
  }

  #release(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#releaseDatabase();
  }

  #diagnose(phase: string, error: unknown): void {
    const fault = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
    if (fault === this.#fault) return;
    this.#fault = fault;
    this.#onDiagnostic?.(`公开思路末份未确认 (${this.#conversationId}): ${fault}`);
  }
}
