// Pi lifecycle hooks: which native conversation a session resumes, when the
// bridge exists, and what stops on shutdown. Registration order is part of
// the extension surface: both agent_settled handlers run in this order.

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { rehydrateSessionImages } from "../input/image-input.ts";
import { WRAPPER_TOOL_NAME } from "../input/prompt.ts";
import { agyConversationExists, restorableAgyConversation } from "../native/conversation-state.ts";
import { persistNativeMedia } from "../native/native-media-audit.ts";
import type { AntigravityRuntime } from "../runtime/runtime.ts";
import type { BridgeHost } from "./bridge-host.ts";
import type { ConversationSync } from "./conversation-sync.ts";
import type { TaskMonitor } from "./task-monitor.ts";
import { wrapperToolActiveAfterModelSwitch } from "./wrapper-activation.ts";

export interface SessionHookDeps {
  pi: ExtensionAPI;
  runtime: AntigravityRuntime;
  sync: ConversationSync;
  monitor: TaskMonitor;
  bridge: BridgeHost;
  /** Re-discover models when the cached catalog is past its TTL. */
  refreshStaleModels(ui: ExtensionUIContext): Promise<void>;
}

export function registerSessionHooks(deps: SessionHookDeps): void {
  const { pi, runtime, sync, monitor, bridge } = deps;
  let selectedModelKey: string | undefined;

  pi.on("before_agent_start", async (event, ctx) => {
    bridge.setSkills(event.systemPromptOptions?.skills);
    bridge.refreshSkillTools();
    if (ctx.model?.provider === "antigravity") {
      if (ctx.model.input.includes("image")) rehydrateSessionImages(ctx.sessionManager.getBranch());
      await bridge.ensureRegistered(ctx.ui, ctx.cwd);
    }
  });

  // The agy stream reports tool starts immediately, but its DONE event can be
  // delayed by a sleeping command. Poll the independent filesystem task
  // source while the agent or any discovered task is live, then stop when
  // both are idle. This keeps the widget current without a permanent timer.
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.model?.provider !== "antigravity") return;
    monitor.agentStarted();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (bridge.pendingCount > 0) {
      // Pi skips agent_before_settle when cancelled and will not re-enter the provider.
      // Stop agy before settling MCP calls so it cannot continue the ended turn.
      await runtime.abortTurn();
      bridge.cancelPending("antigravity: pi turn ended before the tool call completed.");
    }
    if (ctx.model?.provider !== "antigravity" && !monitor.agentActive) return;
    monitor.agentSettled();
    if (ctx.model?.provider === "antigravity") {
      const snapshot = runtime.snapshot();
      if (snapshot.conversationId && snapshot.cwd === ctx.cwd) persistNativeMedia(pi, {
        conversationId: snapshot.conversationId, cwd: ctx.cwd, branch: ctx.sessionManager.getBranch(),
      });
    }
  });

  // The display-only `antigravity` wrapper tool only matters while an agy
  // model is active (the provider synthesizes its toolCalls from recorded
  // agy activity). Keep it out of every other model's tool payload: sync
  // active-tool state whenever the selected model changes, including the
  // session's initial restore.
  const syncWrapperTool = (provider: string | undefined) => {
    const next = wrapperToolActiveAfterModelSwitch(
      pi.getActiveTools(),
      WRAPPER_TOOL_NAME,
      provider,
      "antigravity",
    );
    if (next) pi.setActiveTools([...next]);
  };

  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    syncWrapperTool(ctx.model?.provider);
    selectedModelKey = ctx.model ? `${ctx.model.provider}:${ctx.model.id}` : undefined;
    const restored =
      event.reason !== "fork" && ctx.model?.provider === "antigravity"
        ? restorableAgyConversation(
            ctx.sessionManager.getBranch(),
            ctx.sessionManager.getSessionId(),
            ctx.cwd,
          )
        : undefined;
    const compatibleRestore =
      restored &&
      restored.modelId === ctx.model?.id &&
      (await agyConversationExists(restored.conversationId))
        ? restored
        : undefined;
    await runtime.setSession(ctx.cwd, undefined, !compatibleRestore && event.reason !== "new");
    if (compatibleRestore) {
      await runtime.restoreConversation({
        conversationId: compatibleRestore.conversationId,
        modelId: compatibleRestore.modelId,
        cwd: compatibleRestore.cwd,
        turns: compatibleRestore.turns,
        usage: compatibleRestore.usage,
        systemPromptHash: compatibleRestore.systemPromptHash,
        nativeContractHash: compatibleRestore.nativeContractHash,
      });
      sync.adopt(compatibleRestore);
    } else {
      sync.forget();
    }
    monitor.attach(ctx.hasUI ? ctx.ui : undefined, ctx.cwd);
    // The pi-tool bridge is only useful while an Antigravity model is
    // selected: register lazily here (session resumed on an agy model) and on
    // model_select; non-agy sessions never touch agy at all.
    if (ctx.model?.provider === "antigravity") {
      await bridge.ensureRegistered(ctx.ui, ctx.cwd);
      await deps.refreshStaleModels(ctx.ui);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    syncWrapperTool(event.model?.provider);
    const nextModelKey = event.model ? `${event.model.provider}:${event.model.id}` : undefined;
    if (selectedModelKey?.startsWith("antigravity:") && selectedModelKey !== nextModelKey) {
      // Another provider/model can add context that the mutable agy
      // conversation never saw. Force a branch bootstrap when agy is selected
      // again instead of silently resuming stale native history.
      await runtime.setSession(ctx.cwd, undefined, true);
      sync.forget();
    }
    selectedModelKey = nextModelKey;
    if (event.model?.provider === "antigravity") {
      await bridge.ensureRegistered(ctx.ui, ctx.cwd);
      await deps.refreshStaleModels(ctx.ui);
    } else {
      await bridge.teardown();
    }
  });

  const restartNative = async (ctx: ExtensionContext): Promise<void> => {
    if (await sync.restartNative(ctx)) monitor.clear();
  };

  pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
    await restartNative(ctx);
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    await sync.persist(ctx);
  });

  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
    // Pi's compacted branch is the context authority. Resuming the old native
    // conversation would keep the pre-compaction context, so the next tool
    // result would exceed the midrun threshold and compact again.
    await restartNative(ctx);
  });

  pi.on("session_shutdown", async () => {
    monitor.stopPolling();
    // Stop live agy background tasks so closing pi leaves nothing running silently.
    await monitor.stopLiveTasks();
    // Close the runtime: aborts any in-flight agy child process and reaps
    // this runtime's remaining trees.
    try {
      await runtime.close();
    } catch {
      // Already closed.
    }
    await bridge.teardown();
    monitor.dispose();
    // Only process death hooks may sweep the shared registry across
    // extension instances.
  });
}
