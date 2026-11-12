/**
 * streamSimple adapter — runs one agy turn per pi request and translates its
 * activities into pi AssistantMessageEvents.
 *
 * agy streams the visible answer as text_delta continuation chunks on
 * agent_response steps; these stream live into pi's text channel. Public
 * thinking comes from the native read-only observer; count-only notices are
 * kept only when no public text is available. agy tool steps
 * render as display-only cards (see native-cards.ts) that share a toolUse
 * handoff at the next model-response boundary; a real Pi bridge call still
 * hands off immediately. Pi executes only the replay wrapper and re-invokes
 * this adapter, which re-attaches to the same agy turn via the runtime.
 */

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { type AgyProcessProfile, readAgyProcessProfile } from "../driver/agy-profile.ts";
import type { AgyActivity, AgyUsage } from "../driver/reducer.ts";
import {
  type AgyPiBridge,
  type BridgeContent,
  resolveBridgeResultsFromContext,
} from "../extension/bridge.ts";
import {
  fitNativeRequest,
  latestUserPrompt,
  piHistoryBootstrap,
  piHistoryBootstrapChunks,
} from "../input/pi-input.ts";
import { steerNoticePrompt } from "../input/prompt.ts";
import { readNativeToolResult } from "../native/native-results.ts";
import { type AntigravityRuntime, createAntigravityRuntime, type StreamTurnRequest } from "../runtime/runtime.ts";
import type { AgyTurnController } from "../runtime/turn.ts";
import {
  hashSystemPrompt,
  isBridgedMcpStep,
  isSummarizationRequest,
  mapThinkingToEffort,
  mapUsage,
  stallSummary,
  terminalErrorMessage,
  thoughtSummary,
  toJsonObject,
  withPermissionHint,
} from "./mapping.ts";
import { AssistantMessageWriter } from "./message-writer.ts";
import { type AgyModelInfo, resolveAgyModelEffort } from "./models.ts";
import { NativeToolCards } from "./native-cards.ts";
import type { AgyReplayStore } from "./replay.ts";

type AssistantDiagnostic = NonNullable<AssistantMessage["diagnostics"]>[number];
type ToolEnd = Extract<AgyActivity, { type: "tool_done" | "tool_error" }>;
type ResultActivity = Extract<AgyActivity, { type: "result" }>;

const defaultDependencies = {
  latestUserPrompt,
  piHistoryBootstrap,
  piHistoryBootstrapChunks,
  fitNativeRequest,
  normalizeContext,
  getCurrentSystemPrompt,
  getCurrentTools,
  resolveBridgeResultsFromContext,
  resolveAgyModelEffort,
  calculateCost,
  createAssistantMessageEventStream,
  readNativeToolResult,
};

export type ProviderDependencies = typeof defaultDependencies;

export interface StreamAntigravityOptions {
  /** Host/record readers, defaulting to the production implementations. */
  dependencies?: Partial<ProviderDependencies>;
  runtime: AntigravityRuntime;
  replay: AgyReplayStore;
  /** Pi-tool bridge; pass a detached AgyPiBridge when the bridge is off. */
  bridge: AgyPiBridge;
  /** Called when a turn fully settles (stop or error) — the moment an agy
   * background task may have been created. */
  onSettled?: () => void;
  /** Whether a pi tool name is currently active — wrapper toolCalls require
   * an active tool; otherwise native steps replay as text. */
  isActiveTool?: (name: string) => boolean;
  /** Live activity side channel for task/artifact UI that must not wait for
   * the provider message to settle. */
  onActivity?: (activity: AgyActivity) => void;
  /** Test seam for disposable compaction/branch-summary conversations. */
  createIsolatedRuntime?: () => AntigravityRuntime;
  /** Current discovery metadata used to resolve a valid required effort. */
  getModelInfo?: (modelId: string) => AgyModelInfo | undefined;
  /** Validated process profile; read per turn so env changes recycle safely. */
  getProcessProfile?: () => AgyProcessProfile;
  /** Combined bridge registration/catalog revision. */
  getBridgeRevision?: () => string | undefined;
  /** Write the active Pi system snapshot and return its custom-agent name. */
  prepareAgent?: (systemPrompt: string, declaredTools: readonly Tool[]) => Promise<string | {
    name: string; nativeContractHash: string; nativeTools: string[]; agentBody?: string;
  }>;
}

