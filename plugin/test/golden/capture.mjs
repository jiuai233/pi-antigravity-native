// Golden capture: every model- or Pi-facing output the refactor must keep
// byte-identical. Only the import map and the runtime adapter below may
// change during the refactor; baseline.json stays fixed (generated on 1.0.30).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXED_NOW = Date.UTC(2026, 9, 31, 16, 0, 0); // 2026-11-01 00:00 UTC+8
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function loadModules() {
  return {
    client: await import("../../src/driver/agy-client.ts"),
    workspace: await import("../../src/native/native-workspace.ts"),
    profile: await import("../../src/native/native-profile.ts"),
    prompt: await import("../../src/input/prompt.ts"),
    input: await import("../../src/input/pi-input.ts"),
    models: await import("../../src/provider/models.ts"),
    bridge: await import("../../src/extension/bridge.ts"),
    skills: await import("../../src/extension/skills.ts"),
    names: await import("../../src/native/native-tool-names.ts"),
    render: await import("../../src/ui/render.ts"),
    state: await import("../../src/native/conversation-state.ts"),
    usage: await import("../../src/native/usage.ts"),
    events: await import("../../src/driver/events.ts"),
    reducer: await import("../../src/driver/reducer.ts"),
    compaction: await import("../../src/native/agy-compaction.ts"),
    provider: await import("../../src/provider/mapping.ts"),
    runtime: await import("../../src/runtime/runtime.ts"),
  };
}

// --- runtime adapter (the only part rewritten when the runtime API changes) ---
function runtimeAdapter(m) {
  return {
    create(executor) {
      const runtime = m.runtime.createAntigravityRuntime(executor);
      return {
        setSession: (cwd, model, restore) => runtime.setSession(cwd, model, restore),
        restore: (state) => runtime.restoreConversation(state),
        begin: (request) => runtime.beginStreamTurn(request),
        finish: () => runtime.finishTurn(),
        snapshot: () => runtime.snapshot(),
        close: () => runtime.close(),
      };
    },
    stallError: () => new m.client.AgyStallError(130_000, false),
  };
}

