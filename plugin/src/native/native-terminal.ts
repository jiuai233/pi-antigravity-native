import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { resolveAgyDataDirectory } from "./native-workspace.ts";

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const ERROR_STEP = 17;
const DONE = 3;

export interface NativeTurnBoundary {
  conversationId: string;
  maximumStep: number;
  errors: { index: number; message: string }[];
}

export interface NativeTerminalCorrection {
  kind: "historical_terminal_error";
  conversation_id: string;
  original_status: string | undefined;
  original_error: string;
  historical_error_step: number;
  before_step: number;
  user_step: number;
  completed_response_step: number;
  evidence: "read_only_native_steps";
  current_turn_status: "SUCCESS";
}

interface TerminalResult {
  status?: string;
  conversation_id?: string;
  error?: string;
  response?: string;
}

type StepRow = {
  idx: number;
  step_type: number;
  status: number;
  error_details: Uint8Array | string | number | bigint | null;
  step_payload: Uint8Array;
};

const validId = (value: string | undefined): value is string =>
  typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
const normalize = (value: unknown): string => String(value ?? "").replace(/\r\n?/g, "\n").trimEnd();
// SQLite columns are dynamically typed. Only the known empty representations
// prove absence of a current-turn error; TEXT/numeric/unknown values do not.
const hasNoErrorDetails = (value: unknown): boolean =>
  value === null || (value instanceof Uint8Array && value.byteLength === 0);

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

function fieldText(payload: Uint8Array, route: readonly number[]): string | null {
  let nodes = [payload];
  for (const field of route) nodes = nodes.flatMap((node) => fieldBytes(node, field));
  return nodes.length === 1 ? Buffer.from(nodes[0]).toString("utf8") : null;
}

function openConversation(id: string | undefined, cwd: string | undefined): DatabaseSync | null {
  if (!validId(id)) return null;
  const file = path.join(resolveAgyDataDirectory(cwd), "conversations", `${id}.db`);
  return fs.existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
}

/** Observe the exact resumed conversation before sending its next user request. */
export function captureNativeTurnBoundary(
  conversationId: string | undefined,
  cwd?: string,
): NativeTurnBoundary | null {
  let database: DatabaseSync | null | undefined;
  try {
    database = openConversation(conversationId, cwd);
    if (!database || !conversationId) return null;
    const row = database.prepare("SELECT MAX(idx) AS maximum FROM steps").get() as
      { maximum: number | null } | undefined;
    const maximumStep = row?.maximum;
    if (typeof maximumStep !== "number" || !Number.isSafeInteger(maximumStep)) return null;
    const rows = database.prepare("SELECT idx, step_payload FROM steps WHERE step_type = ? AND idx <= ? ORDER BY idx DESC LIMIT 32")
      .all(ERROR_STEP, maximumStep) as Array<{ idx: number; step_payload: Uint8Array }>;
    const errors = rows.map((step) => ({ index: step.idx, message: fieldText(step.step_payload, [24, 3, 2]) }))
      .filter((step): step is { index: number; message: string } =>
        typeof step.message === "string" && step.message.length > 0);
    return errors.length ? { conversationId, maximumStep, errors } : null;
  } catch {
    // An unavailable or unfamiliar native record cannot justify changing a terminal error.
    return null;
  } finally {
    database?.close();
  }
}

/**
 * CLI 1.4.4 can repeat an old executor error in a conversation-cumulative result
 * after a later user turn has completed. Never infer success from answer text
 * alone: require the pre-request boundary, the exact old error, and the full
 * new persisted turn ending in that result's response. Native history is read-only.
 */
export function reconcileNativeTerminal<T extends TerminalResult>(
  result: T,
  boundary: NativeTurnBoundary | null,
  cwd?: string,
): { result: T; correction: NativeTerminalCorrection | null } {
  const unchanged = { result, correction: null };
  const error = result.error;
  if (!boundary || result.status !== "ERROR" || result.conversation_id !== boundary.conversationId
      || typeof error !== "string" || !normalize(result.response)) return unchanged;
  const oldError = boundary.errors.find((row) => row.index <= boundary.maximumStep && row.message === error);
  if (!oldError) return unchanged;
  let database: DatabaseSync | null | undefined;
  try {
    database = openConversation(boundary.conversationId, cwd);
    if (!database) return unchanged;
    const rows = database.prepare("SELECT idx, step_type, status, error_details, step_payload FROM steps WHERE idx > ? ORDER BY idx")
      .all(boundary.maximumStep) as StepRow[];
    if (rows.length < 2 || rows[0].step_type !== USER_INPUT
        || rows.filter((row) => row.step_type === USER_INPUT).length !== 1
        || rows.some((row, index) => row.idx !== boundary.maximumStep + index + 1
          || row.status !== DONE || row.step_type === ERROR_STEP || !hasNoErrorDetails(row.error_details))) return unchanged;
    const last = rows[rows.length - 1];
    if (last.step_type !== PLANNER_RESPONSE) return unchanged;
    const response = fieldText(last.step_payload, [20, 1]);
    if (response === null || normalize(response) !== normalize(result.response)) return unchanged;
    const correction: NativeTerminalCorrection = {
      kind: "historical_terminal_error", conversation_id: boundary.conversationId,
      original_status: result.status, original_error: error,
      historical_error_step: oldError.index, before_step: boundary.maximumStep,
      user_step: rows[0].idx, completed_response_step: last.idx,
      evidence: "read_only_native_steps", current_turn_status: "SUCCESS",
    };
    return { result: { ...result, status: "SUCCESS", error: undefined }, correction };
  } catch {
    return unchanged;
  } finally {
    database?.close();
  }
}
