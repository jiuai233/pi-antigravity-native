
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { streamAntigravity } from '../src/provider/stream.ts';
// Real installed SDK, real QuickJS codemode and loopback MCP; no AGY/model request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { AgyPiBridge, resolveBridgeResultsFromContext } from '../src/extension/bridge.ts';
import { executionSurface } from '../src/native/native-profile.ts';
import { NativeWorkspaceRegistration } from '../src/native/native-workspace.ts';
import { AgyReplayStore } from '../src/provider/replay.ts';
import { latestUserPrompt } from '../src/input/pi-input.ts';
import { fixture } from './offline-fixture.mjs';
import { ToolProjection } from '../src/extension/tool-projection.ts';
import { AgyPrefixAudit, PREFIX_AUDIT_ENTRY } from '../src/native/prefix-audit.ts';

const sdkRoot = process.env.PI_STACK_PI_ROOT;
assert.ok(sdkRoot, 'PI_STACK_PI_ROOT must select the installed SDK');
const hostRequire = createRequire(path.join(sdkRoot, 'package.json'));
const aiRoot = path.dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(path.join(sdkRoot, 'package.json')).href));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href);
const { createAssistantMessageEventStream, normalizeContext, getCurrentSystemPrompt, getCurrentTools } =
  await import(pathToFileURL(path.join(aiRoot, 'dist/index.js')).href);
const { createCodemodeExtension } = await import(pathToFileURL(path.join(sdkRoot, 'dist/extensions/codemode/index.js')).href);
const { Type } = await import(pathToFileURL(hostRequire.resolve('typebox')).href);

