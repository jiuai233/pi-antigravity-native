/**
 * agy CLI request contract plus the one-shot `agy --print` rollback client.
 * The default persistent implementation lives in agy-driver.ts; both paths
 * parse NDJSON into the same AgyTurnOutcome contract.
 *
 * Every invocation hard-codes --dangerously-skip-permissions: headless agy
 * turns auto-deny any tool that needs a permission prompt, so skipping is
 * required for agy's own tools (run_command, file edits, browser) to work.
 */

import { spawn } from "node:child_process";
import { upgradeNativeConversationDb } from "../native/native-results.ts";
import { captureNativeTurnBoundary, reconcileNativeTerminal } from "../native/native-terminal.ts";
import type { AgyTurnBudget } from "../runtime/turn-budget.ts";
import { type AgyChildrenHost, killAgyTree, trackAgyChild, untrackAgyChild } from "./agy-children.ts";
import { getAgyBinary } from "./agy-diagnostics.ts";
import type { AgyExecutionMode } from "./agy-profile.ts";
import { parseAgyLine } from "./events.ts";
import { type AgyActivity, type AgyTurnOutcome, applyEvent, newTurnOutcome } from "./reducer.ts";
import { trackActiveToolStep } from "./tool-steps.ts";

/** agy reasoning effort, as accepted by `agy --effort`. */
export type AgyEffort = "low" | "medium" | "high";

export interface AgyTurnDiagnostic {
  phase: "attempt_start" | "stall" | "retry" | "attempt_end" | "historical_terminal_error" | "native_thinking_warning";
  atMs: number;
  attempt?: number;
  conversationId?: string;
  lastToolCompletedAtMs?: number;
  watchdogStartedAtMs?: number;
  lastStdoutAtMs?: number;
  lastStderrAtMs?: number;
  lastNativeThinkingAtMs?: number;
  waitLimitMs?: number;
  elapsedMs?: number;
  toolActive?: boolean;
  status?: string;
  message?: string;
}

export interface AgyTurnRequest {
  prompt: string;
  /** Resume a prior conversation; omit to start a new one. */
  conversationId?: string;
  /** agy model id, e.g. "gemini-3.7-flash". */
  model?: string;
  /** Reasoning effort for this turn (agy --effort). */
  effort?: AgyEffort;
  /** Working directory for the agy process. */
  cwd?: string;
  /** Instance-owned MCP discovery directory, added without changing cwd. */
  mcpDirectory?: string;
  /** Run timeout owned by Pi. Direct one-shot calls also pass --print-timeout. */
  timeoutMs?: number;
  /** Model-step budget: paused during Pi waits, renewed by reported tool results. */
  budget?: AgyTurnBudget;
  /** Runtime ownership, including children still alive after a terminal result. */
  childOwner?: symbol;
  /**
   * Kill the turn when the stream produces no bytes for this long (stall
   * watchdog). 0 disables it; the logical run budget still applies.
   */
  inactivityTimeoutMs?: number;
  /**
   * Stall budget while a tool step is ACTIVE — a quiet foreground tool is
   * legitimate, so silence inside a tool gets a longer leash than silence
   * between steps. Defaults to max(inactivityTimeoutMs, 300_000).
   */
  toolInactivityTimeoutMs?: number;
  signal?: AbortSignal;
  /** Real new public thinking, not display ticks or repeated database reads. */
  subscribeNativeProgress?: (listener: () => void) => () => void;
  /** Optional custom agy agent selected for this process. */
  agent?: string;
  /** Stable agy execution mode. */
  mode?: AgyExecutionMode;
  /** Effective native whitelist used for persisted filter alignment. */
  nativeTools?: string[];
  /** Non-argv bridge/catalog fingerprint used by persistent executors. */
  bridgeRevision?: string;
  /** Preflight-selected absolute binary. Normally resolved lazily. */
  binary?: string;
  /** Called with each structured activity event as tool steps stream in. */
  onActivity?: (activity: AgyActivity) => void;
  /** Durable host diagnostics; no prompt, tool arguments or response bodies. */
  onDiagnostic?: (diagnostic: AgyTurnDiagnostic) => void;
  /**
   * Called once the stream reveals the agy conversation id — before the turn
   * resolves, so callers can track it even when a turn hangs on background
   * tasks and ends in an error.
   */
  onConversation?: (conversationId: string) => void;
  /** Test seam: replaces the spawned binary. */
  spawnOverride?: typeof spawn;
}

