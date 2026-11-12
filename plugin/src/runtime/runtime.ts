/**
 * Antigravity runtime: native conversation continuity and the single active turn.
 *
 * agy keeps the authoritative native history (`--conversation <id>`), so the
 * conversation is reused across turns and dropped when the cwd, model, system
 * snapshot or effective native/bridge contract changes, when Pi compacts or
 * moves the branch, or on /agy reset. The process itself lives behind an
 * {@link AgyTurnExecutor}; this class only decides what each turn sends and
 * what it commits afterwards.
 */

import { createHash } from "node:crypto";
import { type AgyChildrenHost, killOwnedAgyTrees } from "../driver/agy-children.ts";
import { AgySpawnError, AgyStallError, type AgyTurnDiagnostic, type AgyTurnRequest, notifyAgyDiagnostic } from "../driver/agy-client.ts";
import {
  type AgyExecutorSnapshot,
  type AgyRecycleCause,
  type AgyTurnExecutor,
  createAgyTurnExecutor,
} from "../driver/agy-driver.ts";
import type { AgyExecutionMode } from "../driver/agy-profile.ts";
import type { AgyTurnOutcome, AgyUsage } from "../driver/reducer.ts";
import { stallContinuationPrompt } from "../input/prompt.ts";
import { captureMaxNativeStep, countNativeUserSteps, hasUnfinishedPersistedTurn } from "../native/native-terminal.ts";
import { NativeThinkingObserver } from "../native/native-thinking.ts";
import { AgyTurnController } from "./turn.ts";
import { AgyTurnBudget } from "./turn-budget.ts";

