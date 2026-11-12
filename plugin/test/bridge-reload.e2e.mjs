// Real AgentSession resource reload + production session hooks and BridgeHost.
// The executor is an offline tripwire; no native CLI or model request is allowed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { BridgeHost } from "../src/extension/bridge-host.ts";
import { registerSessionHooks } from "../src/extension/session-hooks.ts";
import { ConversationSync } from "../src/extension/conversation-sync.ts";
import { TaskMonitor } from "../src/extension/task-monitor.ts";
import { createAntigravityRuntime } from "../src/runtime/runtime.ts";

const sdkRoot = process.env.PI_STACK_PI_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")).href);
const modelDefinition = { id: "reload-fixture", name: "Offline AGY reload", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 };
const provider = { api: "offline-agy-reload", apiKey: "offline-fixture", baseUrl: "http://127.0.0.1:9/unused", models: [modelDefinition] };

test("real SDK reload closes the old session bridge before binding its stable identity to the new instance", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sdk-reload-"));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "auth.json"), "{}");
  const paths = { agentDir, agentRoot: path.join(root, "native-agents"), dataDirectory: path.join(root, "native-data") };
  const models = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  models.registerProvider("antigravity", provider);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const instances = [], events = [], errors = [];
  let executorRequests = 0, session;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [pi => {
      const index = instances.length;
      const runtime = createAntigravityRuntime(async () => { executorRequests++; throw new Error("No model request is permitted."); });
      const bridge = new BridgeHost(runtime, () => root, paths);
      const monitor = new TaskMonitor(runtime);
      const sync = new ConversationSync(runtime, (type, data) => pi.appendEntry(type, data));
      const instance = { runtime, bridge, monitor, index };
      instances.push(instance);
      pi.registerProvider("antigravity", provider);
      pi.registerTool({ name: "antigravity", label: "AGY replay", description: "Offline replay wrapper.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }) });
      registerSessionHooks({ pi, runtime, bridge, monitor, sync, refreshStaleModels: async () => {} });
      pi.on("session_start", async (event, ctx) => {
        instance.sessionId = ctx.sessionManager.getSessionId();
        instance.prepared = await bridge.prepareAgent("Stable fixture system.", [
          { name: "read", description: "Read.", parameters: { type: "object", properties: { path: { type: "string" } } } },
        ]);
        events.push({ kind: "started", index, reason: event.reason, running: bridge.bridge.running });
      });
      pi.on("session_shutdown", () => events.push({ kind: "closed", index, running: bridge.bridge.running }));
    }],
  });
  try {
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: models,
      model: models.getModel("antigravity", "reload-fixture"), thinkingLevel: "off", resourceLoader: loader,
      settingsManager: settings, sessionManager: SessionManager.create(root, path.join(root, "sessions")) }));
    await session.bindExtensions({ onError: error => errors.push(String(error?.message ?? error)) });
    assert.equal(instances.length, 1);
    const first = instances[0];
    const readConfig = host => JSON.parse(fs.readFileSync(path.join(host.processProfile().mcpDirectory, ".agents", "mcp_config.json"), "utf8")).mcpServers[host.bridge.serverName];
    const before = readConfig(first.bridge);
    await session.reload();
    assert.deepEqual(errors, []);
    assert.equal(instances.length, 2);
    const second = instances[1];
    assert.equal(first.bridge.bridge.running, false);
    assert.equal(second.bridge.bridge.running, true);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.bridge.bridge.serverName, first.bridge.bridge.serverName);
    assert.equal(second.prepared.agentBody, first.prepared.agentBody);
    const after = readConfig(second.bridge);
    assert.notEqual(after.headers["x-pi-bridge-token"], before.headers["x-pi-bridge-token"]);
    const response = await fetch(second.bridge.bridge.url, { method: "POST",
      headers: { "content-type": "application/json", "x-pi-bridge-token": before.headers["x-pi-bridge-token"] },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(response.status, 403);
    assert.deepEqual(events.map(event => [event.kind, event.index, event.running]),
      [["started", 0, true], ["closed", 0, false], ["started", 1, true]]);
    assert.equal(executorRequests, 0);
    t.diagnostic(JSON.stringify({ sdkVersion: JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8")).version,
      events, identityStable: true, modelBodyByteEqual: true, staleTokenRejected: true,
      externalModelRequests: executorRequests, nativeCliProcesses: 0 }));
  } finally {
    session?.dispose();
    const cleaned = await Promise.allSettled(instances.map(async instance => {
      try { await instance.runtime.close(); }
      catch (error) { if (error?.name !== "AntigravityRuntimeClosedError") throw error; }
      finally { await instance.bridge.teardown(); instance.monitor.dispose(); }
    }));
    const failed = cleaned.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
