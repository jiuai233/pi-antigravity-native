
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgyTurnController } from '../src/runtime/turn.ts';
import { streamAntigravity } from '../src/provider/stream.ts';
import { bridgeToolName, bridgeToolNames } from '../src/native/native-tool-names.ts';
import { cliToolName, NativeWorkspaceRegistration } from '../src/native/native-workspace.ts';
import { AgyPiBridge, resolveBridgeResultsFromContext } from '../src/extension/bridge.ts';
import { executionSurface } from '../src/native/native-profile.ts';
import { AgyReplayStore } from '../src/provider/replay.ts';
import { fixture, memoryStream } from './offline-fixture.mjs';

// The actual failing Pi tool name, not an invented oversized schema.
const longName = 'edge-devtools-unattended_performance_analyze_insight';
const otherName = `${longName}_other`;
const serverName = 'bc214e7b6';
const parameters = { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'] };
const tools = [longName, otherName, 'read'].map(name => ({ name, description: `Run ${name}.`, parameters }));

test('CLI names preserve short/boundary names and stably distinguish equal long stems', () => {
  assert.equal(`mcp_${serverName}_${longName}`.length, 66);
  for (const prefix of ['', 'pi__']) {
    assert.equal(bridgeToolName(serverName, 'read', prefix), `${prefix}read`);
    const boundary = 'x'.repeat(64 - `mcp_${serverName}_${prefix}`.length);
    assert.equal(cliToolName(serverName, boundary, prefix), `mcp_${serverName}_${prefix}${boundary}`);
    const a = bridgeToolName(serverName, longName, prefix);
    const b = bridgeToolName(serverName, otherName, prefix);
    assert.notEqual(a, b);
    assert.equal(cliToolName(serverName, longName, prefix).length, 64);
    assert.match(cliToolName(serverName, longName, prefix), /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(bridgeToolName(serverName, longName, prefix), a);
    assert.deepEqual([...bridgeToolNames(serverName, [otherName, longName], prefix)].sort(),
      [...bridgeToolNames(serverName, [longName, otherName], prefix)].sort());
  }
  // Even a literal short name equal to a generated alias must never execute the wrong tool.
  const alias = bridgeToolName(serverName, longName);
  assert.throws(() => bridgeToolNames(serverName, [longName, alias]), /collision/i);
});

test('CLI alias events suppress duplicate cards while the bridge emits the original Pi tool', async () => {
  const f = fixture({
    latestUserPrompt: () => ({ prompt: 'fixture' }), piHistoryBootstrap: () => undefined,
    normalizeContext: context => context, getCurrentSystemPrompt: () => '',
    readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
    resolveBridgeResultsFromContext: () => 0, calculateCost: () => {},
    createAssistantMessageEventStream: memoryStream,
    createAntigravityRuntime: () => { throw new Error('Unexpected isolated runtime'); },
  });
  const controller = new AgyTurnController('fixture');
  const args = { ServerName: serverName, ToolName: bridgeToolName(serverName, longName), Arguments: { nonce: 'event' } };
  controller.push({ type: 'tool_start', stepId: 1, name: 'call_mcp_tool', args });
  controller.push({ type: 'tool_done', stepId: 1, name: 'call_mcp_tool', args, output: 'fixture' });
  controller.push({ type: 'bridge_call', id: 'bridge-long', name: longName, args: args.Arguments });
  const stream = streamAntigravity({ ...f.providerOptions,
    runtime: { beginStreamTurn: () => controller, finishTurn() {}, steerActiveTurn() {}, snapshot: () => ({}) },
    replay: new AgyReplayStore(), bridge: { refreshTools() {}, serverName },
    isActiveTool: name => name === longName,
  })({ id: 'fixture', api: 'fixture', provider: 'antigravity' }, { messages: [] }, {});
  await stream.ended;
  const message = stream.events.at(-1).message;
  assert.equal(message.stopReason, 'toolUse');
  const calls = message.content.filter(block => block.type === 'toolCall');
  assert.deepEqual(Array.from(calls, call => call.name), [longName]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].arguments)), args.Arguments);
});

