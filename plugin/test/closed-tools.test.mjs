
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { executionSurface, readNativeProfile, nativeBridgedTools, nativeContractHash } from '../src/native/native-profile.ts';
import { NativeWorkspaceRegistration } from '../src/native/native-workspace.ts';
import { AgyPiBridge } from '../src/extension/bridge.ts';
import { parsePersistedAgyState, restorableAgyConversation } from '../src/native/conversation-state.ts';
import { fixture, flush } from './offline-fixture.mjs';

const submit = { name: 'submit_task_result', description: 'Submit the dossier.', parameters: {
  type: 'object', properties: { verdict: { enum: ['done'] }, output: { type: 'object',
    properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } },
  required: ['verdict', 'output'], additionalProperties: false,
} };
const rootFixture = run => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-closed-'));
  return Promise.resolve().then(() => run(root)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
};

test('only an explicit worker package profile closes native IO; submit-only is not a profile', () => rootFixture(root => {
  const file = path.join(root, 'package.json');
  const env = { PI_WORKER_TASK_PACKAGE_PATH: file, SUBAGENT_PROJECT_ROOT: root };
  const save = task => fs.writeFileSync(file, JSON.stringify({ task_package: task }));
  const task = { package_id: 'fixture', agent: { role: 'reviewer' }, tool_contract: { allowed: ['submit_task_result'] } };
  assert.deepEqual(readNativeProfile({}).native_tools, ['view_file', 'generate_image']);
  save(task);
  assert.deepEqual(readNativeProfile(env).native_tools, ['view_file', 'generate_image']);
  task.extensions = { review_execution: { profile: 'evidence_only_v1' } }; save(task);
  assert.deepEqual(readNativeProfile({ PI_WORKER_TASK_PACKAGE_PATH: file }).native_tools, ['view_file', 'generate_image']);
  assert.equal(readNativeProfile(env).id, 'evidence_only_v1');
  assert.deepEqual(readNativeProfile(env).native_tools, []);
  delete task.agent; save(task);
  assert.equal(readNativeProfile(env).id, 'default');
}));

test('closed agent inlines the complete actual submission schema and bridge executes unchanged arguments', () => rootFixture(async root => {
  const profile = executionSurface.profiles.evidence_only_v1;
  const tools = nativeBridgedTools([submit, { name: 'read', parameters: {} }], profile);
  assert.deepEqual(tools, [submit]);
  const workspace = new NativeWorkspaceRegistration({ cwd: root, id: 'closed-12345678',
    agentDir: path.join(root, 'pi'), agentRoot: path.join(root, 'agents'), dataDirectory: path.join(root, 'cli') });
  const bridge = new AgyPiBridge(workspace.serverName);
  let received;
  try {
    workspace.writeSystemPrompt('Closed dossier.', tools, profile);
    const agent = fs.readFileSync(workspace.agentPath, 'utf8');
    assert.match(agent, /^tools: \[\]$/m);
    assert.doesNotMatch(agent, /native view_file|read uses ToolName/i);
    const schemas = JSON.parse(agent.match(/<pi_tool_schemas>\n([\s\S]*?)\n<\/pi_tool_schemas>/)[1]);
    assert.deepEqual(schemas[0].parameters, submit.parameters);
    const args = { verdict: 'done', output: { nonce: 'supplied-source-data' } };
    bridge.setToolPrefix('');
    bridge.setToolSource(() => tools);
    bridge.refreshTools();
    bridge.setOnCall(call => { received = call; queueMicrotask(() => bridge.resolveCall(call.id,
      { content: [{ type: 'text', text: 'submitted' }], isError: false })); return true; });
    await bridge.start();
    const reply = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: submit.name, arguments: args } }) });
    const result = await reply.json();
    assert.equal(result.result.isError, false, JSON.stringify(result));
    assert.deepEqual(received.args, args);
  } finally { await bridge.close(); workspace.dispose(); }
}));

test('default main and submit-only native IO plus Pi+native combinations retain their native tools', () => rootFixture(root => {
  const workspace = new NativeWorkspaceRegistration({ cwd: root, id: 'normal-12345678',
    agentDir: path.join(root, 'pi'), agentRoot: path.join(root, 'agents'), dataDirectory: path.join(root, 'cli') });
  try {
    for (const tools of [[], [submit], [submit, { name: 'read', parameters: { type: 'object' } }]]) {
      workspace.writeSystemPrompt('Native IO is legitimate.', nativeBridgedTools(tools, executionSurface.profiles.default), executionSurface.profiles.default);
      assert.match(fs.readFileSync(workspace.agentPath, 'utf8'), /^tools: \[view_file, generate_image\]$/m);
    }
  } finally { workspace.dispose(); }
}));

test('native contract fingerprint survives real persisted state parsing and branch restore', () => {
  const hash = nativeContractHash(executionSurface.profiles.evidence_only_v1, [submit]);
  const data = { version: 1, kind: 'conversation', sessionId: 'pi-session', conversationId: 'closed-native',
    cwd: 'workspace', modelId: 'fixture', turns: 2, usage: {}, nativeContractHash: hash };
  const branch = [{ type: 'custom', customType: 'pi-antigravity-conversation-state', data: JSON.parse(JSON.stringify(data)) }];
  assert.equal(restorableAgyConversation(branch, 'pi-session', 'workspace').nativeContractHash, hash);
  assert.equal(parsePersistedAgyState({ ...data, nativeContractHash: 'invalid' }), undefined);
  assert.equal(nativeContractHash(executionSurface.profiles.evidence_only_v1, [JSON.parse(JSON.stringify(submit))]), hash);
});

test('same native contract resumes; profile or actual Pi schema changes start a fresh native conversation', async () => {
  const f = fixture();
  const requests = [];
  const rt = createAntigravityRuntime(async request => {
    requests.push(request); request.onConversation(`native-${requests.length}`);
    return { status: 'OK', conversationId: `native-${requests.length}`, finished: true };
  }, undefined, f.childrenHost);
  const service = rt;
  const normal = nativeContractHash(executionSurface.profiles.default, [submit]);
  const closed = nativeContractHash(executionSurface.profiles.evidence_only_v1, [submit]);
  const changed = nativeContractHash(executionSurface.profiles.evidence_only_v1,
    [{ ...submit, parameters: { ...submit.parameters, required: ['verdict'] } }]);
  const turn = async hash => {
    const controller = await service.beginStreamTurn({ prompt: `turn-${requests.length}`, modelId: 'fixture',
      systemPromptHash: 'fixed-system', nativeContractHash: hash, nativeTools: hash === normal ? ['view_file', 'generate_image'] : [], historyBootstrap: 'prior branch history' });
    await flush(); while (await controller.next()) {} await service.finishTurn();
  };
  try {
    await turn(normal); await turn(normal); await turn(closed); await turn(closed); await turn(changed);
    assert.equal(requests[1].conversationId, 'native-1');
    assert.equal(requests[2].conversationId, undefined);
    assert.equal(requests[2].nativeTools.length, 0);
    assert.match(requests[2].prompt, /prior branch history/);
    assert.equal(requests[3].conversationId, 'native-3');
    assert.equal(requests[4].conversationId, undefined);
    assert.equal((await service.snapshot()).nativeContractHash, changed);
    await service.restoreConversation({ conversationId: 'old-wide', modelId: 'fixture', cwd: 'fixture-workspace', turns: 1, usage: {}, systemPromptHash: 'fixed-system' });
    await turn(closed);
    assert.equal(requests.at(-1).conversationId, undefined, 'legacy state cannot prove equal native contract');
  } finally { await service.close(); }
});
