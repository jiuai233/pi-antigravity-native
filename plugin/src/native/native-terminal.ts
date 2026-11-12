import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { resolveAgyDataDirectory } from "./native-workspace.ts";

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const ERROR_STEP = 17;
const CHECKPOINT = 23;
const MCP_TOOL = 132;
const DONE = 3;
const INVALID = 4;
const CLEARED = 5;
const TOOL_ERROR = 7;

export interface NativeTurnBoundary {
  /** Undefined when captured before Turn 0 of a brand-new conversation. */
  conversationId: string | undefined;
  /** Highest persisted step index before this turn (`-1` before Turn 0). */
  maximumStep: number;
  errors: { index: number; message: string }[];
}

export interface NativeTerminalCorrection {
  kind: "historical_terminal_error" | "healed_in_turn_error";
  conversation_id: string;
  original_status: string | undefined;
  original_error: string;
  historical_error_step: number;
  in_turn_error_count?: number;
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
// Real API/stream failures persist as ERROR_STEP (17). MCP_TOOL (132) records tool-level
// schema/execution errors as status 4 (INVALID) or 7 (ERROR) with error_details while the
// model recovers and finishes the turn; all other step types require clean DONE (3).
const isCompletedTurnStep = (row: StepRow): boolean =>
  row.step_type !== ERROR_STEP &&
  ((row.status === DONE && hasNoErrorDetails(row.error_details)) ||
    (row.step_type === MCP_TOOL && (row.status === INVALID || row.status === TOOL_ERROR) &&
      row.error_details instanceof Uint8Array && row.error_details.byteLength > 0));

// Before an in-turn ERROR_STEP (17) that AGY subsequently healed, AGY may mark
// rolled-back planner/MCP tool steps as CLEARED (5). USER_INPUT (14) must stay
// DONE (3) and CHECKPOINT (23) compaction turns are excluded so the original
// user prompt is guaranteed intact.
const isClearedPreErrorStep = (row: StepRow): boolean =>
  row.status === CLEARED &&
  hasNoErrorDetails(row.error_details) &&
  (row.step_type === PLANNER_RESPONSE || row.step_type === MCP_TOOL);

function matchesPlannerSegments(rows: readonly StepRow[], rawResponse: unknown): boolean {
  const segments = rows.map((row) => plannerText(row.step_payload));
  if (segments.some((text) => text === null)) return false;
  const rawSegments = (segments as string[])
    .map((text) => text.replace(/\r\n?/g, "\n"))
    .filter((text) => normalize(text).length > 0);
  if (!rawSegments.length) return false;
  const texts = rawSegments.map(normalize);
  const rawJoined = normalize(rawSegments.map((text) => `${text}\n`).join(""));
  const expected = normalize(rawResponse);
  return expected === texts.at(-1) || expected === texts.join("\n") || expected === rawJoined;
}

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

/** Only explicit transient API failures can be cleared by a completed retry. */
function isRetryableApiError(message: string): boolean {
  return /^API error \(attempt [1-9]\d*\): (?:request failed: .*: (?:unexpected )?EOF|INTERNAL \(code 500\): .*|UNAVAILABLE \(code 503\): .*)$/.test(message);
}

/** Response text of one planner step: "" for a tool-only step, null when ambiguous. */
function plannerText(payload: Uint8Array): string | null {
  let nodes = [payload];
  for (const field of [20, 1]) nodes = nodes.flatMap((node) => fieldBytes(node, field));
  if (nodes.length > 1) return null;
  return nodes.length ? Buffer.from(nodes[0]).toString("utf8") : "";
}

function openConversation(id: string | undefined, cwd: string | undefined): DatabaseSync | null {
  if (!validId(id)) return null;
  const file = path.join(resolveAgyDataDirectory(cwd), "conversations", `${id}.db`);
  return fs.existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
}

/**
 * Return the number of persisted USER_INPUT steps in `<conversationId>.db`, or
 * `null` when no native database file exists on disk (e.g. unit-test mocks or
 * pre-init failures) or the database cannot be read.
 */
export function countNativeUserSteps(
  conversationId: string | undefined,
  cwd?: string,
): number | null {
  let database: DatabaseSync | null | undefined;
  try {
    database = openConversation(conversationId, cwd);
    if (!database) return null;
    const row = database.prepare("SELECT COUNT(*) AS total FROM steps WHERE step_type = ?").get(USER_INPUT) as
      | { total: number }
      | undefined;
    return typeof row?.total === "number" && Number.isSafeInteger(row.total) ? row.total : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

/** Return `MAX(idx)` in `<conversationId>.db`, `-1` before Turn 0 / empty table, or `null` on missing/unreadable DB. */
export function captureMaxNativeStep(
  conversationId: string | undefined,
  cwd?: string,
): number | null {
  if (conversationId === undefined) return -1;
  let database: DatabaseSync | null | undefined;
  try {
    database = openConversation(conversationId, cwd);
    if (!database) return null;
    const row = database.prepare("SELECT MAX(idx) AS maximum FROM steps").get() as
      | { maximum: number | null }
      | undefined;
    if (row?.maximum === null) return -1;
    return typeof row?.maximum === "number" && Number.isSafeInteger(row.maximum) ? row.maximum : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

/**
 * True when `<conversationId>.db` persisted exactly one `USER_INPUT` after
 * `beforeStep` and that turn did not complete with a non-empty `DONE` planner step.
 */
export function hasUnfinishedPersistedTurn(
  conversationId: string | undefined,
  beforeStep: number | null,
  cwd?: string,
): boolean {
  if (!conversationId || beforeStep === null || !Number.isSafeInteger(beforeStep)) return false;
  let database: DatabaseSync | null | undefined;
  try {
    database = openConversation(conversationId, cwd);
    if (!database) return false;
    const rows = database
      .prepare("SELECT idx, step_type, status, step_payload FROM steps WHERE idx > ? ORDER BY idx")
      .all(beforeStep) as Array<{ idx: number; step_type: number; status: number; step_payload: Uint8Array }>;
    if (rows.length < 1 || rows[0].step_type !== USER_INPUT) return false;
    if (rows.filter((row) => row.step_type === USER_INPUT).length !== 1) return false;
    const last = rows[rows.length - 1];
    if (last.step_type === PLANNER_RESPONSE && last.status === DONE) {
      const text = plannerText(last.step_payload);
      if (text !== null && normalize(text).length > 0) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

/** Observe the exact conversation boundary before sending its next user request. */
export function captureNativeTurnBoundary(
  conversationId: string | undefined,
  cwd?: string,
): NativeTurnBoundary | null {
  if (conversationId === undefined) {
    return { conversationId: undefined, maximumStep: -1, errors: [] };
  }
  let database: DatabaseSync | null | undefined;
  try {
    database = openConversation(conversationId, cwd);
    if (!database) return null;
    const row = database.prepare("SELECT MAX(idx) AS maximum FROM steps").get() as
      { maximum: number | null } | undefined;
    const maximumStep = row?.maximum;
    if (typeof maximumStep !== "number" || !Number.isSafeInteger(maximumStep)) return null;
    const rows = database.prepare("SELECT idx, step_payload FROM steps WHERE step_type = ? AND idx <= ? ORDER BY idx DESC LIMIT 32")
      .all(ERROR_STEP, maximumStep) as Array<{ idx: number; step_payload: Uint8Array }>;
    const errors = rows.map((step) => ({ index: step.idx, message: fieldText(step.step_payload, [24, 3, 2]) }))
      .filter((step): step is { index: number; message: string } =>
        typeof step.message === "string" && step.message.length > 0);
    return { conversationId, maximumStep, errors };
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
 * new persisted turn ending in that result's response. agy's `response` joins every
 * text segment of the turn with a line break, so a turn with tool calls is compared
 * against all of its planner texts; a CLI that returns only the final segment still
 * matches. Native history is read-only.
 */
export function reconcileNativeTerminal<T extends TerminalResult>(
  result: T,
  boundary: NativeTurnBoundary | null,
  cwd?: string,
): { result: T; correction: NativeTerminalCorrection | null } {
  const unchanged = { result, correction: null };
  const error = result.error;
  const conversationId = result.conversation_id;
  if (
    !boundary ||
    result.status !== "ERROR" ||
    !validId(conversationId) ||
    (boundary.conversationId !== undefined && conversationId !== boundary.conversationId) ||
    typeof error !== "string" ||
    error.length === 0 ||
    !normalize(result.response)
  ) {
    return unchanged;
  }
  let database: DatabaseSync | null | undefined;
  try {
    database = openConversation(conversationId, cwd);
    if (!database) return unchanged;
    const rows = database.prepare("SELECT idx, step_type, status, error_details, step_payload FROM steps WHERE idx > ? ORDER BY idx")
      .all(boundary.maximumStep) as StepRow[];
    if (
      rows.length < 2 ||
      rows[0].step_type !== USER_INPUT ||
      rows[0].status !== DONE ||
      !hasNoErrorDetails(rows[0].error_details) ||
      rows.filter((row) => row.step_type === USER_INPUT).length !== 1 ||
      rows.some((row, index) => row.idx !== boundary.maximumStep + index + 1)
    ) {
      return unchanged;
    }
    const last = rows[rows.length - 1];
    if (last.step_type !== PLANNER_RESPONSE || last.status !== DONE || !hasNoErrorDetails(last.error_details)) {
      return unchanged;
    }
    const planner = fieldBytes(last.step_payload, 20);
    if (planner.length !== 1 || fieldBytes(planner[0], 7).length) return unchanged;
    const lastText = plannerText(last.step_payload);
    if (lastText === null || !normalize(lastText)) return unchanged;

    const errorPositions: number[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].step_type === ERROR_STEP) errorPositions.push(i);
    }

    if (errorPositions.length === 0) {
      const oldError = boundary.errors.find((row) => row.index <= boundary.maximumStep && row.message === error);
      if (!oldError || rows.some((row) => !isCompletedTurnStep(row))) return unchanged;
      const donePlanners = rows.filter((row) => row.step_type === PLANNER_RESPONSE);
      if (!matchesPlannerSegments(donePlanners, result.response)) return unchanged;
      const correction: NativeTerminalCorrection = {
        kind: "historical_terminal_error", conversation_id: conversationId,
        original_status: result.status, original_error: error,
        historical_error_step: oldError.index, before_step: boundary.maximumStep,
        user_step: rows[0].idx, completed_response_step: last.idx,
        evidence: "read_only_native_steps", current_turn_status: "SUCCESS",
      };
      return { result: { ...result, status: "SUCCESS", error: undefined }, correction };
    }

    const lastErrorPos = errorPositions[errorPositions.length - 1];
    if (lastErrorPos >= rows.length - 1) return unchanged;
    const inTurnErrors: { index: number; message: string }[] = [];
    for (const pos of errorPositions) {
      const step = rows[pos];
      if (step.status !== DONE || !hasNoErrorDetails(step.error_details)) return unchanged;
      const message = fieldText(step.step_payload, [24, 3, 2]);
      if (typeof message !== "string" || !isRetryableApiError(message)) return unchanged;
      inTurnErrors.push({ index: step.idx, message });
    }
    const matchedError =
      inTurnErrors.find((row) => row.message === error) ??
      boundary.errors.find((row) => row.index <= boundary.maximumStep && row.message === error);
    if (!matchedError) return unchanged;

    for (let i = 0; i < lastErrorPos; i += 1) {
      const row = rows[i];
      if (row.step_type === ERROR_STEP) continue;
      if (!isCompletedTurnStep(row) && !isClearedPreErrorStep(row)) return unchanged;
    }
    for (let i = lastErrorPos + 1; i < rows.length; i += 1) {
      if (rows[i].step_type === CHECKPOINT || !isCompletedTurnStep(rows[i])) return unchanged;
    }

    const donePlanners = rows.filter((row) => row.step_type === PLANNER_RESPONSE && row.status === DONE);
    const doneOrClearedPlanners = rows.filter(
      (row) => row.step_type === PLANNER_RESPONSE && (row.status === DONE || row.status === CLEARED),
    );
    if (
      !matchesPlannerSegments(donePlanners, result.response) &&
      !matchesPlannerSegments(doneOrClearedPlanners, result.response)
    ) {
      return unchanged;
    }
    const correction: NativeTerminalCorrection = {
      kind: "healed_in_turn_error", conversation_id: conversationId,
      original_status: result.status, original_error: error,
      historical_error_step: matchedError.index,
      in_turn_error_count: inTurnErrors.length,
      before_step: boundary.maximumStep,
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
