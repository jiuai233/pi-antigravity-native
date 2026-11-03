import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgyPiBridge } from '../src/extension/bridge.ts';
import { executionSurface, nativeContractHash } from '../src/native/native-profile.ts';
import { NativeWorkspaceRegistration } from '../src/native/native-workspace.ts';
import { ToolProjection } from '../src/extension/tool-projection.ts';

// Exercise the real projection without loading provider/replay, starting agy,
// discovering models, or touching the host's agent directory.
const parameters = {
  type: 'object', properties: { code: { type: 'string', description: 'JavaScript calling tools.*.' } },
  required: ['code'], additionalProperties: false,
};
const codemode = {
  name: 'codemode',
  description: 'Run JavaScript using callable tools.\nUse Promise.allSettled for independent calls.\n'
    + 'Available callable tools:\n- tools.read({path}): Read a file.\n- tools.bash({command}): Run a command.',
  parameters,
};
const read = { name: 'read', description: 'Read files.', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
} };

async function writeSkill(root) {
  const baseDir = path.join(root, 'skills', 'fixture-skill');
  await mkdir(baseDir, { recursive: true });
  const filePath = path.join(baseDir, 'SKILL.md');
  await writeFile(filePath, '---\nname: fixture-skill\ndescription: Fixture skill.\n---\nFIXTURE_SKILL_BODY\n');
  return [{ name: 'fixture-skill', description: 'Fixture skill.', filePath, baseDir }];
}

async function fixture(run, { skills = () => [], profile = executionSurface.profiles.default } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-projection-'));
  const workspace = new NativeWorkspaceRegistration({ cwd: root, id: 'projection-12345678',
    agentDir: path.join(root, 'pi'), agentRoot: path.join(root, 'agents'), dataDirectory: path.join(root, 'cli') });
  const bridge = new AgyPiBridge(workspace.serverName);
  const counts = { refreshed: 0, profiles: 0 };
  let snapshotSource;
  let writtenTools;
  let seq = 0;
  const setToolSource = bridge.setToolSource.bind(bridge);
  bridge.setToolSource = source => { snapshotSource = source; setToolSource(source); };
  const refreshTools = bridge.refreshTools.bind(bridge);
  bridge.refreshTools = () => { counts.refreshed++; return refreshTools(); };
  const writeSystemPrompt = workspace.writeSystemPrompt.bind(workspace);
  workspace.writeSystemPrompt = (prompt, tools, selectedProfile) => {
    writtenTools = tools;
    return writeSystemPrompt(prompt, tools, selectedProfile);
  };
  const rpc = async (method, params) => {
    const response = await fetch(bridge.url, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.error, undefined);
    return reply.result;
  };
  try {
    const skillList = await skills(root);
    const projection = new ToolProjection({ bridge, skills: () => skillList,
      readProfile: () => { counts.profiles++; return profile; } });
    const prepare = async tools => {
      const previousRefreshes = counts.refreshed;
      const prepared = await projection.prepare(workspace, 'SDK system prompt.', tools);
      assert.equal(counts.refreshed, previousRefreshes, 'provider owns the following catalog refresh');
      assert.equal(snapshotSource(), writtenTools, 'agent and bridge share the filtered snapshot');
      bridge.refreshTools(); // Same order as the provider: prepareAgent, then refreshTools.
      return prepared;
    };
    bridge.setToolPrefix('');
    await bridge.start();
    workspace.registerMcpServer(bridge.url, 'fixture-token');
    await run({ workspace, bridge, counts, prepare, rpc, snapshot: () => snapshotSource() });
  } finally {
    await bridge.close();
    workspace.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

async function checkCliSchemas(workspace, listed) {
  // The CLI owns its schema cache. Populate it from actual tools/list, as in
  // long-tool-names.test.mjs, and follow the exact schema path from the agent.
  const agent = await readFile(workspace.agentPath, 'utf8');
  const schemaTemplate = JSON.parse(agent.match(/view_file at (".*?"), replacing/)[1]);
  await mkdir(workspace.schemaDirectory, { recursive: true });
  for (const tool of listed) {
    const file = schemaTemplate.replace('<Pi tool name>', tool.name);
    await writeFile(file, JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.inputSchema }));
    const cached = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(cached.parameters, tool.inputSchema);
    assert.equal(cached.description, tool.description);
  }
  return agent;
}

