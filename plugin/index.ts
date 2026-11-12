// antigravity — use Google Antigravity (agy) models inside the pi coding
// agent via the agy stream-json RPC. pi stays the UI: model picker, portable
// sessions, and rendering; agy owns native context and runs the selected model with
// --dangerously-skip-permissions always enabled (headless agy turns
// auto-deny tools that would need a permission prompt otherwise).
//
// Commands:
//   /agy            show agy conversation and persistent-driver status
//   /agy reset      drop the current agy conversation (next turn starts fresh)
//   /agy models     re-discover models from `agy models` and re-register
//   /agy agents     list configured custom agents
//   /agy doctor     diagnose binary, models, driver, bridge, and local state
//   /agy-usage      show Antigravity model quotas (weekly and 5-hour limits)
//
// This file only wires the parts together; registration order is part of the
// extension surface and is kept stable.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { installAgyDeathHooks } from "./src/driver/agy-children.ts";
import { registerAgyCommand } from "./src/extension/agy-command.ts";
import { BridgeHost } from "./src/extension/bridge-host.ts";
import { ConversationSync, registerCompactionRenderer } from "./src/extension/conversation-sync.ts";
import { type ModelCache, ModelCatalog, modelDiscoveryFailure } from "./src/extension/model-catalog.ts";
import { registerPanelCommands } from "./src/extension/panel-commands.ts";
import { registerSessionHooks } from "./src/extension/session-hooks.ts";
import { TaskMonitor } from "./src/extension/task-monitor.ts";
import { registerWrapperTool } from "./src/extension/wrapper-tool.ts";
import { AgyPrefixAudit, PREFIX_AUDIT_ENTRY } from "./src/native/prefix-audit.ts";
import { type AgyModelInfo, toProviderModel } from "./src/provider/models.ts";
import { AgyReplayStore, tagNativeReplayResult } from "./src/provider/replay.ts";
import { type StreamAntigravityOptions, streamAntigravity } from "./src/provider/stream.ts";
import { createAntigravityRuntime } from "./src/runtime/runtime.ts";

export default function antigravityExtension(pi: ExtensionAPI): void {
  if (process.platform === "darwin" && !process.env.AGY_BINARY) {
    const patchedBinary = ["agy-512k-keepalive", "agy-512k"]
      .map(name => path.join(os.homedir(), ".gemini", "bin", name))
      .find(file => fs.existsSync(file));
    if (patchedBinary) {
      process.env.AGY_BINARY = patchedBinary;
      process.env.AGY_CLI_DISABLE_AUTO_UPDATE ??= "true";
    }
  }
  installAgyDeathHooks();
  let auditUI: ExtensionUIContext | undefined;
  const refreshAuditStatus = () => {
    try { auditUI?.setStatus("agy-cache", audit.summary()); }
    catch { /* The UI may have detached; durable diagnostics remain available. */ }
  };
  const audit = new AgyPrefixAudit(event => {
    pi.appendEntry(PREFIX_AUDIT_ENTRY, event);
  }, refreshAuditStatus);
  const runtime = createAntigravityRuntime(undefined, event => {
    try { pi.appendEntry("pi-antigravity-turn-diagnostic", { version: 1, ...event }); }
    finally { audit.recordDiagnostic(event); }
  });
  const replay = new AgyReplayStore();
  const catalog = new ModelCatalog();
  const sync = new ConversationSync(runtime, (customType, data) => pi.appendEntry(customType, data));
  const monitor = new TaskMonitor(runtime);
  const nativeConversation = () => runtime.snapshot().conversationId;

  registerCompactionRenderer(pi);

  const bridge = new BridgeHost(runtime, () => monitor.sessionCwd);

  const streamOptions: StreamAntigravityOptions = {
    runtime,
    replay,
    bridge: bridge.bridge,
    onSettled: () => {
      monitor.update();
      audit.sample(runtime.snapshot().conversationId, monitor.sessionCwd);
    },
    /** Active-tool snapshot for the provider's native re-execution fallback. */
    isActiveTool: (name) => {
      try {
        return pi.getActiveTools().includes(name);
      } catch {
        return false; // API unavailable (print/RPC edge) — stay on the wrapper.
      }
    },
    onActivity: (activity) => {
      sync.observe(activity);
      monitor.observe(activity);
      audit.observeActivity(activity, nativeConversation, monitor.sessionCwd);
    },
    createIsolatedRuntime: createAntigravityRuntime,
    getModelInfo: (modelId) => catalog.find(modelId),
    getProcessProfile: () => bridge.processProfile(),
    getBridgeRevision: bridge.processRevision,
    prepareAgent: async (systemPrompt, declaredTools) => {
      const prepared = await bridge.prepareAgent(systemPrompt, declaredTools);
      audit.recordLocal(systemPrompt, declaredTools, prepared);
      audit.sample(runtime.snapshot().conversationId, monitor.sessionCwd);
      return prepared;
    },
  };

  /**
   * Default rates (USD per Mtok) feed pi's native cost calculation. Per-model
   * overrides belong in pi's own ~/.pi/agent/models.json under
   * providers.antigravity.modelOverrides — pi applies them over registered models.
   */
  const registerProvider = (models: AgyModelInfo[]) => {
    pi.registerProvider("antigravity", {
      name: "Google Antigravity (agy)",
      baseUrl: "agy://local-stream-json",
      apiKey: "agy-local-session",
      api: "antigravity-stream-json",
      models: models.map(toProviderModel),
      streamSimple: streamAntigravity(streamOptions),
    });
  };

  const refreshModels = async (): Promise<ModelCache> => {
    const cache = await catalog.refresh();
    registerProvider(cache.models);
    return cache;
  };

  const refreshStaleModels = async (ui: ExtensionUIContext): Promise<void> => {
    if (catalog.isFresh()) return;
    const fresh = await refreshModels();
    if (fresh.discoveryError !== undefined) ui.notify(modelDiscoveryFailure(fresh), "warning");
  };

  pi.on("tool_result", tagNativeReplayResult);
  registerWrapperTool(pi, replay);
  registerProvider(catalog.models);
  registerSessionHooks({ pi, runtime, sync, monitor, bridge, refreshStaleModels });
  registerAgyCommand(pi, { runtime, sync, catalog, bridge, refreshModels, audit });
  registerPanelCommands(pi, runtime, monitor);

  // Journal entries are not model messages. No timer or text/thinking-delta scan.
  const restoreAudit = (_event: unknown, ctx: ExtensionContext) => {
    auditUI = ctx.hasUI && ctx.model?.provider === "antigravity" ? ctx.ui : undefined;
    audit.restore(ctx.sessionManager.getBranch());
  };
  pi.on("session_start", restoreAudit);
  pi.on("session_tree", restoreAudit);
  pi.on("model_select", (event, ctx) => {
    try { ctx.ui.setStatus("agy-cache", undefined); } catch { /* Detached UI is not a model failure. */ }
    auditUI = ctx.hasUI && event.model.provider === "antigravity" ? ctx.ui : undefined;
    refreshAuditStatus();
  });
  pi.on("session_shutdown", () => {
    try { auditUI?.setStatus("agy-cache", undefined); } catch { /* Shutdown must continue after UI detach. */ }
    auditUI = undefined;
  });
}
