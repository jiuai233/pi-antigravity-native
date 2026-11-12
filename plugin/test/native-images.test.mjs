import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BRIDGE_CALL_TIMEOUT_MS } from '../src/extension/bridge.ts';
import { cliServerName, createNativeAgentMarkdown, NativeWorkspaceRegistration, sweepDeadNativeWorkspaces } from '../src/native/native-workspace.ts';

const workspaceFixture = (cwd, id) => new NativeWorkspaceRegistration({ cwd, id,
  agentDir: path.join(cwd, 'pi-state'), agentRoot: path.join(cwd, 'global-agents'),
  dataDirectory: path.join(cwd, 'cli-data') });

test('custom agent enables native view_file and generate_image and keeps other default components excluded', () => {
  const agent = createNativeAgentMarkdown('pi-native', 'Use Pi tools for workspace operations.');
  assert.match(agent, /^excludeDefaultComponents: true$/m);
  assert.match(agent, /^tools: \[view_file, generate_image\]$/m);
  assert.match(agent, /Use Pi tools for workspace operations\./);
});

test('tool catalog exposes schema-derived parameters and a readable CLI schema path', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agy-tool-schema-'));
  const workspace = workspaceFixture(cwd, 'schema-test-12345678');
  const tool = {
    name: 'session_start', description: 'Start a main session.',
    parameters: { type: 'object', properties: { cwd: { type: 'string' }, message: { type: 'string' }, modelId: { type: 'string' } }, required: ['cwd', 'message'] },
  };
  try {
    await mkdir(workspace.schemaDirectory, { recursive: true });
    await writeFile(path.join(workspace.schemaDirectory, `${tool.name}.json`), JSON.stringify(tool));
    workspace.writeSystemPrompt('Use Pi tools.', [tool]);
    const agent = await readFile(workspace.agentPath, 'utf8');
    assert.match(agent, /session_start\(cwd, message, modelId\?\)/);
    assert.match(agent, /\? marks an optional parameter/);
    const schemaPath = JSON.parse(agent.match(/view_file at (".*?"), replacing/)[1]).replace('<Pi tool name>', tool.name);
    assert.deepEqual(JSON.parse(await readFile(schemaPath, 'utf8')).parameters, tool.parameters);
    assert.doesNotMatch(agent, /"properties"/);
    assert.match(agent, /^tools: \[view_file, generate_image\]$/m);
    tool.parameters.required.push('modelId');
    assert.equal(workspace.writeSystemPrompt('Use Pi tools.', [tool]), true);
    assert.match(await readFile(workspace.agentPath, 'utf8'), /session_start\(cwd, message, modelId\)/);
  } finally {
    workspace.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('every rewritten native agent retains its image reader', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agy-image-config-'));
  const workspace = workspaceFixture(cwd, 'image-test');
  try {
    await workspace.writeSystemPrompt('First prompt.', []);
    await workspace.writeSystemPrompt('Second prompt.', [{ name: 'read', description: 'Read files.', parameters: { type: 'object' } }]);
    const agent = await readFile(workspace.agentPath, 'utf8');
    assert.match(agent, /^tools: \[view_file, generate_image\]$/m);
    assert.match(agent, /Second prompt\./);
  } finally {
    await workspace.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('tool signatures derive short enums and nested required fields from their schemas', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agy-signature-'));
  const workspace = workspaceFixture(cwd, 'signature-12345678');
  const tools = [
    { name: 'session_message', parameters: { properties: { to: {}, message: {}, mode: { anyOf: [{ const: 'followUp' }, { const: 'steer' }] } }, required: ['to', 'message'] } },
    { name: 'decision_record', parameters: { properties: { outcome: { enum: ['adopted', 'rejected', 'deferred'] } }, required: ['outcome'] } },
    { name: 'edit', parameters: { properties: { edits: { type: 'array', items: { type: 'object', properties: { oldText: {}, newText: {}, optional: {} }, required: ['oldText', 'newText'] } } }, required: ['edits'] } },
    { name: 'large_enum', parameters: { properties: { value: { enum: ['a', 'b', 'c', 'd', 'e', 'f'] } }, required: ['value'] } },
  ].map(tool => ({ description: 'Fixture tool.', ...tool }));
  try {
    workspace.writeSystemPrompt('Use Pi tools.', tools);
    const agent = await readFile(workspace.agentPath, 'utf8');
    assert.ok(agent.includes('session_message(message, mode?:"followUp"|"steer", to)'));
    assert.ok(agent.includes('decision_record(outcome:"adopted"|"rejected"|"deferred")'));
    assert.ok(agent.includes('edit(edits:{oldText,newText}[])'));
    assert.ok(agent.includes('large_enum(value)'));
    assert.match(agent, /full parameter definitions with native view_file/);
  } finally {
    workspace.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('private registrations leave project configuration unchanged and disposal preserves the other instance', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agy-schema-dispose-'));
  const a = workspaceFixture(cwd, 'owner-11111111');
  const b = workspaceFixture(cwd, 'owner-22222222');
  const projectConfig = path.join(cwd, '.agents', 'mcp_config.json');
  const original = '{\r\n  "mcpServers": {"external": {"serverUrl": "http://127.0.0.1:3/mcp"}}\r\n}\r\n';
  try {
    await mkdir(path.dirname(projectConfig), { recursive: true });
    await writeFile(projectConfig, original);
    assert.notEqual(a.directory, b.directory);
    assert.notEqual(a.agentDirectory, b.agentDirectory);
    for (const workspace of [a, b]) {
      workspace.registerMcpServer('http://127.0.0.1:1/mcp', 'fixture');
      workspace.writeSystemPrompt('Private fixture.', []);
      const config = JSON.parse(await readFile(workspace.configPath, 'utf8'));
      assert.deepEqual(Object.keys(config.mcpServers), [workspace.serverName]);
      // agy must not abandon a call before the bridge cap, or the Pi command is orphaned.
      assert.ok(config.mcpServers[workspace.serverName].timeoutSeconds * 1000 > BRIDGE_CALL_TIMEOUT_MS);
      const agent = await readFile(workspace.agentPath, 'utf8');
      assert.ok(agent.includes(workspace.routingHint));
      assert.doesNotMatch(agent, /^mcpServers:/m);
      assert.doesNotMatch(agent, /http:\/\/127\.0\.0\.1:1\/mcp/);
      await mkdir(workspace.schemaDirectory, { recursive: true });
      await writeFile(path.join(workspace.schemaDirectory, 'read.json'), '{}');
    }
    assert.equal(await readFile(projectConfig, 'utf8'), original);
    assert.equal(existsSync(path.join(cwd, '.agents', 'agents')), false);
    a.dispose();
    a.dispose();
    assert.equal(existsSync(a.directory), false);
    assert.equal(existsSync(a.schemaDirectory), false);
    assert.equal(existsSync(a.agentDirectory), false);
    assert.equal(existsSync(b.directory), true);
    assert.equal(existsSync(b.schemaDirectory), true);
    assert.equal(existsSync(b.agentPath), true);
    assert.ok(JSON.parse(await readFile(b.configPath, 'utf8')).mcpServers[b.serverName]);
    b.dispose();
    assert.equal(existsSync(b.directory), false);
    assert.equal(existsSync(b.schemaDirectory), false);
    assert.equal(await readFile(projectConfig, 'utf8'), original);
  } finally {
    a.dispose(); b.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('schema cleanup does not remove a registration replaced by another owner', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'agy-schema-owner-'));
  const workspace = workspaceFixture(cwd, 'owner-33333333');
  try {
    workspace.registerMcpServer('http://127.0.0.1:1/mcp', 'fixture');
    await mkdir(workspace.schemaDirectory, { recursive: true });
    await writeFile(path.join(workspace.schemaDirectory, 'read.json'), '{}');
    const replacement = { mcpServers: { [workspace.serverName]: { serverUrl: 'http://127.0.0.1:2/mcp' } } };
    await writeFile(workspace.configPath, JSON.stringify(replacement));
    workspace.dispose();
    assert.equal(existsSync(workspace.schemaDirectory), true);
    assert.deepEqual(JSON.parse(await readFile(workspace.configPath, 'utf8')), replacement);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('sweepDeadNativeWorkspaces removes only exact ESRCH p<pid>-<12hex> artifacts and preserves live, replaced and conversation state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-dead-sweep-'));
  const agentDir = path.join(root, 'agent');
  const agentRoot = path.join(root, 'agents');
  const dataDir = path.join(root, 'data');
  const makeWs = (id) => new NativeWorkspaceRegistration({ cwd: root, id, agentDir, agentRoot, dataDirectory: dataDir });
  const deadFull = makeWs('p40001-aaaaaaaaaaaa');
  const deadAgentOnly = makeWs('p40002-bbbbbbbbbbbb');
  const deadReplaced = makeWs('p40003-cccccccccccc');
  const liveWs = makeWs('p50001-dddddddddddd');
  const excludedWs = makeWs('p40004-eeeeeeeeeeee');
  const nonPidWs = makeWs('owner-ffffffffffff');
  try {
    for (const ws of [deadFull, deadReplaced, liveWs, excludedWs, nonPidWs]) {
      ws.registerMcpServer('http://127.0.0.1:1/mcp', 'fixture');
      ws.writeSystemPrompt('Fixture.', []);
      await mkdir(ws.schemaDirectory, { recursive: true });
      await writeFile(path.join(ws.schemaDirectory, 'read.json'), '{}');
    }
    deadAgentOnly.writeSystemPrompt('Orphan agent.', []);
    await mkdir(deadAgentOnly.schemaDirectory, { recursive: true });
    await writeFile(deadReplaced.configPath, JSON.stringify({ mcpServers: { external: { serverUrl: 'http://127.0.0.1:2/mcp' } } }));
    const unrelatedMcp = path.join(dataDir, 'mcp', 'bother9999');
    const convDb = path.join(dataDir, 'conversations', 'keep.db');
    const customAgent = path.join(agentRoot, 'user-custom-agent');
    await mkdir(unrelatedMcp, { recursive: true });
    await mkdir(path.dirname(convDb), { recursive: true });
    await writeFile(convDb, 'sqlite');
    await mkdir(customAgent, { recursive: true });

    const deadPids = new Set([40001, 40002, 40003, 40004]);
    const swept = sweepDeadNativeWorkspaces({
      cwd: root, agentDir, agentRoot, dataDirectory: dataDir,
      excludeId: excludedWs.id,
      isDeadPid: (pid) => deadPids.has(pid),
    });
    assert.deepEqual(swept.sort(), [deadFull.id, deadAgentOnly.id].sort());
    for (const ws of [deadFull, deadAgentOnly]) {
      assert.equal(existsSync(ws.directory), false);
      assert.equal(existsSync(ws.agentDirectory), false);
      assert.equal(existsSync(ws.schemaDirectory), false);
    }
    for (const ws of [deadReplaced, liveWs, excludedWs, nonPidWs]) {
      assert.equal(existsSync(ws.directory), true);
      assert.equal(existsSync(ws.agentDirectory), true);
      assert.equal(existsSync(ws.schemaDirectory), true);
    }
    assert.equal(existsSync(unrelatedMcp), true);
    assert.equal(existsSync(convDb), true);
    assert.equal(existsSync(customAgent), true);
    assert.equal(cliServerName(deadFull.id), deadFull.serverName);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