function normalizer(roots) {
  const forms = [];
  for (const [root, label] of roots) {
    forms.push([root, label], [root.replaceAll("\\", "\\\\"), label], [root.replaceAll("\\", "/"), label]);
  }
  forms.sort((a, b) => b[0].length - a[0].length);
  const normalize = (value) => {
    if (typeof value === "string") {
      let text = value;
      for (const [form, label] of forms) text = text.split(form).join(label);
      return text;
    }
    if (typeof value === "function") return "[function]";
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  };
  return normalize;
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

const TOOLS = [
  { name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" } }, required: ["path"] } },
  { name: "bash", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string" }, mode: { enum: ["fg", "bg"] } }, required: ["command"] } },
  { name: "submit_review_findings_with_a_deliberately_long_tool_name", description: "Submit.", parameters: { type: "object", properties: { items: { type: "array", items: { anyOf: [{ const: "a" }, { const: "b" }] } }, meta: { type: "object", required: ["id"] } } } },
  { name: "antigravity", description: "wrapper", parameters: { type: "object", properties: {} } },
];

function captureClient(m) {
  const base = { prompt: "hello", modelId: "gemini-4-argon" };
  return {
    oneShot: m.client.buildOneShotAgyArgs({ ...base, cwd: "C:/work", conversationId: "cid-1", model: "gemini-4-argon", effort: "high", agent: "pi-native-x", mode: "plan", mcpDirectory: "C:/mcp", timeoutMs: 90_000 }),
    oneShotBudget: m.client.buildOneShotAgyArgs({ ...base, budget: {} }),
    oneShotMinimal: m.client.buildOneShotAgyArgs({ prompt: "-starts-with-dash" }),
    driver: m.client.buildDriverAgyArgs({ cwd: "C:/work", conversationId: "cid-1", model: "gemini-4-argon", effort: "low", agent: "a", mode: "accept-edits", mcpDirectory: "C:/mcp" }),
    driverMinimal: m.client.buildDriverAgyArgs({}),
    usageArgs: m.usage.buildAgyUsageArgs(),
    usageArgsShort: m.usage.buildAgyUsageArgs(1500),
  };
}

function captureWorkspace(m, tmp) {
  const out = {
    markdownDefault: m.workspace.createNativeAgentMarkdown("pi-native-abc", "System body.  \n\n"),
    markdownEvidence: m.workspace.createNativeAgentMarkdown("pi-native-abc", "System body.", m.profile.executionSurface.profiles.evidence_only_v1),
    serverName: m.workspace.cliServerName("p1234-abcdef123456"),
    toolName: m.workspace.cliToolName("bfixture1", "read"),
    longToolName: m.workspace.cliToolName("bfixture1", TOOLS[2].name),
  };
  for (const [label, profile] of [["default", m.profile.executionSurface.profiles.default], ["evidence", m.profile.executionSurface.profiles.evidence_only_v1]]) {
    const registration = new m.workspace.NativeWorkspaceRegistration({
      cwd: path.join(tmp, "project"), id: `fixture${label}1234`, dataDirectory: path.join(tmp, "data"),
      agentDir: path.join(tmp, "agent"), agentRoot: path.join(tmp, "agents"),
    });
    const tools = m.profile.nativeBridgedTools(TOOLS.slice(0, 3), profile);
    const wrote = registration.writeSystemPrompt("Pi system prompt.\n\nRules here.\n", tools, profile);
    const again = registration.writeSystemPrompt("Pi system prompt.\n\nRules here.\n", tools, profile);
    registration.registerMcpServer("http://127.0.0.1:1/mcp", "token-1");
    out[label] = {
      agentName: registration.agentName, serverName: registration.serverName,
      directory: registration.directory, configPath: registration.configPath,
      agentPath: registration.agentPath, schemaDirectory: registration.schemaDirectory,
      wrote, again, routingHint: registration.routingHint,
      agent: fs.readFileSync(registration.agentPath, "utf8"),
      mcpConfig: fs.readFileSync(registration.configPath, "utf8"),
    };
    registration.dispose();
    out[label].disposed = [fs.existsSync(registration.agentPath), fs.existsSync(registration.configPath)];
  }
  return out;
}

function captureProfile(m) {
  const { executionSurface } = m.profile;
  return {
    executionSurface,
    defaultNativeTools: m.profile.DEFAULT_NATIVE_TOOLS,
    readDefault: m.profile.readNativeProfile({}).id,
    hashDefault: m.profile.nativeContractHash(executionSurface.profiles.default, TOOLS.slice(0, 3)),
    hashEvidence: m.profile.nativeContractHash(executionSurface.profiles.evidence_only_v1, TOOLS.slice(0, 3)),
    hashReordered: m.profile.nativeContractHash(executionSurface.profiles.default, [...TOOLS.slice(0, 3)].reverse()),
    bridgedEvidence: m.profile.nativeBridgedTools(TOOLS, executionSurface.profiles.evidence_only_v1).map((tool) => tool.name),
    bridgeNames: m.names.bridgeToolNames("bfixture1", TOOLS.map((tool) => tool.name)),
    bridgeNamePrefixed: m.names.bridgeToolName("bfixture1", "read", "pi__"),
  };
}

function capturePrompts(m) {
  return {
    wrapperName: m.prompt.WRAPPER_TOOL_NAME,
    wrapperDescription: m.prompt.WRAPPER_TOOL_DESCRIPTION,
    pendingMessage: m.prompt.BRIDGE_PENDING_TOOL_MESSAGE,
    incompleteRun: m.prompt.agyIncompleteToolError("run_command"),
    incompleteRunTimeout: m.prompt.agyIncompleteToolError("run_command", "timeout waiting for response"),
    incompleteOther: m.prompt.agyIncompleteToolError("view_file", "boom"),
    attached: m.prompt.attachedImagesPrompt(["C:/a.png", "C:/b c.jpg"]),
    attachedNone: m.prompt.attachedImagesPrompt([]),
    restored: m.prompt.restoredPiContextPrompt("user:\nhi"),
    steerNotice: m.prompt.steerNoticePrompt("STEER"),
    stall: m.prompt.stallContinuationPrompt(),
  };
}

function captureInput(m, tmp) {
  const dir = path.join(tmp, "images");
  const user = (content) => ({ role: "user", content });
  const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
  const call = (id, name, args) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
  const result = (name, text) => ({ role: "toolResult", toolName: name, content: [{ type: "text", text }] });
  const summary = { role: "user", content: [{ type: "text", text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nEarlier work.\n</summary>" }] };
  const envelope = "<USER_REQUEST>\nPlease check.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>";
  const small = { messages: [
    { role: "system", content: "sys" }, summary, user("Task one."), call("c1", "read", { path: "a.txt" }), result("read", "contents"),
    answer("Done."), user([{ type: "text", text: "See image." }, { type: "image", data: PNG_1PX, mimeType: "image/png" }]),
    answer("Seen."), user(envelope), user([{ type: "image", data: PNG_1PX, mimeType: "image/png" }]),
  ] };
  const large = { messages: [
    summary, user("较早的要求：".repeat(9000)), call("c2", "bash", { command: "big" }), result("bash", "输出".repeat(30000)),
    user("最新补充：".repeat(9000)), answer("收到"), user("继续。"),
  ] };
  const huge = { messages: [summary, user("旧任务"), answer("好"), user("当前请求：".repeat(40000))] };
  return {
    envelope: m.input.piUserRequestText(envelope),
    envelopeUnknown: m.input.piUserRequestText("<USER_REQUEST>\nx\n</USER_REQUEST>\n<OTHER>y</OTHER>"),
    latestSmall: m.input.latestUserPrompt(small, dir),
    historySmall: m.input.piHistoryBootstrap(small, dir),
    latestLarge: m.input.latestUserPrompt(large, dir),
    historyLarge: m.input.piHistoryBootstrap(large, dir),
    historyHuge: m.input.piHistoryBootstrap(huge, dir),
    historyNone: m.input.piHistoryBootstrap({ messages: [user("only")] }, dir) ?? null,
  };
}

function captureModels(m) {
  const ids = ["gemini-4-argon", "gemini-3-flash", "claude-sonnet-5", "gpt-oss-120b", "unknown-model"];
  return {
    fallback: m.models.FALLBACK_MODELS,
    providerModels: m.models.FALLBACK_MODELS.map((model) => m.models.toProviderModel(model)),
    capabilities: Object.fromEntries(ids.map((id) => [id, m.models.capabilitiesForModel(id)])),
    pricing: Object.fromEntries(ids.map((id) => [id, m.models.pricingForModel(id, FIXED_NOW)])),
    pricingAfterIntro: m.models.pricingForModel("gemini-4-argon", Date.UTC(2027, 0, 1)),
    normalized: [m.models.normalizeAgyModelId("gemini-4-argon-high", "Gemini 4 Argon (High)"), m.models.normalizeAgyModelId("x", "X")],
    parsed: m.models.parseAgyModels("gemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-4-argon-high\tGemini 4 Argon (High)\nbad line\n"),
    merged: m.models.mergeAgyModels([{ id: "m-low", name: "M (Low)", supportedEfforts: [] }, { id: "m-high", name: "M (High)", supportedEfforts: [] }]),
    effort: m.models.FALLBACK_MODELS.map((model) => [model.id, m.models.resolveAgyModelEffort(model, "high"), m.models.resolveAgyModelEffort(model, undefined)]),
    ttl: [m.models.modelCacheTtlMs("live"), m.models.modelCacheTtlMs("fallback"), m.models.modelCacheTtlMs(undefined)],
    schedulingWindow: m.models.AGY_PI_SCHEDULING_CONTEXT_WINDOW,
    thinking: ["off", "minimal", "low", "medium", "high", "xhigh", "max", undefined].map((level) => m.provider.mapThinkingToEffort(level) ?? null),
    summary: [m.provider.isSummarizationRequest("<conversation>\nx"), m.provider.isSummarizationRequest("hi")],
  };
}

async function captureBridge(m) {
  const bridge = new m.bridge.AgyPiBridge("bfixture1");
  bridge.setToolSource(() => m.bridge.selectBridgedTools(TOOLS, ["read", "bash", TOOLS[2].name, "antigravity"]));
  const refreshed = bridge.refreshTools();
  bridge.setDynamicTools([{ name: "activate_skill", description: "Load a skill.", parameters: { type: "object" }, handler: async () => ({ content: "x" }) }]);
  bridge.requireToken("token-1");
  await bridge.start();
  // The MCP session id is a per-process random UUID; record shape and stability, not value.
  const sessions = new Set();
  const rpc = async (body, token = "token-1") => {
    const response = await fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json", "x-pi-bridge-token": token }, body: JSON.stringify(body) });
    const text = await response.text();
    const raw = response.headers.get("mcp-session-id");
    if (raw) sessions.add(raw);
    const session = raw === null ? null : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw) ? "<uuid>" : raw;
    return { status: response.status, session, body: text ? JSON.parse(text) : null };
  };
  const out = {
    selected: m.bridge.selectBridgedTools(TOOLS, ["read", "antigravity"]),
    canonical: m.bridge.canonicalJson({ b: [2, { d: 1, c: 0 }], a: 1 }),
    refreshed, revision: bridge.catalogRevision,
    initialize: await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
    initialized: await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }),
    list: await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    noActiveTurn: await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read", arguments: { path: "a" } } }),
    unknown: await rpc({ jsonrpc: "2.0", id: 4, method: "nope" }),
    forbidden: await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" }, "wrong"),
  };
  out.distinctSessionIds = sessions.size;
  await bridge.close();
  return out;
}

function captureSkills(m, tmp) {
  const skills = [
    { name: "alpha", description: "First   skill\nwith spacing.", filePath: path.join(tmp, "skills", "alpha", "SKILL.md") },
    { name: "alpha", description: "dup", filePath: path.join(tmp, "dup", "SKILL.md") },
    { name: "beta", description: "", filePath: path.join(tmp, "skills", "beta", "SKILL.md") },
    { name: "gamma", description: "x".repeat(200), filePath: path.join(tmp, "project", ".agents", "skills", "gamma", "SKILL.md") },
  ];
  return {
    toolName: m.skills.ACTIVATE_SKILL_TOOL_NAME,
    parameters: m.skills.activateSkillParameters(skills),
    description: m.skills.activateSkillDescription(skills),
    nonWorkspace: m.skills.nonWorkspaceSkills(skills, path.join(tmp, "project")).map((skill) => skill.name),
  };
}

function captureRender(m) {
  const theme = { fg: (color, text) => `<${color}>${text}</${color}>`, bold: (text) => `**${text}**` };
  const calls = [["view_file", { AbsolutePath: "C:/a/b.ts", StartLine: 3, EndLine: 9 }], ["run_command", { CommandLine: "npm test", Cwd: "C:/w" }],
    ["grep_search", { Query: "foo", SearchPath: "C:/w" }], ["generate_image", { Prompt: "cat" }], ["list_dir", { DirectoryPath: "C:/w" }], ["mystery", "not-an-object"]];
  return {
    labels: calls.map(([tool]) => m.render.agyToolLabel(tool)),
    formatted: calls.map(([tool, input]) => m.render.formatAgyCall(tool, input, theme)),
    summaries: [["grep_search", "a.ts:1:x\na.ts:2:y\nb.ts:3:z"], ["view_file", "l1\nl2\nl3"], ["run_command", ""], ["run_command", undefined]]
      .map(([tool, output]) => m.render.summarizeAgyResult(tool, output)),
  };
}

function captureState(m) {
  const conversation = { version: 1, kind: "conversation", sessionId: "s1", conversationId: "c1", cwd: "C:/p", modelId: "gemini-4-argon", turns: 3,
    usage: { input_tokens: 10 }, contextTokens: 100, systemPromptHash: "a".repeat(64), nativeContractHash: "b".repeat(64) };
  const custom = (data) => ({ type: "custom", customType: m.state.AGY_CONVERSATION_STATE_ENTRY, data });
  return {
    entry: m.state.AGY_CONVERSATION_STATE_ENTRY,
    parsed: [conversation, { version: 1, kind: "reset", sessionId: "s1", cwd: "C:/p" }, { ...conversation, systemPromptHash: "bad" }, { version: 2 }, null]
      .map((value) => m.state.parsePersistedAgyState(value) ?? null),
    restorable: [
      [custom(conversation)], [custom(conversation), { type: "label" }], [custom(conversation), { type: "message" }],
      [custom(conversation), { type: "compaction" }], [custom(conversation), custom({ version: 1, kind: "reset", sessionId: "s1", cwd: "C:/p" })],
    ].map((branch) => m.state.restorableAgyConversation(branch, "s1", "C:/p") ?? null),
    otherSession: m.state.restorableAgyConversation([custom(conversation)], "s2", "C:/p") ?? null,
  };
}

function captureEvents(m) {
  const lines = [
    { event: "init", conversation_id: "cid-9", init: { cwd: "C:/w", tools: ["view_file"] } },
    { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "user_input" } },
    { event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Hel" } },
    { event: "step_update", step_update: { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { parameters: { AbsolutePath: "C:/a.ts" } } } },
    { event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { parameters: { AbsolutePath: "C:/a.ts" }, output: "content" }, duration_seconds: 0.5 } },
    { event: "step_update", step_update: { step_index: 4, state: "ERROR", step_type: "tool", tool_name: "generate_image", tool_info: { error: { message: "429   rate limited" } } } },
    { event: "step_update", step_update: { step_index: 5, state: "DONE", step_type: "agent_response", text_delta: "lo", usage: { input_tokens: 10, cache_read_tokens: 90, thinking_tokens: 700 }, duration_seconds: 2 } },
    { event: "result", result: { conversation_id: "cid-9", status: "SUCCESS", response: "Hello", usage: { input_tokens: 10, output_tokens: 5 } } },
  ].map((line) => JSON.stringify(line));
  const outcome = m.reducer.newTurnOutcome();
  const activities = [];
  for (const line of [...lines, "not json", ""]) activities.push(...m.reducer.applyEvent(outcome, m.events.parseAgyLine(line)));
  const failed = m.reducer.newTurnOutcome();
  const failedActivities = m.reducer.applyEvent(failed, m.events.parseAgyLine(JSON.stringify({ event: "result", result: { status: "ERROR", error: "boom" } })));
  return {
    parsed: [...lines, "not json"].map((line) => m.events.parseAgyLine(line)),
    activities, outcome, failedActivities, failed,
    compaction: [[300_000, 80_000], [300_000, 250_000], [100_000, 10_000], [undefined, 5]].map(([a, b]) => m.compaction.detectAgyCompaction(a, b) ?? null),
    contextTokens: [m.compaction.agyContextTokens({ input_tokens: 5, cache_read_tokens: 7 }) ?? null, m.compaction.agyContextTokens({}) ?? null, m.compaction.agyContextTokens(undefined) ?? null],
  };
}

async function captureRuntime(m) {
  const adapter = runtimeAdapter(m);
  const scenarios = {};
  const pick = (request) => ({
    prompt: request.prompt, conversationId: request.conversationId ?? null, model: request.model ?? null, effort: request.effort ?? null,
    agent: request.agent ?? null, mode: request.mode ?? null, mcpDirectory: request.mcpDirectory ?? null, cwd: request.cwd ?? null,
    bridgeRevision: request.bridgeRevision ?? null, nativeTools: request.nativeTools ?? null,
    inactivityTimeoutMs: request.inactivityTimeoutMs ?? null, toolInactivityTimeoutMs: request.toolInactivityTimeoutMs ?? null,
    budget: request.budget !== undefined, childOwner: request.childOwner !== undefined,
  });
  const make = (script) => {
    const requests = [];
    const runtime = adapter.create({
      run: (request) => {
        requests.push(pick(request));
        const step = script.shift() ?? {};
        if (step.cid) request.onConversation?.(step.cid);
        if (step.kind === "hang") return new Promise(() => {});
        if (step.kind === "stall") return Promise.reject(adapter.stallError());
        request.onActivity?.({ type: "result", status: "OK", response: "ok", error: undefined, usage: step.usage });
        return Promise.resolve({ conversationId: step.cid, status: "OK", response: "ok", error: undefined, usage: step.usage, activities: [], finished: true });
      },
      snapshot: () => ({ mode: "one-shot", state: "idle", lifecycle: [] }),
      close: async () => {},
    });
    return { runtime, requests };
  };
  const drain = async (controller) => {
    const types = [];
    for (;;) {
      const activity = await controller.next();
      if (!activity) break;
      types.push(activity.type);
      if (activity.type === "result") break;
    }
    return types;
  };
  const view = async (runtime) => {
    await settle();
    const s = await runtime.snapshot();
    return { conversationId: s.conversationId ?? null, model: s.model ?? null, cwd: s.cwd ?? null, turns: s.turns,
      conversationUsage: s.conversationUsage, systemPromptHash: s.systemPromptHash ?? null, nativeContractHash: s.nativeContractHash ?? null };
  };
  const base = { modelId: "gemini-fixture", systemPromptHash: "h1", nativeContractHash: "c1" };

  {
    const { runtime, requests } = make([{ cid: "native-1", usage: { input_tokens: 100 } }, { cid: "native-1", usage: { input_tokens: 150, cache_read_tokens: 90 } },
      { cid: "native-2", usage: { input_tokens: 80 } }, { cid: "native-3", usage: { input_tokens: 20 } }]);
    const steps = [];
    await runtime.setSession("fixture-project", "gemini-fixture", false);
    const turn = async (request) => {
      const controller = await runtime.begin(request);
      await settle();
      const activities = await drain(controller);
      await runtime.finish();
      steps.push({ activities, snapshot: await view(runtime) });
    };
    await turn({ ...base, prompt: "first", historyBootstrap: "BOOT", effort: "high", agent: "pi-native-x", mcpDirectory: "mcp-dir", bridgeRevision: "r1", nativeTools: ["view_file"] });
    await turn({ ...base, prompt: "second", historyBootstrap: "BOOT" });
    await turn({ ...base, prompt: "third", systemPromptHash: "h2", historyBootstrap: "BOOT2" });
    await runtime.setSession("other-project", undefined, false);
    await turn({ ...base, systemPromptHash: "h2", prompt: "fourth", historyBootstrap: "BOOT3" });
    await runtime.setSession("other-project", undefined, true);
    steps.push({ afterReset: await view(runtime) });
    await runtime.close();
    scenarios.sequence = { requests, steps };
  }
  {
    const { runtime, requests } = make([{ cid: "native-saved", usage: { input_tokens: 300 } }, { cid: "native-saved", usage: { input_tokens: 320 } }]);
    await runtime.restore({ conversationId: "native-saved", cwd: "fixture-project", modelId: "gemini-fixture", turns: 4, usage: { input_tokens: 290 }, systemPromptHash: "h1", nativeContractHash: "c1" });
    const restored = await view(runtime);
    const steps = [];
    for (const prompt of ["resumed", "again"]) {
      const controller = await runtime.begin({ ...base, prompt, historyBootstrap: "BOOT", bridgeBootstrap: "BRIDGE" });
      await settle();
      steps.push({ activities: await drain(controller) });
      await runtime.finish();
      steps.at(-1).snapshot = await view(runtime);
    }
    await runtime.close();
    scenarios.restore = { restored, requests, steps };
  }
  {
    const { runtime, requests } = make([{ kind: "hang", cid: "native-h" }, { cid: "native-h", usage: { input_tokens: 40 } }]);
    await runtime.setSession("fixture-project", "gemini-fixture", false);
    const live = await runtime.begin({ ...base, prompt: "long task", historyBootstrap: "BOOT" });
    await settle();
    const controller = await runtime.begin({ ...base, prompt: "steer", historyBootstrap: "BOOT" });
    await settle();
    scenarios.steer = { requests, sameTurn: controller === live, prompt: controller.prompt,
      pendingSteer: controller.pendingSteer() ?? null, snapshot: await view(runtime) };
    await runtime.close();
  }
  {
    const { runtime, requests } = make([{ kind: "hang", cid: "native-h" }, { cid: "native-h", usage: { input_tokens: 40 } }]);
    await runtime.setSession("fixture-project", "gemini-fixture", false);
    await runtime.begin({ ...base, prompt: "long task", historyBootstrap: "BOOT" });
    await settle();
    await runtime.finish(); // the stream ended without its result: detached
    const controller = await runtime.begin({ ...base, prompt: "replacement", historyBootstrap: "BOOT" });
    await settle();
    const activities = await drain(controller);
    await runtime.finish();
    scenarios.replace = { requests, activities, snapshot: await view(runtime) };
    await runtime.close();
  }
  {
    const previous = process.env.AGY_STALL_RETRY_BACKOFF_MS;
    process.env.AGY_STALL_RETRY_BACKOFF_MS = "0";
    try {
      const { runtime, requests } = make([{ kind: "stall", cid: "native-s" }, { cid: "native-s", usage: { input_tokens: 60 } }]);
      await runtime.setSession("fixture-project", "gemini-fixture", false);
      const controller = await runtime.begin({ ...base, prompt: "stall me", historyBootstrap: "BOOT" });
      await settle();
      const activities = await drain(controller);
      await runtime.finish();
      scenarios.stall = { requests, activities, snapshot: await view(runtime) };
      await runtime.close();
    } finally {
      if (previous === undefined) delete process.env.AGY_STALL_RETRY_BACKOFF_MS;
      else process.env.AGY_STALL_RETRY_BACKOFF_MS = previous;
    }
  }
  return scenarios;
}

async function captureExtension(tmp) {
  const rec = { commands: [], tools: [], events: [], providers: [], flags: [], renderers: [], other: [] };
  const known = {
    registerCommand: (name, def) => rec.commands.push({ name, description: def?.description ?? null }),
    registerTool: (def) => rec.tools.push({ name: def.name, label: def.label, description: def.description, parameters: def.parameters }),
    on: (event) => rec.events.push(event),
    registerProvider: (name, config) => rec.providers.push({ name, config }),
    registerFlag: (name, def) => rec.flags.push({ name, def }),
    registerEntryRenderer: (type) => rec.renderers.push(type),
    registerMessageRenderer: (type) => rec.renderers.push(`message:${type}`),
    getActiveTools: () => [], getAllTools: () => [], getFlag: () => undefined,
  };
  const pi = new Proxy({}, { get: (_target, key) => (key in known ? known[key] : (...args) => { rec.other.push(String(key)); return undefined; }) });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(tmp, "pi-agent");
  try {
    const extension = await import("../../index.ts");
    extension.default(pi);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  return rec;
}

export async function capture() {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-golden-"));
  try {
    const m = await loadModules();
    const result = {
      client: captureClient(m),
      workspace: captureWorkspace(m, tmp),
      profile: captureProfile(m),
      prompts: capturePrompts(m),
      input: captureInput(m, tmp),
      models: captureModels(m),
      bridge: await captureBridge(m),
      skills: captureSkills(m, tmp),
      render: captureRender(m),
      state: captureState(m),
      events: captureEvents(m),
      runtime: await captureRuntime(m),
      extension: await captureExtension(tmp),
    };
    const normalize = normalizer([[tmp, "<TMP>"], [os.homedir(), "<HOME>"]]);
    return JSON.parse(JSON.stringify(normalize(result)));
  } finally {
    Date.now = realNow;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