export class AgySpawnError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = "AgySpawnError";
    this.stderr = stderr;
  }
}

/**
 * The stream went silent: the process is alive but produced no bytes within
 * the inactivity budget. Retryable — the runtime resumes the conversation
 * with a continuation prompt instead of failing the whole pi turn.
 */
export class AgyStallError extends Error {
  readonly stalledMs: number;
  readonly toolActive: boolean;

  constructor(stalledMs: number, toolActive: boolean) {
    super(
      `agy stream stalled: no events for ${Math.round(stalledMs / 1000)}s${
        toolActive ? " while a tool step was active" : ""
      }`,
    );
    this.name = "AgyStallError";
    this.stalledMs = stalledMs;
    this.toolActive = toolActive;
  }
}

function appendProcessArgs(args: string[], request: AgyTurnRequest): string[] {
  if (request.cwd) args.push("--add-dir", request.cwd);
  if (request.mcpDirectory) args.push("--add-dir", request.mcpDirectory);
  if (request.conversationId) args.push("--conversation", request.conversationId);
  if (request.model) args.push("--model", request.model);
  if (request.effort) args.push("--effort", request.effort);
  if (request.agent) args.push("--agent", request.agent);
  if (request.mode) args.push("--mode", request.mode);
  return args;
}

export function buildOneShotAgyArgs(request: AgyTurnRequest): string[] {
  const timeout = Math.ceil((request.timeoutMs ?? 600_000) / 1000);
  // --print consumes the next token, so the prompt must remain adjacent.
  return appendProcessArgs(
    [
      "--print",
      request.prompt,
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
      "--output-format",
      "stream-json",
      // A fixed CLI wall clock cannot exclude Pi tool waits. The shared
      // runtime budget enforces the same run cap for managed one-shot turns.
      ...(request.budget ? [] : ["--print-timeout", `${timeout}s`]),
    ],
    request,
  );
}

export function buildDriverAgyArgs(request: Omit<AgyTurnRequest, "prompt">): string[] {
  return appendProcessArgs(
    [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
    ],
    { ...request, prompt: "" },
  );
}

/** Kept as the public one-shot argument builder used by existing callers. */
export const buildAgyArgs = buildOneShotAgyArgs;

/** Optional host effects; omitted dependencies retain the native execution path. */
export interface AgyExecutionDependencies {
  childrenHost?: AgyChildrenHost;
  spawn?: typeof spawn;
  upgradeNativeConversationDb?: typeof upgradeNativeConversationDb;
  captureNativeTurnBoundary?: typeof captureNativeTurnBoundary;
  reconcileNativeTerminal?: typeof reconcileNativeTerminal;
}

/**
 * Run one agy turn. Resolves with the reduced outcome once the process exits
 * or the result event arrives. Rejects with AgySpawnError when the process
 * fails before producing any result event (missing binary, auth failure, …).
 */