test('SDK only projection retains the full codemode contract without restoring hidden direct tools', () => fixture(async f => {
  const wrapper = { name: 'antigravity', description: 'Must not recurse.', parameters: {} };
  await f.prepare(Object.freeze([codemode, wrapper]));
  const listed = (await f.rpc('tools/list')).tools;
  assert.deepEqual(listed.map(tool => tool.name), ['codemode']);
  assert.deepEqual(listed[0].inputSchema, parameters);
  assert.equal(listed[0].description, codemode.description);
  const agent = await checkCliSchemas(f.workspace, listed);
  assert.ok(agent.includes(`- codemode(code): ${codemode.description}`));
  assert.doesNotMatch(agent, /^- (read|bash|antigravity)\(/m);
  assert.doesNotMatch(agent, /For example, read uses/);
  assert.match(agent, /If you need more parameter details, read full parameter definitions/);
  assert.match(agent, /^tools: \[view_file, generate_image\]$/m);
  assert.deepEqual(f.snapshot().map(tool => tool.name), ['codemode']);
  assert.equal(f.counts.profiles, 1);
  const projected = f.snapshot();
  f.bridge.refreshTools(); f.bridge.refreshTools();
  assert.equal(f.snapshot(), projected, 'MCP refresh must not recompute the SDK projection');
  assert.equal(f.counts.profiles, 1);
  let received;
  f.bridge.setOnCall(call => {
    received = call;
    queueMicrotask(() => f.bridge.resolveCall(call.id, { content: 'fixture executed', isError: false }));
    return true;
  });
  const args = { code: 'await tools.read({path: "fixture"})' };
  assert.equal((await f.rpc('tools/call', { name: 'codemode', arguments: args })).isError, false);
  assert.equal(received.tool, 'codemode');
  assert.deepEqual(received.args, args);
}));

test('each SDK request replaces the shared snapshot for discovery, redefinition and removal', () => fixture(async f => {
  await f.prepare([codemode]);
  const first = f.snapshot();
  const firstRevision = f.bridge.catalogRevision;
  await f.prepare([codemode, read]);
  assert.notEqual(f.snapshot(), first);
  let listed = (await f.rpc('tools/list')).tools;
  assert.deepEqual(listed.map(tool => tool.name), ['codemode', 'read']);
  assert.match(await checkCliSchemas(f.workspace, listed), /^- read\(path\): Read files\./m);
  assert.ok(f.bridge.catalogRevision > firstRevision);
  const changed = { ...codemode, description: `${codemode.description}\nDiscovered: tools.read_symbol({path, name}).`,
    parameters: { ...parameters, properties: { ...parameters.properties, label: { type: 'string' } } } };
  await f.prepare([changed]); // No new user-turn event: next SDK request owns the new declaration.
  listed = (await f.rpc('tools/list')).tools;
  assert.deepEqual(listed.map(tool => tool.name), ['codemode']);
  assert.equal(listed[0].description, changed.description);
  assert.deepEqual(listed[0].inputSchema, changed.parameters);
  const agent = await checkCliSchemas(f.workspace, listed);
  assert.ok(agent.includes(`- codemode(code, label?): ${changed.description}`));
  assert.doesNotMatch(agent, /^- read\(/m);
  await f.prepare([]);
  assert.deepEqual((await f.rpc('tools/list')).tools, []);
  assert.doesNotMatch(await readFile(f.workspace.agentPath, 'utf8'), /^- (read|codemode)\(/m);
  assert.equal(f.counts.profiles, 4);
}));

test('profile allowlist keeps inline schemas aligned and disables native IO and the skills bridge', () => fixture(async f => {
  const submit = { name: 'submit_task_result', description: 'Submit the supplied dossier.', parameters: {
    type: 'object', properties: { verdict: { enum: ['done', 'failed'] } }, required: ['verdict'],
  } };
  const prepared = await f.prepare([codemode, read, submit]);
  const listed = (await f.rpc('tools/list')).tools;
  assert.deepEqual(listed.map(tool => tool.name), ['submit_task_result']);
  const agent = await readFile(f.workspace.agentPath, 'utf8');
  const inline = JSON.parse(agent.match(/<pi_tool_schemas>\n([\s\S]*?)\n<\/pi_tool_schemas>/)[1]);
  assert.deepEqual(inline, listed.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })));
  assert.match(agent, /^tools: \[\]$/m);
  assert.doesNotMatch(agent, /^- (read|codemode|activate_skill)\(/m);
  assert.deepEqual(prepared.nativeTools, []);
  assert.equal(prepared.nativeContractHash, nativeContractHash(executionSurface.profiles.evidence_only_v1, [submit]));
}, { profile: executionSurface.profiles.evidence_only_v1, skills: () => [{ name: 'fixture-skill' }] }));

test('ordinary profile retains the independent skills bridge across SDK tool changes', () => fixture(async f => {
  await f.prepare([codemode]);
  assert.deepEqual((await f.rpc('tools/list')).tools.map(tool => tool.name), ['activate_skill', 'codemode']);
  const result = await f.rpc('tools/call', { name: 'activate_skill', arguments: { name: 'fixture-skill' } });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /FIXTURE_SKILL_BODY/);
  await f.prepare([]);
  assert.deepEqual((await f.rpc('tools/list')).tools.map(tool => tool.name), ['activate_skill']);
  assert.match(await readFile(f.workspace.agentPath, 'utf8'), /^tools: \[view_file, generate_image\]$/m);
}, { skills: writeSkill }));