interface TurnDeps {
  dependencies: ProviderDependencies;
  customHistoryBootstrapOnly: boolean;
  runtime: AntigravityRuntime;
  replay: AgyReplayStore;
  bridge: AgyPiBridge;
  onSettled: (() => void) | undefined;
  isActiveTool: (name: string) => boolean;
  onActivity: ((activity: AgyActivity) => void) | undefined;
  createIsolatedRuntime: () => AntigravityRuntime;
  getModelInfo: (modelId: string) => AgyModelInfo | undefined;
  getProcessProfile: () => AgyProcessProfile;
  getBridgeRevision: () => string | undefined;
  prepareAgent: StreamAntigravityOptions["prepareAgent"];
}

/** Build the streamSimple implementation bound to the runtime. */
export function streamAntigravity({
  runtime,
  replay,
  bridge,
  onSettled,
  isActiveTool = () => true,
  onActivity,
  createIsolatedRuntime = createAntigravityRuntime,
  getModelInfo = () => undefined,
  getProcessProfile = readAgyProcessProfile,
  getBridgeRevision = () => undefined,
  prepareAgent,
  dependencies,
}: StreamAntigravityOptions) {
  const deps: TurnDeps = {
    dependencies: { ...defaultDependencies, ...dependencies },
    customHistoryBootstrapOnly: Boolean(
      dependencies?.piHistoryBootstrap && !dependencies?.piHistoryBootstrapChunks,
    ),
    runtime, replay, bridge, onSettled, isActiveTool, onActivity,
    createIsolatedRuntime, getModelInfo, getProcessProfile, getBridgeRevision, prepareAgent,
  };
  return (model: Model<string>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = deps.dependencies.createAssistantMessageEventStream();
    void new ProviderTurn(deps, model, context, options, stream).run();
    return stream;
  };
}

/** One provider call: prepare or re-attach the agy turn, then pump its activities. */
class ProviderTurn {
  readonly #deps: TurnDeps;
  readonly #model: Model<string>;
  readonly #context: Context;
  readonly #options: SimpleStreamOptions | undefined;
  readonly #writer: AssistantMessageWriter;
  readonly #cards: NativeToolCards;
  /** The user's runtime, or a disposable one for compaction/branch summaries. */
  #runtime: AntigravityRuntime;
  #isolated: AntigravityRuntime | undefined;
  #cleared = false;
  #summaryRequest = false;
  #nativeCwd = "";
  #controller: AgyTurnController | undefined;
  /** This call's native request, reused when a steer continues the conversation. */
  #request: StreamTurnRequest | undefined;
  /** Latest response-step usage; the cumulative result usage is only a fallback. */
  #usage: AgyUsage | undefined;