export async function runAgyTurn(
  request: AgyTurnRequest,
  {
    childrenHost,
    spawn: spawnChild = spawn,
    upgradeNativeConversationDb: upgradeConversation = upgradeNativeConversationDb,
    captureNativeTurnBoundary: captureBoundary = captureNativeTurnBoundary,
    reconcileNativeTerminal: reconcileTerminal = reconcileNativeTerminal,
  }: AgyExecutionDependencies = {},
): Promise<AgyTurnOutcome> {
  const binary = request.binary ?? (request.spawnOverride ? "agy" : await getAgyBinary());
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      const outcome = newTurnOutcome();
      outcome.status = "ERROR";
      outcome.error = "agy turn was aborted.";
      outcome.finished = true;
      resolve(outcome);
      return;
    }
    const doSpawn = request.spawnOverride ?? spawnChild;
    if (request.conversationId && !request.spawnOverride) {
      const upgrade = upgradeConversation(request.conversationId, request.cwd, request.nativeTools);
      if (upgrade.status === "failed") {
        if (request.nativeTools?.length === 0) { reject(new AgySpawnError(upgrade.message, "")); return; }
        if (request.onActivity) request.onActivity({ type: "native_migration_warning", message: upgrade.message });
        else console.warn(upgrade.message);
      }
    }
    const nativeBoundary = request.spawnOverride ? null
      : captureBoundary(request.conversationId, request.cwd);
    const child = doSpawn(binary, buildOneShotAgyArgs(request), {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX needs an independent process group for negative-pid cleanup.
      // Windows uses taskkill /T and must stay attached to the host process
      // context so agy's PowerShell grandchildren do not open windows.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    trackAgyChild(child, request.childOwner, childrenHost);
    const outcome = newTurnOutcome();
    let stdoutBuf = "";
    let stderrBuf = "";
    const activeTools = new Set<string>();

    let settled = false;
    let untracked = false;
    let stallTimer: NodeJS.Timeout | undefined;
    let watchdogStartedAtMs = Date.now();
    let lastStdoutAtMs: number | undefined;
    let lastStderrAtMs: number | undefined;
    let lastToolCompletedAtMs: number | undefined;
    let lastNativeThinkingAtMs: number | undefined;

    const untrack = () => {
      if (untracked) return;
      untracked = true;
      untrackAgyChild(child, childrenHost);
    };

    let abortHandler: (() => void) | undefined;
    const finishLogical = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      unsubscribeBudget?.();
      unsubscribeNativeProgress?.();
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
      if (abortHandler) request.signal?.removeEventListener("abort", abortHandler);
      fn();
    };

    let unsubscribeBudget: (() => void) | undefined;
    let unsubscribeNativeProgress: (() => void) | undefined;
    const killTimer = request.budget ? undefined : setTimeout(() => {
      killAgyTree(child, childrenHost);
      untrack();
      finishLogical(() => {
        reject(
          new AgySpawnError(
            `agy turn timed out after ${Math.round((request.timeoutMs ?? 600_000) / 1000)}s`,
            stderrBuf,
          ),
        );
      });
    }, request.timeoutMs ?? 600_000);

    // Stall watchdog: any stdout/stderr bytes count as liveness (chunk level,
    // not parsed events — unknown shapes must still reset the timer). A tool
    // step that is legitimately quiet gets the longer tool budget.
    const stallBaseMs = request.inactivityTimeoutMs ?? 120_000;
    const stallToolMs = request.toolInactivityTimeoutMs ?? Math.max(stallBaseMs, 300_000);
    let rearmStall: () => void = () => {};
    if (stallBaseMs > 0) {
      const armStall = () => {
        if (settled || outcome.finished) return;
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        if (request.budget?.paused) return;
        const budgetMs = activeTools.size > 0 ? stallToolMs : stallBaseMs;
        watchdogStartedAtMs = Date.now();
        stallTimer = setTimeout(() => {
          request.onDiagnostic?.({ phase: "stall", atMs: Date.now(),
            conversationId: outcome.conversationId ?? request.conversationId,
            lastToolCompletedAtMs: request.budget?.lastToolCompletedAtMs ?? lastToolCompletedAtMs,
            watchdogStartedAtMs, lastStdoutAtMs, lastStderrAtMs, lastNativeThinkingAtMs,
            waitLimitMs: budgetMs, elapsedMs: Date.now() - watchdogStartedAtMs,
            toolActive: activeTools.size > 0 });
          killAgyTree(child, childrenHost);
          untrack();
          finishLogical(() => {
            reject(new AgyStallError(budgetMs, activeTools.size > 0));
          });
        }, budgetMs);
      };
      rearmStall = armStall;
      armStall();
      child.stdout?.on("data", () => { lastStdoutAtMs = Date.now(); armStall(); });
      child.stderr?.on("data", () => { lastStderrAtMs = Date.now(); armStall(); });
    }
    unsubscribeBudget = request.budget?.subscribe(() => rearmStall());
    unsubscribeNativeProgress = request.subscribeNativeProgress?.(() => {
      if (settled || outcome.finished) return;
      lastNativeThinkingAtMs = Date.now();
      rearmStall();
    });

    abortHandler = () => {
      killAgyTree(child, childrenHost);
      untrack();
      finishLogical(() => {
        outcome.status = "ERROR";
        outcome.error = "agy turn was aborted.";
        outcome.finished = true;
        resolve(outcome);
      });
    };
    request.signal?.addEventListener("abort", abortHandler, { once: true });

    let conversationReported = false;
    const handleParsed = (parsed: ReturnType<typeof parseAgyLine>) => {
      if (settled) return;
      if (parsed.kind === "result") {
        const reconciled = reconcileTerminal(parsed.result, nativeBoundary, request.cwd);
        if (reconciled.correction) request.onDiagnostic?.({
          phase: "historical_terminal_error", atMs: Date.now(),
          conversationId: parsed.result.conversation_id,
          status: "SUCCESS", message: JSON.stringify(reconciled.correction),
        });
        parsed = { ...parsed, result: reconciled.result };
      }
      if (!conversationReported) {
        const id =
          parsed.kind === "init"
            ? parsed.conversationId
            : parsed.kind === "step"
              ? parsed.step.conversation_id
              : parsed.kind === "result"
                ? parsed.result.conversation_id
                : undefined;
        if (id) {
          conversationReported = true;
          request.onConversation?.(id);
        }
      }
      for (const activity of applyEvent(outcome, parsed)) {
        if (activity.type === "tool_done" || activity.type === "tool_error") lastToolCompletedAtMs = Date.now();
        trackActiveToolStep(activeTools, activity);
        request.onActivity?.(activity);
      }
      if (outcome.finished) {
        // Resolve the logical turn immediately so callers are not blocked on
        // grandchildren holding stdio pipes. The child process remains tracked
        // in the global death hook registry until actual close/error/sweep.
        stdoutBuf = "";
        finishLogical(() => resolve(outcome));
        return;
      }
      // A tool-start/done flip changes the stall budget (the liveness
      // listener re-armed before this parse ran), so re-arm with the new
      // active-tool state.
      rearmStall();
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled || outcome.finished) {
        stdoutBuf = "";
        return;
      }
      stdoutBuf += chunk;
      for (;;) {
        const nl = stdoutBuf.indexOf("\n");
        if (nl < 0) break;
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleParsed(parseAgyLine(line));
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      if (settled || outcome.finished) {
        stderrBuf = "";
        return;
      }
      stderrBuf += chunk;
      if (stderrBuf.length > 8_192) stderrBuf = stderrBuf.slice(-8_192);
    });

    child.on("error", (err) => {
      untrack();
      finishLogical(() =>
        reject(
          new AgySpawnError(
            `failed to start agy (${err.message}). Install agy 1.1.22+ or set AGY_BINARY.`,
            stderrBuf,
          ),
        ),
      );
    });

    child.on("close", (code) => {
      // Flush any trailing line without a newline.
      if (!settled && stdoutBuf.trim()) {
        handleParsed(parseAgyLine(stdoutBuf));
      }
      untrack();
      finishLogical(() => {
        if (outcome.finished) {
          resolve(outcome);
          return;
        }
        const tail = stderrBuf.trim().split("\n").slice(-3).join("\n");
        reject(
          new AgySpawnError(
            `agy exited with code ${code ?? "signal"} before producing a result${
              tail ? `: ${tail}` : ""
            }`,
            stderrBuf,
          ),
        );
      });
    });
    // Abort can happen during spawn, before the listener above is installed.
    // Attach child error/close handlers first so the killed child remains observed.
    if (request.signal?.aborted) abortHandler();
  });
}
