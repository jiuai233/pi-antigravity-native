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
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { installAgyDeathHooks } from "./src/driver/agy-children.ts";
import { type AgyModelInfo, toProviderModel } from "./src/provider/models.ts";
import { AgyReplayStore, tagNativeReplayResult } from "./src/provider/replay.ts";
import { registerAgyCommand } from "./src/extension/agy-command.ts";
import { BridgeHost } from "./src/extension/bridge-host.ts";
import { ConversationSync, registerCompactionRenderer } from "./src/extension/conversation-sync.ts";
import { type ModelCache, ModelCatalog, modelDiscoveryFailure } from "./src/extension/model-catalog.ts";
import { registerPanelCommands } from "./src/extension/panel-commands.ts";
import { registerSessionHooks } from "./src/extension/session-hooks.ts";
import { TaskMonitor } from "./src/extension/task-monitor.ts";
import { registerWrapperTool } from "./src/extension/wrapper-tool.ts";
import { type StreamAntigravityOptions, streamAntigravity } from "./src/provider/stream.ts";
import { createAntigravityRuntime } from "./src/runtime/runtime.ts";

export default function antigravityExtension(pi: ExtensionAPI): void {
  if (process.platform === "darwin" && !process.env.AGY_BINARY) {
    const patchedBinary = path.join(os.homedir(), ".gemini", "bin", "agy-512k");
    if (fs.existsSync(patchedBinary)) {
      process.env.AGY_BINARY = patchedBinary;
      process.env.AGY_CLI_DISABLE_AUTO_UPDATE ??= "true";
    }
  }
  installAgyDeathHooks();
  const runtime = createAntigravityRuntime(undefined, (event) =>
    pi.appendEntry("pi-antigravity-turn-diagnostic", { version: 1, ...event }));
  const replay = new AgyReplayStore();
  const catalog = new ModelCatalog();
  const sync = new ConversationSync(runtime, (customType, data) => pi.appendEntry(customType, data));
  const monitor = new TaskMonitor(runtime);

  registerCompactionRenderer(pi);

  const bridge = new BridgeHost(runtime, () => monitor.sessionCwd);

  const streamOptions: StreamAntigravityOptions = {
    runtime,
    replay,
    bridge: bridge.bridge,
    onSettled: monitor.update,
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
    },
    createIsolatedRuntime: createAntigravityRuntime,
    getModelInfo: (modelId) => catalog.find(modelId),
    getProcessProfile: () => bridge.processProfile(),
    getBridgeRevision: bridge.processRevision,
    prepareAgent: (systemPrompt, declaredTools) => bridge.prepareAgent(systemPrompt, declaredTools),
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
  registerAgyCommand(pi, { runtime, sync, catalog, bridge, refreshModels });
  registerPanelCommands(pi, runtime, monitor);
}