  constructor(
    deps: TurnDeps,
    model: Model<string>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    stream: AssistantMessageEventStream,
  ) {
    this.#deps = deps;
    this.#model = model;
    this.#context = context;
    this.#options = options;
    this.#runtime = deps.runtime;
    this.#writer = new AssistantMessageWriter(
      {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: mapUsage(undefined),
        stopReason: "pending",
        timestamp: Date.now(),
      },
      stream,
    );
    this.#cards = new NativeToolCards(this.#writer, deps.replay, deps.isActiveTool);
  }

  async run(): Promise<void> {
    try {
      this.#writer.start();
      await this.#pump(await this.#begin());
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
    }
  }

  async #begin(): Promise<AgyTurnController> {
    const deps = this.#deps;
    const { prompt: rawPrompt } = this.#deps.dependencies.latestUserPrompt(this.#context);
    if (!rawPrompt) throw new Error("antigravity: no user text found in the request context.");
    this.#summaryRequest = isSummarizationRequest(rawPrompt);
    const normalized = this.#deps.dependencies.normalizeContext(this.#context);
    const systemPrompt = this.#deps.dependencies.getCurrentSystemPrompt(normalized.messages);
    const systemPromptHash = hashSystemPrompt(systemPrompt);
    const preparedAgent = await deps.prepareAgent?.(
      systemPrompt, deps.dependencies.getCurrentTools(normalized.messages),
    );
    const nativeAgent = typeof preparedAgent === "string" ? preparedAgent : preparedAgent?.name;
    // agy hands the model only the first 192,000 bytes of one input. Summary
    // requests and closed-book agents cannot read an archived original.
    const nativeTools = typeof preparedAgent === "object" ? preparedAgent.nativeTools : undefined;
    const prompt = deps.dependencies.fitNativeRequest(rawPrompt, {
      readable: !this.#summaryRequest && (nativeTools === undefined || nativeTools.includes("view_file")),
    });
    this.#nativeCwd = deps.runtime.snapshot().cwd ?? process.cwd();

    if (this.#summaryRequest) {
      // Pi invokes compaction and branch summarization as provider calls.
      // Resuming the user's agy conversation would record the serialized
      // transcript as a fake USER_INPUT. Run that internal request in a
      // disposable conversation so `agy --conversation <id>` shows only
      // messages the user actually sent.
      this.#isolated = deps.createIsolatedRuntime();
      this.#runtime = this.#isolated;
      await this.#runtime.setSession(this.#nativeCwd, this.#model.id, false);
    }

    let bridgeRevision: string | undefined;
    let processProfile: AgyProcessProfile = {};
    if (!this.#summaryRequest) {
      // Refresh and resolve before the driver fingerprint is evaluated.
      // Re-entry into a pending bridge turn returns the existing controller,
      // so a changed revision is deferred safely to the next user turn.
      deps.bridge.refreshTools();
      // A steer that re-enters while agy works joins the live turn and rides
      // in front of the tool result agy is waiting for; agy is not restarted.
      const live = this.#runtime.steerActiveTurn(prompt);
      const steer = live?.pendingSteer();
      deps.dependencies.resolveBridgeResultsFromContext(
        deps.bridge, this.#context.messages,
        steer ? { text: steerNoticePrompt(steer), delivered: () => live?.takeSteer() } : undefined,
      );
      bridgeRevision = deps.getBridgeRevision();
      processProfile = deps.getProcessProfile();
    }
    const modelInfo = deps.getModelInfo(this.#model.id);
    const requestedEffort = mapThinkingToEffort(this.#options?.reasoning);
    const effort = deps.dependencies.resolveAgyModelEffort(modelInfo, requestedEffort);
    const historyPlan = this.#summaryRequest
      ? { prefill: [] as string[], bootstrap: undefined }
      : deps.customHistoryBootstrapOnly
        ? { prefill: [] as string[], bootstrap: this.#deps.dependencies.piHistoryBootstrap(this.#context) }
        : this.#deps.dependencies.piHistoryBootstrapChunks(this.#context);
    const prefillEffort =
      historyPlan.prefill.length > 0
        ? (deps.dependencies.resolveAgyModelEffort(modelInfo, "low") ?? effort)
        : undefined;

    const request: StreamTurnRequest = {
      prompt,
      systemPromptHash,
      ...(typeof preparedAgent === "object" ? {
        nativeContractHash: preparedAgent.nativeContractHash,
        nativeTools: preparedAgent.nativeTools,
        ...(preparedAgent.agentBody !== undefined ? { agentBody: preparedAgent.agentBody } : {}),
      } : {}),
      ...(historyPlan.prefill.length > 0
        ? { historyPrefill: historyPlan.prefill, prefillEffort }
        : {}),
      historyBootstrap: historyPlan.bootstrap,
      modelId: this.#model.id,
      effort,
      agent: nativeAgent ?? processProfile.agent,
      mode: processProfile.mode,
      mcpDirectory: processProfile.mcpDirectory,
      bridgeBootstrap: processProfile.bridgeBootstrap,
      bridgeRevision,
      signal: this.#options?.signal,
    };
    this.#request = request;
    const controller = await this.#runtime.beginStreamTurn(request);
    this.#bind(controller);
    return controller;
  }

  /** Make `controller` the native turn this provider message reports on. */
  #bind(controller: AgyTurnController): void {
    // The SDK overwrites thinkingLevel with the current Pi request level.
    // Preserve the native turn's frozen effort separately, including on
    // tool-loop re-entry when a newly selected effort has not taken effect.
    // The persisted shape (no timestamp) is kept from 1.0.30 deliberately.
    if (controller.effectiveEffort !== undefined) {
      const diagnostic = { type: "antigravity_turn", details: { effectiveEffort: controller.effectiveEffort } };
      this.#writer.output.diagnostics = [diagnostic as unknown as AssistantDiagnostic];
    }
    this.#controller = controller;
  }

  async #pump(first: AgyTurnController): Promise<void> {
    const writer = this.#writer;
    let controller = first;
    for (;;) {
      let activity: AgyActivity | null;
      try {
        activity = await controller.next();
      } catch (error) {
        // Deliver recorded tool results first, then expose the same error.
        if (!writer.hasToolCall()) throw error;
        activity = {
          type: "result", status: "ERROR", response: "",
          error: error instanceof Error ? error.message : String(error), usage: undefined,
        };
      }
      if (this.#options?.signal?.aborted) {
        this.#drainThinking(controller, activity);
        throw new Error("agy turn was aborted.");
      }
      if (activity === null) {
        if (this.#emitIncomplete(controller) > 0 || writer.hasToolCall()) {
          controller.deferActivity({
            type: "result",
            status: "ERROR",
            response: "",
            error: "agy turn ended without a result event.",
            usage: undefined,
          });
          this.#endWithToolUse();
          return;
        }
        throw new Error("agy turn ended without a result event.");
      }

      // Flush recorded cards at the next model-response boundary, not per
      // native tool. A real Pi bridge_call below still yields immediately.
      if (
        (activity.type === "usage" || activity.type === "thought" ||
          activity.type === "text" || activity.type === "response_start" || activity.type === "result" ||
          ((activity.type === "native_thinking_snapshot" || activity.type === "native_thinking_end") &&
            Boolean(activity.text) && !writer.hasNativeThought(`${activity.conversationId}:${activity.stepId}`))) &&
        writer.hasToolCall()
      ) {
        if (activity.type === "result") this.#emitIncomplete(controller, activity.error);
        else this.#cards.closePendingForBridge();
        controller.deferActivity(activity);
        this.#endWithToolUse();
        return;
      }
      // agy finished before any tool result could carry a pending steer:
      // keep this answer and continue the same native conversation with it.
      if (
        activity.type === "result" && activity.status !== "ERROR" &&
        controller.pendingSteer() !== undefined && !this.#options?.signal?.aborted
      ) {
        if (this.#emitIncomplete(controller, activity.error) > 0) {
          controller.deferActivity(activity);
          this.#endWithToolUse();
          return;
        }
        this.#observe(activity);
        controller = await this.#followSteer(controller, activity);
        continue;
      }
      this.#observe(activity);
      if (this.#handle(controller, activity)) return;
    }
  }

  #observe(activity: AgyActivity): void {
    try {
      if (!this.#summaryRequest) this.#deps.onActivity?.(activity);
    } catch {
      // UI side channels are best-effort and must never fail the turn.
    }
  }

  /** Keep the finished turn's answer, then send the steer to agy as a follow-up turn. */
  async #followSteer(controller: AgyTurnController, activity: ResultActivity): Promise<AgyTurnController> {
    const suffix = controller.remainingResponseText(activity.response);
    if (suffix) {
      controller.recordEmittedText(suffix);
      this.#writer.appendResponseSuffix(suffix);
    }
    this.#writer.closeText();
    const steer = controller.takeSteer();
    const request = this.#request;
    if (!request || !steer) throw new Error("antigravity: a steer follow-up lost its request.");
    // Settle the finished turn without the stream's onSettled side effects;
    // the next turn waits for its commit and resumes the same conversation.
    this.#runtime.finishTurn();
    const next = await this.#runtime.beginStreamTurn({ ...request, prompt: controller.prompt, nativeInput: steer });
    // The finished turn's last step usage was already in its result total.
    this.#usage = undefined;
    this.#bind(next);
    next.claimThought();
    return next;
  }

  /** Keep only this message\u0027s already-observed display work on cancellation. */
  #drainThinking(controller: AgyTurnController, first?: AgyActivity | null): void {
    if (first?.type === "tool_start" || first?.type === "bridge_call") return;
    const pending = [...(first ? [first] : []), ...controller.takePendingThinking()];
    for (const activity of pending) {
      if (activity.type !== "native_thinking_snapshot" && activity.type !== "native_thinking_end") continue;
      const key = `${activity.conversationId}:${activity.stepId}`;
      if (this.#writer.hasToolCall() && !this.#writer.hasNativeThought(key)) continue;
      this.#handle(controller, activity);
    }
  }

  /** Apply one activity; true once this provider message has ended. */
  #handle(controller: AgyTurnController, activity: AgyActivity): boolean {
    const writer = this.#writer;
    const serverName = this.#deps.bridge.serverName;
    switch (activity.type) {
      case "native_migration_warning":
        writer.appendTextBlock(`[AGY 会话升级警告] ${activity.message}\n`);
        return false;
      case "healed_in_turn_error":
      case "conversation_fallback":
        // Runtime/index side channel only; no assistant content.
        return false;
      case "usage":
        this.#usage = activity.usage;
        return false;
      case "native_thinking_snapshot":
        writer.updateNativeThinking(`${activity.conversationId}:${activity.stepId}`, activity.text);
        return false;
      case "native_thinking_end":
        writer.endNativeThinking(`${activity.conversationId}:${activity.stepId}`, activity.text);
        return false;
      case "response_start":
        return false;
      case "response_end":
        writer.closeResponse(activity.stepId === undefined ? undefined : controller.thinkingKey(activity.stepId));
        return false;
      case "thought":
        if (controller.claimThought()) writer.fillThought(thoughtSummary(activity),
          activity.stepId === undefined ? undefined : controller.thinkingKey(activity.stepId));
        return false;
      case "stall":
        writer.closeText();
        writer.fillThought(stallSummary(activity));
        return false;
      case "tool_start":
        if (!isBridgedMcpStep(activity, serverName)) this.#cards.start(activity);
        return false;
      case "tool_done":
      case "tool_error":
        if (!isBridgedMcpStep(activity, serverName)) this.#finishNativeTool(activity);
        return false;
      case "bridge_call": {
        // agy invoked a pi tool through the bridge: end this message with a
        // toolUse for the REAL pi tool so pi executes it with full ownership
        // (hooks, permissions, rendering, abort).
        writer.closeText();
        this.#cards.closePendingForBridge();
        const toolCall = { type: "toolCall" as const, id: activity.id, name: activity.name, arguments: toJsonObject(activity.args) };
        writer.closeToolCall(writer.openToolCall(toolCall), toolCall);
        this.#endWithToolUse();
        return true;
      }
      case "text":
        controller.recordEmittedText(activity.delta);
        writer.appendTextDelta(activity.delta,
          activity.stepId === undefined ? undefined : controller.thinkingKey(activity.stepId));
        return false;
      case "result":
        this.#finish(controller, activity);
        return true;
    }
  }

  /** view_file/generate_image replay their saved native result and media. */
  #finishNativeTool(activity: ToolEnd): void {
    let content: BridgeContent[] | undefined;
    if (activity.type === "tool_done" && (activity.name === "view_file" || activity.name === "generate_image")) {
      try {
        const current = this.#runtime.snapshot();
        if (!current.conversationId || activity.stepId === undefined) {
          throw new Error("Native conversation/step identity is missing.");
        }
        const stored = this.#deps.dependencies.readNativeToolResult(
          current.conversationId, activity.stepId, this.#nativeCwd,
        );
        if (activity.name === "view_file" && stored.args.AbsolutePath !== activity.args.AbsolutePath) {
          throw new Error("Stored native file does not match the streamed tool step.");
        }
        content = stored.content;
        activity = { ...activity, args: stored.args, output: stored.output };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        activity = { ...activity, output: `[AGY CLI summary only; full native result unavailable: ${reason}]\n${activity.output ?? ""}` };
      }
    }
    this.#cards.finish(activity, content);
  }

  #finish(controller: AgyTurnController, activity: ResultActivity): void {
    const writer = this.#writer;
    if (this.#emitIncomplete(controller, activity.error) > 0) {
      controller.deferActivity(activity);
      this.#endWithToolUse();
      return;
    }
    // A result carries conversation-cumulative counters, which can represent
    // millions of tokens across agy's internal agent loop. Pi interprets one
    // assistant message's usage as live context and would auto-compact after
    // nearly every user turn. Prefer the latest response step and use the
    // cumulative result only when agy exposed no response-step usage.
    if (this.#usage) this.#attachUsage(this.#usage, false);
    else this.#attachUsage(activity.usage, true);

    // Account for text rendered in earlier Pi messages and blocks, not just
    // this message's open run (which tool boundaries clear).
    const suffix = controller.remainingResponseText(activity.response);
    if (suffix) {
      controller.recordEmittedText(suffix);
      writer.appendResponseSuffix(suffix);
    }
    writer.closeText();

    // Text is not a completion signal. Preserve the CLI's terminal error even
    // when it supplied a partial response before failing.
    if (activity.status === "ERROR") {
      writer.output.stopReason = "error";
      writer.output.errorMessage = terminalErrorMessage(activity.error);
      writer.error("error");
    } else {
      writer.output.stopReason = "stop";
      writer.done("stop");
    }
    this.#clearTurn();
    writer.end();
  }

  #emitIncomplete(controller: AgyTurnController, resultError?: string): number {
    const serverName = this.#deps.bridge.serverName;
    const incomplete = controller.takeIncompleteTools().filter((activity) => !isBridgedMcpStep(activity, serverName));
    return this.#cards.emitIncomplete(incomplete, resultError);
  }

  #endWithToolUse(): void {
    this.#writer.closeText();
    this.#attachUsage(this.#usage, false);
    this.#writer.output.stopReason = "toolUse";
    this.#writer.done("toolUse");
    this.#writer.end();
  }

  #attachUsage(usage: AgyUsage | undefined, final: boolean): void {
    if (this.#summaryRequest || !this.#controller) return; // summarization turns carry no billable usage
    this.#writer.output.usage = mapUsage(this.#controller.claimUsage(usage, final));
    this.#deps.dependencies.calculateCost(this.#model, this.#writer.output.usage);
  }

  #clearTurn(): void {
    if (this.#cleared) return;
    this.#cleared = true;
    this.#runtime.finishTurn();
    if (!this.#isolated) {
      this.#deps.onSettled?.();
      return;
    }
    // A summarizer has no continuity to preserve. Abort any unfinished child
    // of its private runtime without touching the user's real conversation.
    void this.#isolated.close().catch(() => {});
  }

  #fail(message: string): void {
    const reason = this.#options?.signal?.aborted ? "aborted" : "error";
    this.#writer.output.stopReason = reason;
    this.#writer.output.errorMessage = withPermissionHint(message);
    this.#clearTurn();
    this.#writer.error(reason);
    this.#writer.end();
  }
}