const STALL_MAX_RETRIES = 2;
// Background-task reaping holds a delivered result's commit for up to ~1s.
// A stuck cleanup must not hold the next prompt longer than this.
const SETTLING_COMMIT_WAIT_MS = 5_000;

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function joinPrompt(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

function waitForRetryBackoff(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(false);
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isMissingConversationFailure(value: unknown): boolean {
  const text =
    value instanceof AgySpawnError
      ? `${value.message}\n${value.stderr}`
      : value instanceof Error
        ? value.message
        : String(value);
  return /conversation.{0,80}(?:not found|does not exist|missing|failed to (?:load|resume))|(?:not found|missing).{0,80}conversation/i.test(
    text,
  );
}

export class AntigravityRuntimeClosedError extends Error {
  constructor() {
    super("antigravity runtime is shut down.");
    this.name = "AntigravityRuntimeClosedError";
  }
}

export interface RestoredAntigravityConversation {
  conversationId: string;
  modelId: string;
  cwd: string;
  turns: number;
  usage: AgyUsage;
  systemPromptHash?: string;
  nativeContractHash?: string;
}

export interface AntigravityStateSnapshot {
  conversationId: string | undefined;
  model: string | undefined;
  cwd: string | undefined;
  turns: number;
  conversationUsage: AgyUsage;
  systemPromptHash?: string;
  nativeContractHash?: string;
  executor: AgyExecutorSnapshot;
}

export interface StreamTurnRequest {
  readonly prompt: string;
  /** Hash of the active Pi system snapshot loaded through agent.md. */
  readonly systemPromptHash?: string;
  /** Effective native profile and actual bridged schemas, not instance paths. */
  readonly nativeContractHash?: string;
  readonly nativeTools?: string[];
  /** Rendered custom-agent markdown body used to patch persisted AgentConfig in-place. */
  readonly agentBody?: string;
  /** Earlier chunks of active pi-branch history prefilled before the final restored turn. */
  readonly historyPrefill?: readonly string[];
  /** Effort resolved for historyPrefill ACK turns (typically "low" when supported). */
  readonly prefillEffort?: "low" | "medium" | "high";
  /** Active pi-branch history used only when a fresh agy conversation needs restoring. */
  readonly historyBootstrap?: string;
  /** Native input when it differs from the loop identity: steer text sent as a follow-up turn. */
  readonly nativeInput?: string;
  readonly modelId: string;
  readonly effort?: "low" | "medium" | "high";
  readonly agent?: string;
  readonly mode?: AgyExecutionMode;
  readonly mcpDirectory?: string;
  readonly bridgeBootstrap?: string;
  readonly bridgeRevision?: string;
  readonly signal?: AbortSignal;
}

export interface BridgeCallRequest {
  readonly id: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** Native MCP identity correlates callbacks that arrive ahead of stdout. */
  readonly nativeServerName?: string;
  readonly nativeToolName?: string;
}

export type AgyTurnRunner = (request: AgyTurnRequest) => Promise<AgyTurnOutcome>;

/** Per-turn state shared by the attempt loop, callbacks and the final commit. */
interface TurnContext {
  readonly controller: AgyTurnController;
  readonly request: StreamTurnRequest;
  readonly agentRevision: string | undefined;
  readonly generation: number;
  readonly abort: AbortController;
  readonly budget: AgyTurnBudget;
  readonly timeoutError: AgySpawnError;
  readonly resumingPersisted: boolean;
  readonly bridgeBootstrap: string | undefined;
  readonly freshRestorePrefill: readonly string[];
  readonly freshRestorePrompt: string;
  readonly thinking: NativeThinkingObserver;
  hadRestorePending: boolean;
  priorSystemPromptHash: string | undefined;
  priorNativeContractHash: string | undefined;
  startedFreshConversation: boolean;
  prefillCompleted: boolean;
  realTurnBaselineSteps: number;
  preTurnMaxStep: number | null;
  migrationFailed: boolean;
  restoredAttemptActive: boolean;
  restoredResultMissing: boolean;
  attemptNumber: number;
  attemptStartedAtMs: number;
}

export class AntigravityRuntime {
  readonly #executor: AgyTurnExecutor;
  readonly #onDiagnostic: ((event: AgyTurnDiagnostic) => void) | undefined;
  readonly #childOwner = Symbol("antigravity-runtime");
  #closed = false;

  // Native conversation continuity.
  #conversationId: string | undefined;
  /** Terminal usage counters from the last turn; agy reports them cumulatively on resume. */
  #conversationUsage: AgyUsage = {};
  /** The cwd the conversation was created in — agy pins conversations to their workspace. */
  #conversationCwd: string | undefined;
  #model: string | undefined;
  // pi loads extensions with the session directory as process cwd; session_start
  // refreshes this, but the default keeps print mode and early turns correct.
  #cwd: string | undefined = process.cwd();
  #turns = 0;
  // The first agy turn may follow work with another provider. Only an
  // explicit reset suppresses history on a fresh conversation.
  #restoreHistoryOnNextConversation = true;
  #restoredConversationPending = false;
  #lastSystemPromptHash: string | undefined;
  #lastNativeContractHash: string | undefined;
  /** One-shot marker when a turn failed after persisting USER_INPUT without finishing. */
  #pendingRetryContinuation: { conversationId: string; prompt: string; beforeStep: number } | undefined;

  // The active turn. Every superseded turn bumps the generation; late
  // callbacks and commits from older generations are discarded.
  #generation = 0;
  #active: AgyTurnController | undefined;
  /** Commit of the active turn's conversation id, usage and turn count. */
  #activeCompletion: Promise<void> | undefined;
  /** Active turn whose terminal result reached Pi while its commit is pending. */
  #settling: AgyTurnController | undefined;
  /** Active turn whose provider stream ended without its result (failure/abort): never steered. */
  #detached: AgyTurnController | undefined;
  /** Aborts the in-flight agy child process when the turn is superseded or the runtime closes. */
  #activeAbort: AbortController | undefined;
  #activeBudget: AgyTurnBudget | undefined;
  #activeThinking: NativeThinkingObserver | undefined;
  #activePrefilling = false;

  readonly #childrenHost: AgyChildrenHost | undefined;

  constructor(
    executor: AgyTurnExecutor,
    onDiagnostic?: (event: AgyTurnDiagnostic) => void,
    childrenHost?: AgyChildrenHost,
  ) {
    this.#executor = executor;
    this.#onDiagnostic = onDiagnostic;
    this.#childrenHost = childrenHost;
  }

  async setSession(sessionCwd: string, modelId: string | undefined, restoreFromPiContext = false): Promise<void> {
    this.#ensureOpen();
    const cwdChanged = this.#cwd !== sessionCwd;
    const modelChanged = modelId !== undefined && this.#model !== undefined && this.#model !== modelId;
    this.#cwd = sessionCwd;
    if (modelId !== undefined) this.#model = modelId;
    if (restoreFromPiContext || cwdChanged || modelChanged) {
      await this.#recycle("recycle", restoreFromPiContext ? "session-tree" : cwdChanged ? "cwd" : "model");
    }
    if (restoreFromPiContext) {
      this.#forgetConversation(true);
      this.#turns = 0;
      this.#lastSystemPromptHash = undefined;
    }
  }

  /** Restore a persisted native agy conversation owned by this Pi session. */
  async restoreConversation(state: RestoredAntigravityConversation): Promise<void> {
    this.#ensureOpen();
    await this.#recycle("recycle", "restore");
    this.#pendingRetryContinuation = undefined;
    this.#conversationId = state.conversationId;
    this.#conversationUsage = { ...state.usage };
    this.#conversationCwd = state.cwd;
    this.#model = state.modelId;
    this.#cwd = state.cwd;
    this.#turns = state.turns;
    this.#restoreHistoryOnNextConversation = false;
    this.#restoredConversationPending = true;
    this.#lastSystemPromptHash = state.systemPromptHash;
    this.#lastNativeContractHash = state.nativeContractHash;
  }

  /**
   * Start a new agy turn or re-attach to the active one. Re-attachment
   * happens when pi re-invokes the provider after a tool-use turn: the same
   * prompt maps to the still-running (or finished-but-unconsumed) controller.
   */
  async beginStreamTurn(request: StreamTurnRequest): Promise<AgyTurnController> {
    this.#ensureOpen();
    const pending = this.#settlingCommitWait(request.signal);
    if (pending) {
      await pending;
      this.#ensureOpen();
    }
    return this.#attachOrStart(request);
  }

  /** Clear the active controller once a provider turn reached a terminal state. */
  finishTurn(): void {
    const active = this.#active;
    if (active?.isClosed()) {
      this.#active = undefined;
      this.#activeCompletion = undefined;
      this.#settling = undefined;
    } else if (active?.terminalDelivered()) {
      // The result reached Pi before the outcome commit; the next prompt
      // waits for that commit instead of discarding it.
      this.#settling = active;
    } else if (active) {
      // The stream failed before the result: a same-context retry may still
      // re-attach, but a different prompt replaces this turn.
      this.#detached = active;
    }
  }

  /**
   * A provider call re-entered while agy is still working on the active turn.
   * A different prompt is a Pi steer: keep the agy process and queue it for
   * the turn's next input. Returns the live turn (its pending steer included),
   * or undefined when there is no turn to continue.
   */
  steerActiveTurn(prompt: string): AgyTurnController | undefined {
    if (this.#closed) return undefined;
    const live = this.#attachable();
    if (!live || live === this.#detached) return undefined;
    live.adoptSteer(prompt);
    return live;
  }

  /**
   * Route a bridged agy MCP call into the live turn controller as a
   * synthetic bridge_call activity. Returns false when no turn is active
   * (the bridge then fails the MCP call closed).
   */
  pushBridgeCall(call: BridgeCallRequest): boolean {
    if (this.#closed || !this.#active || this.#active.isClosed() || this.#activePrefilling) return false;
    this.#activeThinking?.flush();
    this.#active.beginNativeThinkingBridge(call.id, call.nativeServerName, call.nativeToolName);
    this.#activeBudget?.pause(call.id);
    this.#active.push({ type: "bridge_call", id: call.id, name: call.tool, args: call.args });
    return true;
  }

  /** Resume the run budget once a pending Pi bridge call settles. */
  finishBridgeCall(id: string): void {
    this.#activeBudget?.resume(id, true);
  }

  async abortTurn(): Promise<void> {
    this.#ensureOpen();
    this.#pendingRetryContinuation = undefined;
    await this.#recycle("abort");
  }

  async reset(): Promise<void> {
    this.#ensureOpen();
    await this.#recycle("recycle", "reset");
    this.#forgetConversation(false);
    this.#turns = 0;
    this.#lastSystemPromptHash = undefined;
  }

  snapshot(): AntigravityStateSnapshot {
    this.#ensureOpen();
    return {
      conversationId: this.#conversationId,
      model: this.#model,
      cwd: this.#cwd,
      turns: this.#turns,
      conversationUsage: { ...this.#conversationUsage },
      systemPromptHash: this.#lastSystemPromptHash,
      nativeContractHash: this.#lastNativeContractHash,
      executor: this.#executor.snapshot(),
    };
  }

  async close(): Promise<void> {
    this.#ensureOpen();
    this.#closed = true;
    this.#pendingRetryContinuation = undefined;
    this.#conversationId = undefined;
    this.#conversationUsage = {};
    this.#conversationCwd = undefined;
    this.#restoredConversationPending = false;
    this.#lastSystemPromptHash = undefined;
    try {
      await this.#recycle("shutdown");
    } finally {
      killOwnedAgyTrees(this.#childOwner, this.#childrenHost);
    }
  }

  // --- conversation state ---------------------------------------------------

  #ensureOpen(): void {
    if (this.#closed) throw new AntigravityRuntimeClosedError();
  }

  #forgetConversation(restoreHistory: boolean): void {
    this.#pendingRetryContinuation = undefined;
    this.#conversationId = undefined;
    this.#conversationUsage = {};
    this.#conversationCwd = undefined;
    this.#restoreHistoryOnNextConversation = restoreHistory;
    this.#restoredConversationPending = false;
  }

  /** Drop a conversation the next request cannot resume; true when one was discarded. */
  #alignConversation(request: StreamTurnRequest): boolean {
    let dropped = false;
    // agy pins a conversation to the workspace it was created in: resuming it
    // from another directory silently writes into the OLD workspace (verified
    // 2026-08-21) or rejects writes with "not a valid artifact path".
    if (this.#conversationId && this.#conversationCwd !== this.#cwd) {
      dropped = true;
      this.#forgetConversation(true);
    }
    if (this.#model !== undefined && this.#model !== request.modelId) {
      if (this.#conversationId) dropped = true;
      this.#forgetConversation(true);
    }
    // When prepareAgent supplies agentBody, upgradeNativeConversationDb patches
    // persisted AgentConfig PromptSections + ToolFilters in-place on driver
    // recycle, so prompt/contract changes keep the native conversation alive.
    if (
      this.#conversationId &&
      request.agentBody === undefined &&
      (request.systemPromptHash !== this.#lastSystemPromptHash ||
        request.nativeContractHash !== this.#lastNativeContractHash)
    ) {
      dropped = true;
      this.#forgetConversation(true);
      this.#lastSystemPromptHash = undefined;
    }
    return dropped;
  }

  // --- active turn ----------------------------------------------------------

  #invalidateActiveTurn(): void {
    this.#activeThinking?.close();
    this.#activeThinking = undefined;
    this.#activePrefilling = false;
    this.#generation += 1;
    this.#activeAbort?.abort();
    this.#activeAbort = undefined;
    this.#activeBudget?.dispose();
    this.#activeBudget = undefined;
    this.#active = undefined;
    this.#activeCompletion = undefined;
    this.#settling = undefined;
    this.#detached = undefined;
  }

  async #recycle(reason: "recycle" | "abort" | "shutdown" = "recycle", cause?: AgyRecycleCause): Promise<void> {
    const state = this.#executor.snapshot().state;
    if (state === "starting" || state === "ready" || state === "running") {
      notifyAgyDiagnostic(this.#onDiagnostic, { phase: "driver_recycle", atMs: Date.now(), conversationId: this.#conversationId, message: cause ?? reason });
    }
    this.#invalidateActiveTurn();
    await this.#executor.close(reason, cause);
  }

  /** Superseding a settling turn would fence its commit; wait for it, bounded. */
  #settlingCommitWait(signal?: AbortSignal): Promise<void> | undefined {
    const completion = this.#activeCompletion;
    const settling = this.#settling;
    if (!settling || settling !== this.#active || settling.isClosed() || !completion) return undefined;
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      timer = setTimeout(done, SETTLING_COMMIT_WAIT_MS);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
      void completion.then(done, done);
    });
  }

  /** The turn a re-entering provider call continues: running or holding buffered events. */
  #attachable(): AgyTurnController | undefined {
    const active = this.#active;
    // A settling turn already delivered its terminal result; never re-attach
    // a new prompt to it, even when the text repeats.
    if (!active || active === this.#settling) return undefined;
    return !active.isClosed() || active.hasPending() ? active : undefined;
  }

  #attachOrStart(request: StreamTurnRequest): AgyTurnController {
    const live = this.#attachable();
    if (live && live.prompt === request.prompt) {
      if (live === this.#detached) this.#detached = undefined;
      return live;
    }
    // A steer joins the live turn; agy is not cancelled to deliver it.
    const steered = this.steerActiveTurn(request.prompt);
    if (steered) return steered;
    if (this.#active) this.#invalidateActiveTurn();
    const droppedConversation = this.#alignConversation(request);
    this.#model = request.modelId;
    return this.#startTurn(request, droppedConversation);
  }

  #startTurn(request: StreamTurnRequest, droppedConversation: boolean): AgyTurnController {
    const controller = new AgyTurnController(request.prompt, this.#conversationUsage, request.effort);
    this.#active = controller;
    // Queued ahead of any usage, so index forgets the old context size
    // instead of recording the fresh conversation as compaction.
    if (droppedConversation) controller.push({ type: "conversation_fallback" });
    // Compose pi's request signal with our own so close() can kill the agy
    // child even when pi's signal never fires.
    const abort = new AbortController();
    this.#activeAbort = abort;
    const generation = this.#generation;
    let requestAbortHandler: (() => void) | undefined;
    if (request.signal) {
      if (request.signal.aborted) abort.abort();
      else {
        requestAbortHandler = () => abort.abort();
        request.signal.addEventListener("abort", requestAbortHandler, { once: true });
      }
    }
    const startedFreshConversation = this.#conversationId === undefined;
    const pendingRetry = this.#pendingRetryContinuation;
    this.#pendingRetryContinuation = undefined;
    const useRetryContinuation =
      !droppedConversation &&
      !startedFreshConversation &&
      request.nativeInput === undefined &&
      pendingRetry !== undefined &&
      this.#conversationId === pendingRetry.conversationId &&
      request.prompt === pendingRetry.prompt &&
      hasUnfinishedPersistedTurn(pendingRetry.conversationId, pendingRetry.beforeStep, this.#cwd);
    const resumingPersisted = this.#restoredConversationPending && this.#conversationId !== undefined;
    const bridgeBootstrap = resumingPersisted ? request.bridgeBootstrap : undefined;
    const shouldRestoreFresh = startedFreshConversation && this.#restoreHistoryOnNextConversation;
    const initialPrefill = shouldRestoreFresh ? (request.historyPrefill ?? []) : [];
    const historyBootstrap = shouldRestoreFresh ? request.historyBootstrap : undefined;
    const preTurnMaxStep = initialPrefill.length === 0
      ? captureMaxNativeStep(this.#conversationId, this.#cwd)
      : null;
    const agentRevision =
      request.agentBody !== undefined
        ? createHash("sha256")
            .update(request.agentBody)
            .update("\0")
            .update(request.nativeContractHash ?? "")
            .digest("hex")
        : undefined;
    const timeoutMs = envInt("AGY_TURN_TIMEOUT_MS", 0);
    const timeoutError = new AgySpawnError(
      `agy logical turn timed out after ${Math.round(timeoutMs / 1000)}s without a completed tool step`,
      "",
    );
    const budget = new AgyTurnBudget(timeoutMs, () => abort.abort(timeoutError));
    this.#activeBudget = budget;
    let turn!: TurnContext;
    const thinking = new NativeThinkingObserver({
      cwd: this.#cwd,
      onSnapshot: snapshot => {
        if (!this.#isCurrent(turn) || abort.signal.aborted) return true;
        return controller.acceptNativeThinking(snapshot);
      },
      onDiagnostic: message => this.#report(turn, { phase: "native_thinking_warning", atMs: Date.now(), message }),
    });
    turn = {
      controller,
      request,
      agentRevision,
      generation,
      abort,
      budget,
      timeoutError,
      resumingPersisted,
      bridgeBootstrap,
      freshRestorePrefill: request.historyPrefill ?? [],
      freshRestorePrompt: joinPrompt([request.historyBootstrap, request.nativeInput ?? request.prompt]),
      thinking,
      hadRestorePending: this.#restoreHistoryOnNextConversation,
      priorSystemPromptHash: this.#lastSystemPromptHash,
      priorNativeContractHash: this.#lastNativeContractHash,
      startedFreshConversation,
      prefillCompleted: initialPrefill.length === 0,
      realTurnBaselineSteps: 0,
      preTurnMaxStep,
      migrationFailed: false,
      restoredAttemptActive: resumingPersisted,
      restoredResultMissing: false,
      attemptNumber: 0,
      attemptStartedAtMs: Date.now(),
    };
    this.#activeThinking = thinking;
    if (initialPrefill.length === 0) thinking.prepare(this.#conversationId);
    let onTurnAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onTurnAbort = () => {
        thinking.close();
        reject(this.#abortFailure(turn));
      };
      abort.signal.addEventListener("abort", onTurnAbort, { once: true });
      if (abort.signal.aborted) onTurnAbort();
    });
    // Keep the controller's user-prompt identity unchanged on Pi tool-loop
    // re-entry; rebind only at the native request boundary.
    const effectiveTurnInput = useRetryContinuation
      ? stallContinuationPrompt()
      : (request.nativeInput ?? request.prompt);
    if (useRetryContinuation) {
      this.#report(turn, {
        phase: "retry_continuation",
        atMs: Date.now(),
        conversationId: this.#conversationId,
        message: "Replaced duplicate retry prompt with continuation prompt.",
      });
    }
    const spawnRequest = this.#spawnRequest(
      turn,
      joinPrompt([historyBootstrap, bridgeBootstrap, effectiveTurnInput]),
      timeoutMs,
    );
    // A non-cooperative executor/preflight cannot hold the provider open past
    // cancellation; its late callbacks are fenced by generation. race attaches
    // rejection handlers to both inputs, including the loser.
    this.#activeCompletion = Promise.race([
      this.#executeTurn(turn, initialPrefill, spawnRequest, timeoutMs),
      cancelled,
    ])
      .then((outcome: AgyTurnOutcome) => this.#commit(turn, outcome))
      .catch((cause: unknown) => this.#failTurn(turn, cause))
      .finally(() => {
        thinking.close();
        if (this.#activeThinking === thinking) this.#activeThinking = undefined;
        if (this.#isCurrent(turn)) this.#activePrefilling = false;
        budget.dispose();
        if (this.#activeBudget === budget) this.#activeBudget = undefined;
        abort.signal.removeEventListener("abort", onTurnAbort);
        if (requestAbortHandler) request.signal?.removeEventListener("abort", requestAbortHandler);
        if (this.#activeAbort === abort) this.#activeAbort = undefined;
      });
    return controller;
  }

  async #executeTurn(
    turn: TurnContext,
    initialPrefill: readonly string[],
    spawnRequest: AgyTurnRequest,
    timeoutMs: number,
  ): Promise<AgyTurnOutcome> {
    if (initialPrefill.length > 0) {
      await this.#runPrefillChunks(turn, initialPrefill, timeoutMs);
      turn.realTurnBaselineSteps = this.#conversationId
        ? (countNativeUserSteps(this.#conversationId, this.#cwd) ?? 0)
        : 0;
      turn.preTurnMaxStep = captureMaxNativeStep(this.#conversationId, this.#cwd);
      turn.prefillCompleted = true;
      turn.thinking.prepare(this.#conversationId);
      spawnRequest = { ...spawnRequest, conversationId: this.#conversationId };
    }
    return this.#runWithRetries(turn, spawnRequest, timeoutMs);
  }

  async #runPrefillChunks(turn: TurnContext, chunks: readonly string[], timeoutMs: number): Promise<void> {
    this.#activePrefilling = true;
    try {
      for (const chunkPrompt of chunks) {
        const chunkBaselineSteps = this.#conversationId
          ? (countNativeUserSteps(this.#conversationId, this.#cwd) ?? 0)
          : 0;
        const stepRequest = this.#prefillSpawnRequest(turn, chunkPrompt, timeoutMs);
        const outcome = await this.#runPrefillStepWithRetries(turn, stepRequest, chunkBaselineSteps);
        if (outcome.status === "ERROR") {
          throw new AgySpawnError(outcome.error || "agy history prefill turn failed.", "");
        }
        if (outcome.conversationId) {
          this.#conversationId = outcome.conversationId;
          this.#conversationCwd = this.#cwd;
        }
        if (outcome.usage) {
          this.#conversationUsage = { ...outcome.usage };
          turn.controller.resetConversationUsage(this.#conversationUsage);
        }
        turn.budget.renew();
      }
    } finally {
      if (this.#isCurrent(turn)) this.#activePrefilling = false;
    }
  }

  #prefillSpawnRequest(turn: TurnContext, prompt: string, timeoutMs: number): AgyTurnRequest {
    const { request } = turn;
    return {
      prompt,
      conversationId: this.#conversationId,
      model: request.modelId,
      effort: request.prefillEffort ?? request.effort,
      agent: request.agent,
      ...(request.agentBody !== undefined ? { agentBody: request.agentBody } : {}),
      ...(turn.agentRevision !== undefined ? { agentRevision: turn.agentRevision } : {}),
      mode: request.mode,
      mcpDirectory: request.mcpDirectory,
      bridgeRevision: request.bridgeRevision,
      nativeTools: request.nativeTools,
      cwd: this.#cwd,
      timeoutMs,
      budget: turn.budget,
      childOwner: this.#childOwner,
      inactivityTimeoutMs: envInt("AGY_STALL_TIMEOUT_MS", 300_000),
      toolInactivityTimeoutMs: envInt("AGY_TOOL_STALL_TIMEOUT_MS", 600_000),
      signal: turn.abort.signal,
      onConversation: (id) => {
        if (!this.#isCurrent(turn) || turn.abort.signal.aborted) return;
        this.#restoreHistoryOnNextConversation = false;
        this.#conversationId = id;
        this.#conversationCwd = this.#cwd;
        if (!turn.migrationFailed) {
          this.#lastSystemPromptHash = request.systemPromptHash;
          this.#lastNativeContractHash = request.nativeContractHash;
        }
        turn.controller.bindNativeConversation(id);
      },
      onDiagnostic: (event) => this.#report(turn, event),
      onActivity: (activity) => {
        if (!this.#isCurrent(turn) || turn.abort.signal.aborted) return;
        if (activity.type === "tool_done" || activity.type === "tool_error") turn.budget.renew();
        if (activity.type === "native_migration_warning") {
          turn.migrationFailed = true;
          turn.controller.push(activity);
        }
      },
    };
  }

  async #runPrefillStepWithRetries(
    turn: TurnContext,
    stepRequest: AgyTurnRequest,
    chunkBaselineSteps: number,
  ): Promise<AgyTurnOutcome> {
    const { controller, budget, abort } = turn;
    let retry = 0;
    for (;;) {
      if (abort.signal.aborted) throw this.#abortFailure(turn);
      const remainingMs = budget.remainingMs();
      if (remainingMs <= 0) throw turn.timeoutError;
      const resumableConversationId = this.#conversationId ?? stepRequest.conversationId;
      const resumingRetry = retry > 0 && resumableConversationId !== undefined;
      let retryPrompt = stepRequest.prompt;
      if (resumingRetry) {
        const persisted = countNativeUserSteps(resumableConversationId, this.#cwd);
        const chunkPersisted = persisted !== null && persisted > chunkBaselineSteps;
        if (chunkPersisted) {
          retryPrompt =
            "The stream was interrupted before your previous turn completed. Do not call any tools; reply with `ACK` only.";
        }
      }
      const attempt: AgyTurnRequest = {
        ...stepRequest,
        prompt: retryPrompt,
        conversationId: resumableConversationId,
        timeoutMs: Number.isFinite(remainingMs) ? remainingMs : 0,
        inactivityTimeoutMs:
          resumingRetry && stepRequest.inactivityTimeoutMs !== 0
            ? Math.max(stepRequest.inactivityTimeoutMs ?? 300_000, stepRequest.toolInactivityTimeoutMs ?? 600_000)
            : stepRequest.inactivityTimeoutMs,
      };
      turn.attemptNumber += 1;
      turn.attemptStartedAtMs = Date.now();
      this.#report(turn, { phase: "attempt_start", atMs: turn.attemptStartedAtMs, waitLimitMs: attempt.inactivityTimeoutMs });
      try {
        const outcome = await this.#executor.run(attempt);
        if (abort.signal.aborted) throw this.#abortFailure(turn);
        return outcome;
      } catch (error) {
        if (abort.signal.aborted) throw this.#abortFailure(turn);
        if (!(error instanceof AgyStallError) || retry >= STALL_MAX_RETRIES) throw error;
        retry += 1;
        this.#report(turn, {
          phase: "retry",
          atMs: Date.now(),
          attempt: turn.attemptNumber + 1,
          elapsedMs: Date.now() - turn.attemptStartedAtMs,
          message: error.message,
        });
        controller.push({
          type: "stall",
          retry,
          maxRetries: STALL_MAX_RETRIES,
          stalledMs: error.stalledMs,
          toolActive: error.toolActive,
        });
        const backoffMs = envInt("AGY_STALL_RETRY_BACKOFF_MS", 3_000);
        if (!(await waitForRetryBackoff(backoffMs, abort.signal))) throw this.#abortFailure(turn);
      }
    }
  }

  #spawnRequest(turn: TurnContext, prompt: string, timeoutMs: number): AgyTurnRequest {
    const { request } = turn;
    return {
      prompt,
      conversationId: this.#conversationId,
      model: request.modelId,
      effort: request.effort,
      agent: request.agent,
      ...(request.agentBody !== undefined ? { agentBody: request.agentBody } : {}),
      ...(turn.agentRevision !== undefined ? { agentRevision: turn.agentRevision } : {}),
      mode: request.mode,
      mcpDirectory: request.mcpDirectory,
      bridgeRevision: request.bridgeRevision,
      nativeTools: request.nativeTools,
      cwd: this.#cwd,
      timeoutMs,
      budget: turn.budget,
      childOwner: this.#childOwner,
      inactivityTimeoutMs: envInt("AGY_STALL_TIMEOUT_MS", 300_000),
      toolInactivityTimeoutMs: envInt("AGY_TOOL_STALL_TIMEOUT_MS", 600_000),
      signal: turn.abort.signal,
      subscribeNativeProgress: listener => turn.controller.subscribeNativeProgress(listener),
      onConversation: (id) => {
        if (!this.#isCurrent(turn) || turn.abort.signal.aborted) return;
        this.#restoreHistoryOnNextConversation = false;
        // Track eagerly — a turn hung on a background task may never resolve,
        // and /agy-tasks needs the id meanwhile.
        this.#conversationId = id;
        this.#conversationCwd = this.#cwd;
        if (!turn.migrationFailed) {
          this.#lastSystemPromptHash = request.systemPromptHash;
          this.#lastNativeContractHash = request.nativeContractHash;
        }
        turn.controller.bindNativeConversation(id);
        turn.thinking.bind(id);
      },
      onDiagnostic: (event) => this.#report(turn, event),
      onActivity: (activity) => {
        if (!this.#isCurrent(turn) || turn.abort.signal.aborted) return;
        if (activity.type === "tool_done" || activity.type === "tool_error") turn.budget.renew();
        if (activity.type === "native_migration_warning") {
          turn.migrationFailed = true;
          this.#lastSystemPromptHash = turn.priorSystemPromptHash;
          this.#lastNativeContractHash = turn.priorNativeContractHash;
        }
        if (
          turn.restoredAttemptActive &&
          activity.type === "result" &&
          activity.status === "ERROR" &&
          isMissingConversationFailure(activity.error)
        ) {
          // Do not expose a recoverable stale-resume error to Pi; the attempt
          // loop retries with bounded branch history.
          turn.restoredResultMissing = true;
          return;
        }
        turn.controller.prepareNativeThinking(activity);
        turn.thinking.flush();
        if (activity.type === "response_end") turn.controller.finishNativeThinkingResponse(activity.stepId);
        else if (activity.type === "tool_start") turn.controller.beginNativeThinkingTool(activity);
        else if (activity.type === "result") {
          turn.controller.sealNativeThinking();
          turn.thinking.close();
        }
        turn.controller.push(activity);
        if (activity.type === "tool_done" || activity.type === "tool_error") {
          turn.controller.finishNativeThinkingTool(activity.stepId);
          turn.thinking.flush();
        }
      },
    };
  }

  /**
   * A stalled stream is recoverable: agy still holds the full conversation
   * server-side, so each retry resumes it with a continuation prompt instead
   * of re-bootstrapping pi history. Without a resumable conversation id (e.g.
   * stalled before init) the original prompt is retried. Only AgyStallError
   * retries — spawn/auth failures would fail identically again. A restored
   * conversation that disappeared falls back once to a fresh bootstrap.
   */
  async #runWithRetries(
    turn: TurnContext,
    spawnRequest: AgyTurnRequest,
    timeoutMs: number,
  ): Promise<AgyTurnOutcome> {
    const { controller, budget, abort } = turn;
    let retry = 0;
    let freshFallback = false;
    const startFreshFallback = async () => {
      turn.restoredAttemptActive = false;
      turn.startedFreshConversation = true;
      turn.hadRestorePending = true;
      turn.priorSystemPromptHash = undefined;
      turn.priorNativeContractHash = undefined;
      turn.realTurnBaselineSteps = 0;
      turn.preTurnMaxStep = -1;
      turn.prefillCompleted = turn.freshRestorePrefill.length === 0;
      turn.migrationFailed = false;
      controller.push({ type: "conversation_fallback" });
      controller.resetConversationUsage({});
      turn.thinking.close();
      this.#forgetConversation(true);
      this.#lastSystemPromptHash = undefined;
      this.#lastNativeContractHash = undefined;
      freshFallback = true;
      retry = 0;
      if (turn.freshRestorePrefill.length > 0) {
        await this.#runPrefillChunks(turn, turn.freshRestorePrefill, timeoutMs);
        turn.realTurnBaselineSteps = this.#conversationId
          ? (countNativeUserSteps(this.#conversationId, this.#cwd) ?? 0)
          : 0;
        turn.preTurnMaxStep = captureMaxNativeStep(this.#conversationId, this.#cwd);
        turn.prefillCompleted = true;
      }
      turn.thinking.prepare(this.#conversationId);
    };
    for (;;) {
      if (abort.signal.aborted) throw this.#abortFailure(turn);
      const remainingMs = budget.remainingMs();
      if (remainingMs <= 0) throw turn.timeoutError;
      // After a stale-resume fallback, never resurrect the missing original
      // ID if the fresh attempt stalls before init.
      const resumableConversationId = freshFallback
        ? this.#conversationId
        : (this.#conversationId ?? spawnRequest.conversationId);
      const resumingRetry = retry > 0 && resumableConversationId !== undefined;
      const attempt: AgyTurnRequest = {
        ...spawnRequest,
        prompt: resumingRetry
          ? joinPrompt([turn.bridgeBootstrap, stallContinuationPrompt()])
          : freshFallback
            ? turn.freshRestorePrompt
            : spawnRequest.prompt,
        conversationId: resumableConversationId,
        timeoutMs: Number.isFinite(remainingMs) ? remainingMs : 0,
        // Only known-conversation recovery gets the tool-sized silence
        // allowance; the ordinary stream watchdog stays unchanged.
        inactivityTimeoutMs:
          resumingRetry && spawnRequest.inactivityTimeoutMs !== 0
            ? Math.max(spawnRequest.inactivityTimeoutMs ?? 300_000, spawnRequest.toolInactivityTimeoutMs ?? 600_000)
            : spawnRequest.inactivityTimeoutMs,
        onConversation: spawnRequest.onConversation,
      };
      turn.attemptNumber += 1;
      turn.attemptStartedAtMs = Date.now();
      this.#report(turn, { phase: "attempt_start", atMs: turn.attemptStartedAtMs, waitLimitMs: attempt.inactivityTimeoutMs });
      try {
        const outcome = await this.#executor.run(attempt);
        // A cancelled race loser must not clear a newer turn's conversation
        // while processing a delayed fallback result.
        if (abort.signal.aborted) throw this.#abortFailure(turn);
        if (turn.resumingPersisted && !freshFallback && turn.restoredResultMissing) {
          await startFreshFallback();
          continue;
        }
        return outcome;
      } catch (error) {
        if (abort.signal.aborted) throw this.#abortFailure(turn);
        if (turn.resumingPersisted && !freshFallback && isMissingConversationFailure(error)) {
          await startFreshFallback();
          continue;
        }
        if (!(error instanceof AgyStallError) || retry >= STALL_MAX_RETRIES) throw error;
        retry += 1;
        this.#report(turn, {
          phase: "retry",
          atMs: Date.now(),
          attempt: turn.attemptNumber + 1,
          elapsedMs: Date.now() - turn.attemptStartedAtMs,
          message: error.message,
        });
        controller.push({
          type: "stall",
          retry,
          maxRetries: STALL_MAX_RETRIES,
          stalledMs: error.stalledMs,
          toolActive: error.toolActive,
        });
        const backoffMs = envInt("AGY_STALL_RETRY_BACKOFF_MS", 3_000);
        if (!(await waitForRetryBackoff(backoffMs, abort.signal))) throw this.#abortFailure(turn);
      }
    }
  }

  #commit(turn: TurnContext, outcome: AgyTurnOutcome): void {
    if (!this.#isCurrent(turn)) {
      turn.controller.close();
      return;
    }
    this.#report(turn, {
      phase: "attempt_end",
      atMs: Date.now(),
      status: outcome.status,
      elapsedMs: Date.now() - turn.attemptStartedAtMs,
      message: outcome.error,
    });
    if (
      outcome.status === "ERROR" &&
      turn.startedFreshConversation &&
      !this.#isFreshRealTurnPersisted(turn, outcome.conversationId ?? this.#conversationId)
    ) {
      this.#rollbackUnpersistedFreshTurn(turn);
      turn.controller.close();
      return;
    }
    if (outcome.status === "ERROR" && !turn.abort.signal.aborted) {
      const candidateId = outcome.conversationId ?? this.#conversationId;
      if (candidateId && turn.preTurnMaxStep !== null && hasUnfinishedPersistedTurn(candidateId, turn.preTurnMaxStep, this.#cwd)) {
        this.#pendingRetryContinuation = {
          conversationId: candidateId,
          prompt: turn.request.prompt,
          beforeStep: turn.preTurnMaxStep,
        };
      }
    }
    this.#turns += 1;
    if (outcome.conversationId) {
      this.#conversationId = outcome.conversationId;
      this.#restoreHistoryOnNextConversation = false;
      if (!turn.migrationFailed) {
        this.#lastSystemPromptHash = turn.request.systemPromptHash;
        this.#lastNativeContractHash = turn.request.nativeContractHash;
      }
    }
    if (outcome.usage) this.#conversationUsage = { ...outcome.usage };
    this.#restoredConversationPending = false;
    turn.controller.close();
  }

  #isFreshRealTurnPersisted(turn: TurnContext, candidateId: string | undefined): boolean {
    if (!turn.prefillCompleted || !candidateId) return false;
    const persistedSteps = countNativeUserSteps(candidateId, this.#cwd);
    return persistedSteps !== null && persistedSteps > turn.realTurnBaselineSteps;
  }

  #rollbackUnpersistedFreshTurn(turn: TurnContext): void {
    this.#forgetConversation(turn.hadRestorePending);
    this.#lastSystemPromptHash = turn.priorSystemPromptHash;
    this.#lastNativeContractHash = turn.priorNativeContractHash;
  }

  #failTurn(turn: TurnContext, cause: unknown): void {
    if (!turn.abort.signal.aborted && this.#isCurrent(turn)) turn.thinking.flush();
    turn.thinking.close();
    if (!this.#isCurrent(turn)) {
      turn.controller.close();
      return;
    }
    if (turn.startedFreshConversation && !this.#isFreshRealTurnPersisted(turn, this.#conversationId)) {
      this.#rollbackUnpersistedFreshTurn(turn);
    } else if (!turn.abort.signal.aborted && this.#conversationId && turn.preTurnMaxStep !== null) {
      if (hasUnfinishedPersistedTurn(this.#conversationId, turn.preTurnMaxStep, this.#cwd)) {
        this.#pendingRetryContinuation = {
          conversationId: this.#conversationId,
          prompt: turn.request.prompt,
          beforeStep: turn.preTurnMaxStep,
        };
      }
    }
    this.#report(turn, {
      phase: "attempt_end",
      atMs: Date.now(),
      status: "ERROR",
      elapsedMs: Date.now() - turn.attemptStartedAtMs,
      message: cause instanceof Error ? cause.message : String(cause),
    });
    turn.controller.fail(cause instanceof Error ? cause : new Error(String(cause)));
  }

  #isCurrent(turn: TurnContext): boolean {
    return turn.generation === this.#generation;
  }

  #abortFailure(turn: TurnContext): Error {
    return turn.abort.signal.reason === turn.timeoutError ? turn.timeoutError : new Error("agy turn was aborted.");
  }

  #report(turn: TurnContext, event: AgyTurnDiagnostic): void {
    if (!this.#isCurrent(turn)) return;
    notifyAgyDiagnostic(this.#onDiagnostic, {
      ...event,
      attempt: event.attempt ?? turn.attemptNumber,
      conversationId: event.conversationId ?? this.#conversationId,
      lastToolCompletedAtMs: event.lastToolCompletedAtMs ?? turn.budget.lastToolCompletedAtMs,
    });
  }
}

function runnerExecutor(turnRunner: AgyTurnRunner): AgyTurnExecutor {
  return {
    run: turnRunner,
    snapshot: () => ({ mode: "one-shot", state: "idle", lifecycle: [] }),
    close: async () => {},
  };
}

export function createAntigravityRuntime(
  executorOrRunner: AgyTurnExecutor | AgyTurnRunner = createAgyTurnExecutor(),
  onDiagnostic?: (event: AgyTurnDiagnostic) => void,
  childrenHost?: AgyChildrenHost,
): AntigravityRuntime {
  const executor = typeof executorOrRunner === "function" ? runnerExecutor(executorOrRunner) : executorOrRunner;
  return new AntigravityRuntime(executor, onDiagnostic, childrenHost);
}
