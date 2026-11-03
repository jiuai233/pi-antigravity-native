
import { AgyTurnController } from '../src/runtime/turn.ts';
import { streamAntigravity } from '../src/provider/stream.ts';
// Opt-in installed-host integration: only the AGY activity source is scripted.
// No native process, network request, user settings, or credentials are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { fixture } from './offline-fixture.mjs';
import { registerWrapperTool } from '../src/extension/wrapper-tool.ts';
import { AgyReplayStore } from '../src/provider/replay.ts';
import { wrapperToolActiveAfterModelSwitch } from '../src/extension/wrapper-activation.ts';

const sdkRoot = process.env.PI_STACK_PI_ROOT;
assert.ok(sdkRoot, 'Set PI_STACK_PI_ROOT to the installed pi-coding-agent package for this opt-in host test');
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href);
const aiRoot = path.dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(path.join(sdkRoot, 'package.json')).href));
const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(aiRoot, 'dist/index.js')).href);

for (const restricted of [true, false]) {
  test(`real Pi JSONL ${restricted ? 'with a read-only allowlist uses replay text' : 'without an allowlist keeps successful wrapper cards'}`, async t => {
    const evidence = process.env.AGY_REPLAY_EVIDENCE;
    const root = evidence ? path.join(path.resolve(evidence), restricted ? 'restricted' : 'unrestricted')
      : fs.mkdtempSync(path.join(os.tmpdir(), 'agy-replay-sdk-'));
    fs.mkdirSync(root, { recursive: true });
    const agentDir = path.join(root, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider('antigravity', {
      api: 'offline-agy-replay', apiKey: 'offline-fixture-not-a-secret', baseUrl: 'http://127.0.0.1:9/never-used',
      models: [{ id: 'replay-fixture', name: 'Offline replay fixture', reasoning: false, input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
    });
    const replay = new AgyReplayStore();
    let wrapper;
    const nativeOutput = 'Recorded native view_file body\n' + 'native line\n'.repeat(1500) + 'NATIVE_TAIL_REQUIRED';
    const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=' };
    const f = fixture({ clock: false,
      latestUserPrompt: () => ({ prompt: 'fixture' }), piHistoryBootstrap: () => undefined,
      normalizeContext: context => context, getCurrentSystemPrompt: () => '',
      readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
      resolveBridgeResultsFromContext: () => 0, calculateCost: () => {},
      createAssistantMessageEventStream,
      WRAPPER_TOOL_NAME: 'antigravity',
      createAntigravityRuntime: () => { throw new Error('Unexpected native runtime'); },
      readNativeToolResult: (_conversation, step) => ({ args: { AbsolutePath: step === 1 ? 'never-open.mp4' : 'never-open.wav' }, output: nativeOutput,
        ...(step === 1 ? { content: [{ type: 'text', text: nativeOutput }, image] } : {}),
      }),
    });
    const controller = new AgyTurnController('fixture');
    for (const [stepId, name, args, output] of [
      [1, 'view_file', { AbsolutePath: 'never-open.mp4' }, 'CLI summary'],
      [2, 'view_file', { AbsolutePath: 'never-open.wav' }, 'CLI summary'],
      [3, 'read_file', { path: 'never-open.txt' }, 'Recorded read_file body'],
    ]) {
      controller.push({ type: 'tool_start', stepId, name, args });
      controller.push({ type: 'tool_done', stepId, name, args, output });
    }
    controller.push({ type: 'result', status: 'OK', response: 'Native turn finished' });
    controller.close();
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [pi => {
        registerWrapperTool({ registerTool: tool => { wrapper = tool; pi.registerTool(tool); } }, replay);
        pi.on('session_start', (_event, ctx) => {
          const next = wrapperToolActiveAfterModelSwitch(pi.getActiveTools(), 'antigravity', ctx.model?.provider, 'antigravity');
          if (next) pi.setActiveTools([...next]);
        });
      }],
    });
    await loader.reload();
    let session;
    try {
      ({ session } = await createAgentSession({
        cwd: root, agentDir, modelRuntime: runtime, model: runtime.getModel('antigravity', 'replay-fixture'),
        thinkingLevel: 'off', resourceLoader: loader, settingsManager,
        sessionManager: SessionManager.create(root, path.join(root, 'sessions')),
        ...(restricted ? { tools: ['read'] } : {}),
      }));
      await session.bindExtensions({});
      const before = session.getActiveToolNames();
      assert.equal(before.includes('antigravity'), !restricted);
      if (restricted) assert.deepEqual(before, ['read']);
      const executions = [];
      session.subscribe(event => { if (event.type === 'tool_execution_start') executions.push(event.toolName); });
      session.agent.streamFunction = streamAntigravity({ ...f.providerOptions,
        runtime: { beginStreamTurn: () => controller, finishTurn() {}, steerActiveTurn() {}, snapshot: () => ({ cwd: root, conversationId: 'fixture' }) },
        replay, bridge: { refreshTools() {}, serverName: 'fixture' },
        isActiveTool: name => session.getActiveToolNames().includes(name),
      });
      await session.prompt('Replay the scripted native results; do not execute any new native action');
      const jsonl = fs.readFileSync(session.sessionFile, 'utf8');
      const messages = jsonl.trim().split('\n').map(line => JSON.parse(line).message).filter(Boolean);
      const results = messages.filter(message => message.role === 'toolResult');
      assert.doesNotMatch(jsonl, /Tool antigravity not found/);
      assert.ok(jsonl.includes('NATIVE_TAIL_REQUIRED'));
      assert.ok(jsonl.includes('Recorded read_file body'));
      assert.ok(jsonl.includes('Native turn finished'));
      assert.equal(results.some(result => result.isError), false);
      assert.deepEqual(session.getActiveToolNames(), before);
      assert.deepEqual(executions, restricted ? [] : ['antigravity', 'antigravity', 'antigravity']);
      assert.equal(results.length, restricted ? 0 : 3);
      if (restricted) assert.match(jsonl, /AGY replay only: view_file; no Pi tool executed/);
      else {
        assert.equal(results[0].content[0].text, nativeOutput);
        assert.equal(results[0].content[1].type, 'image');
        assert.equal(results[0].content[1].data, image.data);
        assert.equal(messages.filter(message => message.role === 'assistant').length, 2);
      }
      assert.equal(replay.size, 0);
      // The unchanged wrapper cannot execute an arbitrary tool or command.
      await assert.rejects(wrapper.execute('unrecorded-call', { tool: 'run_command', input: {} }), /No recorded antigravity result/);
      fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify({
        pass: true, sdkRoot, sdkVersion: JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version,
        restricted, activeTools: before, executions, toolResults: results.length,
        sessionFile: session.sessionFile, native_processes: 0, network_requests: 0,
      }, null, 2) + '\n');
      t.diagnostic(`actual SDK JSONL: ${session.sessionFile}`);
    } finally {
      session?.dispose();
      if (!evidence) fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