test('long catalog/schema aliases execute the original Pi tools over real loopback HTTP', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-long-names-'));
  const workspace = new NativeWorkspaceRegistration({ cwd: root, id: 'long-c214e7b6', serverName,
    agentDir: path.join(root, 'pi'), agentRoot: path.join(root, 'agents'), dataDirectory: path.join(root, 'cli') });
  const bridge = new AgyPiBridge(serverName);
  const received = [];
  const executed = [];
  const implementations = new Map(tools.map(tool => [tool.name, args => {
    executed.push(tool.name);
    return { executed: tool.name, args };
  }]));
  let active = tools;
  let seq = 0;
  const rpc = async (method, params) => {
    const response = await fetch(bridge.url, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-pi-bridge-token': 'fixture-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  try {
    bridge.requireToken('fixture-token');
    bridge.setToolPrefix('');
    bridge.setToolSource(() => active);
    bridge.refreshTools();
    bridge.setOnCall(call => {
      const execute = implementations.get(call.tool);
      if (!execute) return false;
      received.push(call);
      queueMicrotask(() => resolveBridgeResultsFromContext(bridge, [{ role: 'toolResult', toolCallId: call.id,
        content: [{ type: 'text', text: JSON.stringify(execute(call.args)) }] }]));
      return true;
    });
    await bridge.start();
    assert.ok((await rpc('initialize', { protocolVersion: '2024-11-05' })).capabilities.tools);
    workspace.registerMcpServer(bridge.url, 'fixture-token');
    workspace.writeSystemPrompt('Use every active tool.', tools);
    const agent = await readFile(workspace.agentPath, 'utf8');
    const listed = (await rpc('tools/list')).tools;
    assert.equal(listed.length, tools.length);
    // Model the CLI's schema cache from actual HTTP declarations, not original Pi names.
    await mkdir(workspace.schemaDirectory, { recursive: true });
    for (const tool of tools) {
      const alias = bridgeToolName(serverName, tool.name);
      const declaration = listed.find(item => item.name === alias);
      assert.ok(declaration);
      assert.ok(`mcp_${serverName}_${declaration.name}`.length <= 64);
      assert.deepEqual(declaration.inputSchema, tool.parameters);
      assert.ok(agent.includes(`- ${alias}(nonce)`));
      if (alias !== tool.name) assert.ok(agent.includes(`[Pi: ${tool.name}]`));
      await writeFile(path.join(workspace.schemaDirectory, `${alias}.json`),
        JSON.stringify({ name: alias, parameters: declaration.inputSchema }));
      const schemaPath = JSON.parse(agent.match(/view_file at (".*?"), replacing/)[1])
        .replace('<Pi tool name>', alias);
      assert.deepEqual(JSON.parse(await readFile(schemaPath, 'utf8')).parameters, tool.parameters);
    }
    assert.ok(listed.some(item => item.name === 'read'));
    await Promise.all(tools.map(async (tool, index) => {
      const args = { nonce: `call-${index}` };
      const result = await rpc('tools/call', { name: bridgeToolName(serverName, tool.name), arguments: args });
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(result.content[0].text), { executed: tool.name, args });
    }));
    assert.deepEqual(received.map(call => call.tool).sort(), tools.map(tool => tool.name).sort());
    assert.deepEqual(executed.sort(), tools.map(tool => tool.name).sort());
    t.diagnostic(JSON.stringify({ transport: 'real loopback HTTP MCP',
      names: tools.map(tool => ({ pi: tool.name, mcp: bridgeToolName(serverName, tool.name),
        cliLength: cliToolName(serverName, tool.name).length })), executed }));
    assert.equal(bridge.pendingCount, 0);
    const revision = bridge.catalogRevision;
    active = [...tools].reverse();
    assert.equal(bridge.refreshTools(), false);
    assert.equal(bridge.catalogRevision, revision);
    workspace.writeSystemPrompt('Closed fixture.', tools, executionSurface.profiles.evidence_only_v1);
    const closedAgent = await readFile(workspace.agentPath, 'utf8');
    const inline = JSON.parse(closedAgent.match(/<pi_tool_schemas>\n([\s\S]*?)\n<\/pi_tool_schemas>/)[1]);
    assert.deepEqual(inline.map(tool => tool.name), tools.map(tool => bridgeToolName(serverName, tool.name)));

    // Dynamic overrides and refreshed removal use the SAME alias table as static calls.
    const dynamicCalls = [];
    bridge.setDynamicTools([{ ...tools[0], description: 'Dynamic fixture.', handler: async args => {
      dynamicCalls.push(args); return { content: 'dynamic-original', isError: false };
    } }]);
    assert.equal((await rpc('tools/list')).tools.length, tools.length);
    const dynamic = await rpc('tools/call', { name: bridgeToolName(serverName, longName), arguments: { nonce: 'dynamic' } });
    assert.equal(dynamic.content[0].text, 'dynamic-original');
    assert.deepEqual(dynamicCalls, [{ nonce: 'dynamic' }]);
    assert.equal(received.length, tools.length);
    assert.ok(bridge.catalogRevision > revision);
    bridge.setDynamicTools([]);
    active = [tools[2]];
    bridge.refreshTools();
    assert.equal((await rpc('tools/call', { name: bridgeToolName(serverName, longName) })).isError, true);
    assert.equal(received.length, tools.length);
    assert.deepEqual((await rpc('tools/list')).tools.map(tool => tool.name), ['read']);
  } finally {
    await bridge.close();
    workspace.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
