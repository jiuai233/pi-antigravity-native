import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNativeAgentMarkdown, NativeWorkspaceRegistration } from '../src/native/native-workspace.ts';

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
    assert.ok(agent.includes('session_message(to, message, mode?:"followUp"|"steer")'));
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