for (const mode of ['on', 'only']) {
  test(`SDK ${mode}: two reads share one bridge call and dynamic discovery works in the same task`, { timeout: 30000 }, async t => {
    const evidence = process.env.AGY_TOOL_FLOW_EVIDENCE;
    const root = evidence ? path.join(path.resolve(evidence), mode) : fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sdk-codemode-'));
    fs.mkdirSync(root, { recursive: true });
    const agentDir = path.join(root, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
    fs.writeFileSync(path.join(root, 'a.txt'), 'FIRST_READ_EXACT');
    fs.writeFileSync(path.join(root, 'b.txt'), 'SECOND_READ_EXACT');
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerProvider('antigravity', {
      api: 'offline-agy-tool-flow', apiKey: 'offline-fixture', baseUrl: 'http://127.0.0.1:9/never-used',
      models: [{ id: 'tool-flow', name: 'Offline AGY tool flow', reasoning: false, input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
    });
    const settingsManager = SettingsManager.inMemory({ codemode: { mode, inlineBudget: mode === 'only' ? 0 : 3000 },
      retry: { enabled: false }, compaction: { enabled: false } });
    const hooks = [];
    let persistAudit;
    const audit = new AgyPrefixAudit(event => persistAudit(event));
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [createCodemodeExtension({ models: false }), pi => {
        persistAudit = event => pi.appendEntry(PREFIX_AUDIT_ENTRY, event);
        pi.registerTool({ name: 'enable_fixture', label: 'Enable fixture', description: 'Enable the late fixture tool.',
          parameters: Type.Object({}), defaultActive: false,
          async execute() { pi.setActiveTools([...pi.getActiveTools(), 'late_fixture']); return { content: [{ type: 'text', text: 'enabled' }], details: {} }; } });
        pi.registerTool({ name: 'late_fixture', label: 'Late fixture', description: 'Dynamically discovered late fixture.',
          parameters: Type.Object({}), defaultActive: false,
          async execute() { return { content: [{ type: 'text', text: 'LATE_TOOL_EXACT' }], details: {} }; } });
        pi.on('session_start', () => pi.setActiveTools(['read', 'codemode', 'enable_fixture']));
        pi.on('tool_call', event => { hooks.push(event.toolName); });
      }],
    });
    await loader.reload();
    const workspace = new NativeWorkspaceRegistration({ cwd: root, id: `sdk-codemode-${mode}-12345678`, agentDir,
      agentRoot: path.join(root, 'native-agents'), dataDirectory: path.join(root, 'cli') });
    const bridge = new AgyPiBridge(workspace.serverName);
    bridge.setToolPrefix('');
    const f = fixture({ clock: false, latestUserPrompt, piHistoryBootstrap: () => undefined,
      normalizeContext, getCurrentSystemPrompt, getCurrentTools,
      readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
      resolveBridgeResultsFromContext, calculateCost: () => {}, createAssistantMessageEventStream,
      WRAPPER_TOOL_NAME: 'antigravity' });

    const projection = new ToolProjection({ bridge, skills: () => [],
      readProfile: () => executionSurface.profiles.default });
    const captures = [];
    let rpcId = 0;
    let bridgeCalls = 0;
    let nativeRequests = 0;
    const rpc = async (method, params) => {
      const response = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.error, undefined);
      return body.result;
    };
    const rt = createAntigravityRuntime(async request => {
      nativeRequests++;
      request.onConversation('offline-sdk-native');
      const firstList = (await rpc('tools/list')).tools;
      assert.equal(firstList.some(tool => tool.name === 'read'), mode === 'on');
      const coder = firstList.find(tool => tool.name === 'codemode');
      assert.ok(coder.description.includes('searchTools'));
      assert.ok(coder.inputSchema.properties.code);
      const agent = fs.readFileSync(workspace.agentPath, 'utf8');
      assert.ok(agent.includes(coder.description));
      const code = 'const r = await Promise.allSettled([tools.read({path:"a.txt"}),tools.read({path:"b.txt"})]); text(r); await tools.enable_fixture({});';
      bridgeCalls++;
      const readResult = await rpc('tools/call', { name: 'codemode', arguments: { code } });
      assert.equal(readResult.isError, false);
      assert.ok(JSON.stringify(readResult).includes('FIRST_READ_EXACT'));
      assert.ok(JSON.stringify(readResult).includes('SECOND_READ_EXACT'));
      const nextList = (await rpc('tools/list')).tools;
      assert.equal(nextList.some(tool => tool.name === 'late_fixture'), mode === 'on');
      bridgeCalls++;
      const late = await rpc('tools/call', { name: 'codemode', arguments: {
        code: 'text(await searchTools("late_fixture")); text(await tools.late_fixture({}));',
      } });
      assert.equal(late.isError, false);
      assert.ok(JSON.stringify(late).includes('LATE_TOOL_EXACT'));
      const result = { status: 'OK', response: 'CODEMODE_TASK_COMPLETE', conversationId: 'offline-sdk-native' };
      request.onActivity({ type: 'result', ...result });
      return result;
    }, undefined, f.childrenHost);
    const service = rt;
    let session;
    try {
      await service.setSession(root, 'tool-flow');
      bridge.setOnCall(call => service.pushBridgeCall(call));
      bridge.setOnSettled(id => service.finishBridgeCall(id));
      await bridge.start();
      workspace.registerMcpServer(bridge.url, 'offline-fixture');
      ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime,
        model: modelRuntime.getModel('antigravity', 'tool-flow'), thinkingLevel: 'off',
        resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(root, path.join(root, 'sessions')) }));
      await session.bindExtensions({});
      const provider = streamAntigravity({ ...f.providerOptions, runtime: rt, replay: new AgyReplayStore(), bridge,
        isActiveTool: name => session.getActiveToolNames().includes(name),
        prepareAgent: async (prompt, tools) => {
          captures.push(tools.map(tool => ({ name: tool.name, description: tool.description })));
          const prepared = projection.prepare(workspace, prompt, tools);
          const before = JSON.stringify(session.agent.state.messages);
          audit.recordLocal(prompt, tools, prepared);
          assert.equal(JSON.stringify(session.agent.state.messages), before, 'audit journal must not enter model context');
          assert.equal(workspace.agentBody, prepared.agentBody, 'audit must not rewrite the agent');
          return prepared;
        } });
      session.agent.streamFunction = provider;
      await session.prompt('Read the two fixtures and use the newly enabled tool in this same task.');
      const entries = fs.readFileSync(session.sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.ok(entries.some(entry => entry.type === 'custom' && entry.customType === PREFIX_AUDIT_ENTRY));
      assert.doesNotMatch(JSON.stringify(session.agent.state.messages), /pi-antigravity-prefix-audit/);
      assert.equal(nativeRequests, 1);
      assert.equal(bridgeCalls, 2); // One read batch, then one dynamic-discovery verification.
      assert.equal(hooks.filter(name => name === 'read').length, 2);
      assert.equal(hooks.filter(name => name === 'codemode').length, 2);
      assert.equal(hooks.filter(name => name === 'late_fixture').length, 1);
      assert.equal(captures[0].some(tool => tool.name === 'read'), mode === 'on');
      if (mode === 'on') assert.match(captures[0].find(tool => tool.name === 'read').description, /codemode/i);
      else assert.doesNotMatch(captures[0].find(tool => tool.name === 'codemode').description, /###\s+`read`/);
      const summary = { mode, sdkVersion: JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version,
        nativeExecutorRequests: nativeRequests, readBatchBridgeCalls: 1, dynamicDiscoveryBridgeCalls: 1,
        readExecutions: hooks.filter(name => name === 'read').length, lateToolExecutions: 1,
        declaredToolsByRequest: captures.map(tools => tools.map(tool => tool.name)), sessionFile: session.sessionFile,
        auditJournalEntries: entries.filter(entry => entry.type === 'custom' && entry.customType === PREFIX_AUDIT_ENTRY).length,
        auditInModelContext: false, realAgyProcesses: 0, externalModelCalls: 0 };
      fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
      t.diagnostic(JSON.stringify(summary));
    } finally {
      session?.dispose();
      await bridge.close();
      await service.close();
      workspace.dispose();
      if (!evidence) fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
