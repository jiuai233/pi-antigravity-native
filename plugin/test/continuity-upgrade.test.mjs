import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AgyStallError } from '../src/driver/agy-client.ts';
import { AgyDriverSession, AgyOneShotExecutor } from '../src/driver/agy-driver.ts';
import { countNativeUserSteps } from '../src/native/native-terminal.ts';
import { AgyPiBridge } from '../src/extension/bridge.ts';
import { ConversationSync } from '../src/extension/conversation-sync.ts';
import { ToolProjection } from '../src/extension/tool-projection.ts';
import { AGY_CONVERSATION_STATE_ENTRY, restorableAgyConversation } from '../src/native/conversation-state.ts';
import { executionSurface } from '../src/native/native-profile.ts';
import { NativeWorkspaceRegistration } from '../src/native/native-workspace.ts';
import { hashSystemPrompt } from '../src/provider/mapping.ts';
import { FALLBACK_MODELS } from '../src/provider/models.ts';
import { AgyReplayStore } from '../src/provider/replay.ts';
import { streamAntigravity } from '../src/provider/stream.ts';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { fixture, flush, memoryStream } from './offline-fixture.mjs';

function createSeededConversationDb(conversationsDir, conversationId) {
  fs.mkdirSync(conversationsDir, { recursive: true });
  const dbPath = path.join(conversationsDir, `${conversationId}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB);
    CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  const spec = Buffer.from([0x1a, 0x0d, 0x0a, 0x09, ...Buffer.from('view_file'), 0x10, 0x01]);
  const field46 = Buffer.concat([Buffer.from([0xf2, 0x02, spec.length]), spec]);
  const field1 = Buffer.concat([Buffer.from([0x0a, field46.length]), field46]);
  const ckpt256 = Buffer.from([0x28, 0x80, 0xd0, 0x0f]);
  const field2 = Buffer.concat([Buffer.from([0x12, ckpt256.length]), ckpt256]);
  const cascade = Buffer.concat([field1, field2]);
  const execMeta = Buffer.concat([Buffer.from([0x52, cascade.length]), cascade]);

  const blobInner1 = Buffer.concat([Buffer.from([0x0a, spec.length]), spec]);
  const blob18 = Buffer.concat([Buffer.from([0x92, 0x01, blobInner1.length]), blobInner1]);
  const blob7 = Buffer.concat([Buffer.from([0x3a, blob18.length]), blob18]);
  const blob4 = Buffer.concat([Buffer.from([0x22, blob7.length]), blob7]);
  const blob10 = Buffer.concat([Buffer.from([0x52, blob18.length]), blob18]);
  const trajBlob = Buffer.concat([blob4, blob10]);
  const genMeta = Buffer.concat([Buffer.from([0x1a, field46.length]), field46]);

  db.prepare('INSERT INTO executor_metadata VALUES (?, ?)').run(0, execMeta);
  db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', trajBlob);
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, genMeta);
  db.prepare('INSERT INTO steps VALUES (?, ?, ?, NULL, ?)').run(0, 14, 3, Buffer.from([]));
  db.close();
  return dbPath;
}

test('managed custom-agent prompt and tool changes patch .db in-place and recycle the persistent driver without dropping conversationId', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-inplace-sync-'));
  const prevDataDir = process.env.JETSKI_APP_DATA_DIR;
  const dataDir = path.join(root, 'cli-data');
  process.env.JETSKI_APP_DATA_DIR = dataDir;

  const convId = '11111111-2222-4333-8444-555555555555';
  const dbPath = createSeededConversationDb(path.join(dataDir, 'conversations'), convId);
  const f = fixture();
  const spawned = [];
  f.executionDependencies.spawn = (_bin, args) => {
    const child = f.child(920000 + spawned.length);
    // Inspect DB state at the exact moment agy is spawned!
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const execBytes = Buffer.from(db.prepare('SELECT data FROM executor_metadata WHERE idx = 0').get().data);
    db.close();
    spawned.push({ child, args, execBytes });
    return child;
  };

  let activeProfile = executionSurface.profiles.default;
  const workspace = new NativeWorkspaceRegistration({
    cwd: root,
    id: 'sync-12345678',
    agentDir: path.join(root, 'pi'),
    agentRoot: path.join(root, 'agents'),
    dataDirectory: dataDir,
  });
  const bridge = new AgyPiBridge(workspace.serverName);
  const projection = new ToolProjection({
    bridge,
    skills: () => [],
    readProfile: () => activeProfile,
  });
  const driver = new AgyDriverSession(f.executionDependencies);
  const runtime = createAntigravityRuntime(
    {
      run: (req) => driver.run({ ...req, binary: 'OFFLINE_FAKE' }),
      snapshot: () => driver.snapshot(),
      close: (...a) => driver.close(...a),
    },
    undefined,
    f.childrenHost,
  );
  await runtime.setSession(root, 'gemini-3.8-flash', false);

  let currentPrompt = 'SYS_PROMPT_V1\n\n# AGENTS.md\nRule V1';
  let currentTools = [{ name: 'read', description: 'Read v1', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  const callProvider = streamAntigravity({
    runtime,
    replay: new AgyReplayStore(),
    bridge,
    dependencies: {
      normalizeContext: (c) => c,
      getCurrentSystemPrompt: () => currentPrompt,
      getCurrentTools: () => currentTools,
      calculateCost() {},
      createAssistantMessageEventStream: memoryStream,
    },
    getModelInfo: (id) => FALLBACK_MODELS.find((m) => m.id === id),
    prepareAgent: async (sys, tools) => projection.prepare(workspace, sys, tools),
  });

  const model = { id: 'gemini-3.8-flash', api: 'antigravity-stream-json', provider: 'antigravity' };
  try {
    // Turn 1 starts fresh and binds convId.
    const s1 = callProvider(model, { messages: [{ role: 'user', content: 'Turn 1' }] }, { reasoning: 'high' });
    await flush();
    assert.equal(spawned.length, 1);
    spawned[0].child.send({ event: 'init', conversation_id: convId });
    spawned[0].child.send({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'ok 1' } });
    await s1.ended;
    const snap1 = runtime.snapshot();
    assert.equal(snap1.conversationId, convId);

    // Turn 2 mutates BOTH systemPrompt and tool schema: keeps convId, recycles driver ("agent"), patches DB before spawn.
    currentPrompt = 'SYS_PROMPT_V2_UPDATED\n\n# AGENTS.md\nRule V2 Updated';
    currentTools = [
      ...currentTools,
      { name: 'bash', description: 'Run bash v2', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
    ];
    const s2 = callProvider(
      model,
      {
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: [{ type: 'text', text: 'ok 1' }] },
          { role: 'user', content: 'Turn 2 after prompt+schema change' },
        ],
      },
      { reasoning: 'high' },
    );
    await flush();
    assert.equal(spawned.length, 2);
    assert.equal(driver.snapshot().stats.lastRecycleReason, 'agent');
    assert.ok(spawned[1].args.includes('--conversation'));
    assert.equal(spawned[1].args[spawned[1].args.indexOf('--conversation') + 1], convId);
    assert.ok(spawned[1].execBytes.includes(Buffer.from('SYS_PROMPT_V2_UPDATED')));
    assert.ok(spawned[1].execBytes.includes(Buffer.from('Rule V2 Updated')));
    assert.ok(spawned[1].execBytes.includes(Buffer.from('Run bash v2')));
    spawned[1].child.send({ event: 'init', conversation_id: convId });
    spawned[1].child.send({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'ok 2' } });
    await s2.ended;
    const terminal2 = s2.events.at(-1);
    assert.equal(terminal2.message.stopReason, 'stop');
    assert.equal(runtime.snapshot().conversationId, convId);
    assert.notEqual(runtime.snapshot().systemPromptHash, snap1.systemPromptHash);
    assert.notEqual(runtime.snapshot().nativeContractHash, snap1.nativeContractHash);

    // Turn 3 with unchanged prompt/tools reuses the warm process without respawning.
    const s3 = callProvider(model, { messages: [{ role: 'user', content: 'Turn 3' }] }, { reasoning: 'high' });
    await flush();
    assert.equal(spawned.length, 2, 'unchanged agentRevision should reuse warm driver process');
    spawned[1].child.send({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'ok 3' } });
    await s3.ended;
  } finally {
    await runtime.close();
    workspace.dispose();
    if (prevDataDir === undefined) delete process.env.JETSKI_APP_DATA_DIR;
    else process.env.JETSKI_APP_DATA_DIR = prevDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('transient .db lock on prompt update emits warning, preserves old hash, and retries upgrading on the next turn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-inplace-retry-'));
  const prevDataDir = process.env.JETSKI_APP_DATA_DIR;
  const dataDir = path.join(root, 'cli-data');
  process.env.JETSKI_APP_DATA_DIR = dataDir;
  const convId = '22222222-3333-4444-8555-666666666666';
  const dbPath = createSeededConversationDb(path.join(dataDir, 'conversations'), convId);

  const f = fixture();
  const spawned = [];
  f.executionDependencies.spawn = (_bin, args) => {
    const child = f.child(921000 + spawned.length);
    spawned.push({ child, args });
    return child;
  };
  const driver = new AgyDriverSession(f.executionDependencies);
  const runtime = createAntigravityRuntime(
    {
      run: (req) => driver.run({ ...req, binary: 'OFFLINE_FAKE' }),
      snapshot: () => driver.snapshot(),
      close: (...a) => driver.close(...a),
    },
    undefined,
    f.childrenHost,
  );
  await runtime.restoreConversation({
    conversationId: convId,
    cwd: root,
    modelId: 'gemini-3.8-flash',
    turns: 1,
    usage: {},
    systemPromptHash: 'h-old',
    nativeContractHash: 'c-old',
  });

  const lockDb = new DatabaseSync(dbPath);
  try {
    lockDb.exec('BEGIN EXCLUSIVE');
    const c1 = await runtime.beginStreamTurn({
      prompt: 'turn while locked',
      modelId: 'gemini-3.8-flash',
      systemPromptHash: 'h-new',
      nativeContractHash: 'c-new',
      nativeTools: ['view_file', 'generate_image'],
      agent: 'pi-native-test',
      agentBody: 'LOCKED_UPDATE_V2',
    });
    await flush();
    spawned[0].child.send({ event: 'init', conversation_id: convId });
    spawned[0].child.send({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'warned' } });
    const events1 = [];
    for (;;) {
      const ev = await c1.next();
      if (!ev) break;
      events1.push(ev);
      if (ev.type === 'result') break;
    }
    runtime.finishTurn();
    await flush();
    assert.ok(events1.some((e) => e.type === 'native_migration_warning'));
    assert.equal(runtime.snapshot().systemPromptHash, 'h-old', 'failed migration must not advance persisted hash');

    // Release SQLite lock: next turn with identical V2 request must recycle and migrate!
    lockDb.exec('ROLLBACK');
    lockDb.close();

    const c2 = await runtime.beginStreamTurn({
      prompt: 'turn after unlock',
      modelId: 'gemini-3.8-flash',
      systemPromptHash: 'h-new',
      nativeContractHash: 'c-new',
      nativeTools: ['view_file', 'generate_image'],
      agent: 'pi-native-test',
      agentBody: 'LOCKED_UPDATE_V2',
    });
    await flush();
    assert.equal(spawned.length, 2, 'cleared agentRevision forces retry recycle on next turn');
    spawned[1].child.send({ event: 'init', conversation_id: convId });
    spawned[1].child.send({ event: 'result', result: { conversation_id: convId, status: 'SUCCESS', response: 'migrated' } });
    for (;;) {
      const ev = await c2.next();
      if (!ev || ev.type === 'result') break;
    }
    runtime.finishTurn();
    await flush();
    assert.equal(runtime.snapshot().systemPromptHash, 'h-new');

    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    const bytes = Buffer.from(verifyDb.prepare('SELECT data FROM executor_metadata WHERE idx = 0').get().data);
    verifyDb.close();
    assert.ok(bytes.includes(Buffer.from('LOCKED_UPDATE_V2')));
  } finally {
    try { lockDb.close(); } catch {}
    await runtime.close();
    if (prevDataDir === undefined) delete process.env.JETSKI_APP_DATA_DIR;
    else process.env.JETSKI_APP_DATA_DIR = prevDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi-chunk prefill executes with low effort, suppresses ACK/prefill usage, blocks prefill bridge calls, and supports stale-resume fallback', async () => {
  const f = fixture();
  const calls = [];
  let runtime;
  const executor = {
    run: async (req) => {
      const isPrefill = req.prompt.includes('reply with `ACK` only');
      calls.push({
        prompt: req.prompt,
        conversationId: req.conversationId,
        effort: req.effort,
        bridgeAllowedDuringPrefill: isPrefill
          ? runtime.pushBridgeCall({ id: 'rogue', tool: 'read', args: {} })
          : undefined,
      });
      if (req.conversationId === 'missing-conv') {
        throw new Error('conversation missing-conv does not exist');
      }
      const cid = req.conversationId ?? 'prefilled-conv-1';
      req.onConversation?.(cid);
      const stepIndex = calls.length;
      if (isPrefill) {
        req.onActivity?.({ type: 'text', delta: 'ACK', stepId: stepIndex });
        const cumInput = stepIndex * 50_000;
        req.onActivity?.({ type: 'result', status: 'OK', response: 'ACK', usage: { input_tokens: cumInput, output_tokens: 5 } });
        return {
          conversationId: cid,
          status: 'OK',
          response: 'ACK',
          usage: { input_tokens: cumInput, output_tokens: 5 },
          activities: [],
          finished: true,
        };
      }
      req.onActivity?.({ type: 'text', delta: 'Final answer with full history', stepId: stepIndex });
      // Result-only cumulative usage (no per-step usage): must subtract prefill cumulative baseline!
      const finalCumulative = { input_tokens: 165_000, output_tokens: 125 };
      req.onActivity?.({ type: 'result', status: 'OK', response: 'Final answer with full history', usage: finalCumulative });
      return {
        conversationId: cid,
        status: 'OK',
        response: 'Final answer with full history',
        usage: finalCumulative,
        activities: [],
        finished: true,
      };
    },
    snapshot: () => ({ mode: 'one-shot', state: 'idle', lifecycle: [] }),
    close: async () => {},
  };
  runtime = createAntigravityRuntime(executor, undefined, f.childrenHost);
  await runtime.restoreConversation({
    conversationId: 'missing-conv',
    cwd: process.cwd(),
    modelId: 'gemini-3.8-flash',
    turns: 3,
    usage: { input_tokens: 290_000 },
    systemPromptHash: hashSystemPrompt('sys'),
  });

  const messages = [];
  for (let i = 0; i < 8; i++) {
    messages.push(
      { role: 'user', content: `Q${i}: ` + '历史问题内容。'.repeat(1_200) },
      { role: 'assistant', content: [{ type: 'text', text: `A${i}: ` + '历史回答内容。'.repeat(1_200) }] },
    );
  }
  messages.push({ role: 'user', content: '请基于全部历史回答最终问题。' });

  const stream = streamAntigravity({
    runtime,
    replay: new AgyReplayStore(),
    bridge: new AgyPiBridge('bfixture1'),
    dependencies: {
      normalizeContext: (c) => c,
      getCurrentSystemPrompt: () => 'sys',
      getCurrentTools: () => [],
      calculateCost() {},
      createAssistantMessageEventStream: memoryStream,
    },
    getModelInfo: (id) => FALLBACK_MODELS.find((m) => m.id === id),
  })(
    { id: 'gemini-3.8-flash', api: 'antigravity-stream-json', provider: 'antigravity' },
    { messages },
    { reasoning: 'high' },
  );

  try {
    await stream.ended;
    // Call 0: failed resume on missing-conv ("high").
    // Calls 1..2: 2 prefill chunks with effort "low", rogue bridge calls rejected.
    // Call 3: final user turn on prefilled-conv-1 with effort "high".
    assert.equal(calls.length, 4);
    assert.equal(calls[0].conversationId, 'missing-conv');
    assert.equal(calls[0].effort, 'high');
    assert.equal(calls[1].conversationId, undefined);
    assert.equal(calls[1].effort, 'low');
    assert.equal(calls[1].bridgeAllowedDuringPrefill, false);
    assert.equal(calls[2].conversationId, 'prefilled-conv-1');
    assert.equal(calls[2].effort, 'low');
    assert.equal(calls[2].bridgeAllowedDuringPrefill, false);
    assert.equal(calls[3].conversationId, 'prefilled-conv-1');
    assert.equal(calls[3].effort, 'high');

    const done = stream.events.at(-1);
    assert.equal(done.type, 'done');
    const renderedText = done.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    assert.equal(renderedText, 'Final answer with full history', 'prefill ACK must never leak into assistant output');
    // Cumulative usage on call 2 was 150,000 input / 5 output; call 3 cumulative was 165,000 / 125 => delta 15,000 / 120.
    assert.equal(done.message.usage.input, 15_000);
    assert.equal(done.message.usage.output, 120);

    // Verify model without "low" effort (gpt-oss-120b -> ["medium"]) resolves prefillEffort to "medium".
    await runtime.setSession(process.cwd(), 'gpt-oss-120b', true);
    calls.length = 0;
    const gptStream = streamAntigravity({
      runtime,
      replay: new AgyReplayStore(),
      bridge: new AgyPiBridge('bfixture2'),
      dependencies: {
        normalizeContext: (c) => c,
        getCurrentSystemPrompt: () => 'sys',
        getCurrentTools: () => [],
        calculateCost() {},
        createAssistantMessageEventStream: memoryStream,
      },
      getModelInfo: (id) => FALLBACK_MODELS.find((m) => m.id === id),
    })(
      { id: 'gpt-oss-120b', api: 'antigravity-stream-json', provider: 'antigravity' },
      { messages },
      { reasoning: 'high' },
    );
    await gptStream.ended;
    assert.equal(calls[0].effort, 'medium');
  } finally {
    await runtime.close();
  }
});

test('ConversationSync re-anchors persisted conversation after an aborted turn appends messages, and Turn-0/prefill aborts preserve pending bootstrap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-abort-reload-'));
  const prevDataDir = process.env.JETSKI_APP_DATA_DIR;
  const dataDir = path.join(root, 'cli-data');
  process.env.JETSKI_APP_DATA_DIR = dataDir;
  const zeroStepId = '33333333-4444-4555-8666-777777777777';
  const oneStepId = '44444444-5555-4666-8777-888888888888';

  // Create two SQLite DBs: one aborted before USER_INPUT (0 user steps), one after USER_INPUT (1 user step).
  fs.mkdirSync(path.join(dataDir, 'conversations'), { recursive: true });
  for (const [id, userSteps] of [[zeroStepId, 0], [oneStepId, 1]]) {
    const db = new DatabaseSync(path.join(dataDir, 'conversations', `${id}.db`));
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB)');
    if (userSteps > 0) db.prepare('INSERT INTO steps VALUES (0, 14, 3, NULL, ?)').run(Buffer.from([]));
    db.close();
  }

  const f = fixture();
  let mode = 'abort-zero-step';
  const seenPrompts = [];
  const runtime = createAntigravityRuntime(
    async (req) => {
      seenPrompts.push({ prompt: req.prompt, conversationId: req.conversationId });
      if (mode === 'abort-zero-step') {
        req.onConversation?.(zeroStepId);
        throw new Error('agy turn was aborted.');
      }
      if (mode === 'ok-turn-1') {
        req.onConversation?.(oneStepId);
        req.onActivity?.({ type: 'result', status: 'OK', response: 'ok', usage: { input_tokens: 100 } });
        return { conversationId: oneStepId, status: 'OK', response: 'ok', usage: { input_tokens: 100 }, activities: [], finished: true };
      }
      // Aborted Turn 2 on existing conversation (turns remains 1).
      throw new Error('agy turn was aborted.');
    },
    undefined,
    f.childrenHost,
  );

  const branch = [];
  const sync = new ConversationSync(runtime, (customType, data) => {
    branch.push({ type: 'custom', customType, data });
  });
  const ctx = {
    cwd: root,
    model: { provider: 'antigravity', id: 'gemini-3.8-flash' },
    sessionManager: { getSessionId: () => 's-abort', getBranch: () => branch },
  };

  try {
    await runtime.setSession(root, 'gemini-3.8-flash', true);

    // 1. Turn 0 aborts mid-prefill (chunk 1 of 2 succeeded, chunk 2 aborted):
    // runtime must discard the half-prefilled conversation and keep prefill+bootstrap armed!
    mode = 'abort-mid-prefill';
    let prefillCount = 0;
    const midPrefillRuntime = createAntigravityRuntime(
      async (req) => {
        prefillCount += 1;
        req.onConversation?.(oneStepId);
        if (prefillCount === 1) {
          return { conversationId: oneStepId, status: 'OK', response: 'ACK', activities: [], finished: true };
        }
        throw new Error('agy turn was aborted.');
      },
      undefined,
      f.childrenHost,
    );
    await midPrefillRuntime.setSession(root, 'gemini-3.8-flash', true);
    const cmid = await midPrefillRuntime.beginStreamTurn({
      prompt: 'ask mid',
      modelId: 'gemini-3.8-flash',
      historyPrefill: ['PREFILL_1', 'PREFILL_2'],
      historyBootstrap: 'BOOT_FINAL',
    });
    await assert.rejects(cmid.next(), /aborted/);
    midPrefillRuntime.finishTurn();
    await flush();
    assert.equal(midPrefillRuntime.snapshot().conversationId, undefined, 'half-prefilled conversation must be discarded');
    await midPrefillRuntime.close();

    // 1b. Turn 0 aborts after init created zeroStepId.db with 0 USER_INPUT steps:
    // runtime must forget zeroStepId and keep historyBootstrap armed for the retry!
    mode = 'abort-zero-step';
    const c0 = await runtime.beginStreamTurn({
      prompt: 'ask 1',
      modelId: 'gemini-3.8-flash',
      historyBootstrap: 'CLAUDE_HISTORY_BOOTSTRAP',
    });
    await assert.rejects(c0.next(), /aborted/);
    runtime.finishTurn();
    await flush();
    assert.equal(runtime.snapshot().conversationId, undefined);

    // 2. Retry succeeds and still receives CLAUDE_HISTORY_BOOTSTRAP!
    mode = 'ok-turn-1';
    const c1 = await runtime.beginStreamTurn({
      prompt: 'ask 1 retry',
      modelId: 'gemini-3.8-flash',
      historyBootstrap: 'CLAUDE_HISTORY_BOOTSTRAP',
    });
    assert.equal((await c1.next()).status, 'OK');
    runtime.finishTurn();
    await flush();
    assert.match(seenPrompts[1].prompt, /CLAUDE_HISTORY_BOOTSTRAP/);

    branch.push({ type: 'message', message: { role: 'user', content: 'ask 1 retry' } });
    branch.push({ type: 'message', message: { role: 'assistant', content: 'ok' } });
    await sync.persist(ctx);
    assert.equal(branch.filter((e) => e.customType === AGY_CONVERSATION_STATE_ENTRY).length, 1);
    assert.equal(restorableAgyConversation(branch, 's-abort', root)?.conversationId, oneStepId);

    // 3. Turn 2 aborts: Pi appends user + aborted assistant messages to branch, turns stays 1.
    // sync.persist must re-anchor the state marker at the tail so /reload keeps oneStepId!
    mode = 'abort-turn-2';
    branch.push({ type: 'message', message: { role: 'user', content: 'ask 2 aborted' } });
    const c2 = await runtime.beginStreamTurn({ prompt: 'ask 2 aborted', modelId: 'gemini-3.8-flash' });
    await assert.rejects(c2.next(), /aborted/);
    runtime.finishTurn();
    await flush();
    branch.push({ type: 'message', message: { role: 'assistant', stopReason: 'aborted' } });

    assert.equal(restorableAgyConversation(branch, 's-abort', root), undefined, 'stale before persist');
    await sync.persist(ctx);
    assert.equal(branch.filter((e) => e.customType === AGY_CONVERSATION_STATE_ENTRY).length, 2);
    assert.equal(restorableAgyConversation(branch, 's-abort', root)?.conversationId, oneStepId);

    // Repeated idle persist without new messages is still deduplicated.
    await sync.persist(ctx);
    assert.equal(branch.filter((e) => e.customType === AGY_CONVERSATION_STATE_ENTRY).length, 2);
  } finally {
    await runtime.close();
    if (prevDataDir === undefined) delete process.env.JETSKI_APP_DATA_DIR;
    else process.env.JETSKI_APP_DATA_DIR = prevDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prefill stall ACK retries, missing-DB/ERROR Turn-0 rollbacks, stale-fallback interruption, and empty-metadata closed-book fail closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sol-regressions-'));
  const prevDataDir = process.env.JETSKI_APP_DATA_DIR;
  const prevBackoff = process.env.AGY_STALL_RETRY_BACKOFF_MS;
  const dataDir = path.join(root, 'cli-data');
  process.env.JETSKI_APP_DATA_DIR = dataDir;
  process.env.AGY_STALL_RETRY_BACKOFF_MS = '0';
  fs.mkdirSync(path.join(dataDir, 'conversations'), { recursive: true });

  const drain = async (c) => {
    const out = [];
    for (;;) {
      const ev = await c.next();
      if (!ev) break;
      out.push(ev);
    }
    await flush();
    return out;
  };

  try {
    // 1. Prefill retry ACK step must not skew the next chunk's persistence baseline (F1).
    const r1Id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const r1Db = new DatabaseSync(path.join(dataDir, 'conversations', `${r1Id}.db`));
    r1Db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB)');
    let stepIdx = 0;
    const putStep = () => r1Db.prepare('INSERT INTO steps VALUES (?, 14, 3, NULL, ?)').run(stepIdx++, Buffer.alloc(0));
    const r1Calls = [];
    const r1Runtime = createAntigravityRuntime(async (req) => {
      r1Calls.push({ prompt: req.prompt, before: countNativeUserSteps(r1Id, root) });
      req.onConversation?.(r1Id);
      if (r1Calls.length === 1) { putStep(); throw new AgyStallError(1, false); }
      if (r1Calls.length === 3) { throw new AgyStallError(1, false); }
      putStep();
      req.onActivity?.({ type: 'result', status: 'OK', response: 'ACK' });
      return { conversationId: r1Id, status: 'OK', response: 'ACK', activities: [], finished: true };
    });
    await r1Runtime.setSession(root, 'fixture', true);
    await drain(await r1Runtime.beginStreamTurn({
      modelId: 'fixture',
      prompt: 'FINAL',
      historyPrefill: ['CHUNK_A', 'CHUNK_B'],
      historyBootstrap: 'FINAL_HISTORY',
    }));
    r1Runtime.finishTurn();
    assert.equal(r1Calls[3].prompt, 'CHUNK_B', 'unpersisted second prefill chunk must be resent after prior chunk ACK');
    await r1Runtime.close();
    r1Db.close();

    // 2. Fresh Turn-0 exception before DB creation (count=null) and structured ERROR outcome both roll back (F3 + F4).
    const r2Id = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const r3Id = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
    const r3Db = new DatabaseSync(path.join(dataDir, 'conversations', `${r3Id}.db`));
    r3Db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB)');
    r3Db.close();

    let phase = 'missing-db-throw';
    const errPrompts = [];
    const errRuntime = createAntigravityRuntime(async (req) => {
      errPrompts.push(req.prompt);
      if (phase === 'missing-db-throw') {
        req.onConversation?.(r2Id);
        throw new Error('interrupted before db creation');
      }
      if (phase === 'structured-error') {
        req.onConversation?.(r3Id);
        req.onActivity?.({ type: 'result', status: 'ERROR', error: 'rejected before USER_INPUT' });
        return { conversationId: r3Id, status: 'ERROR', error: 'rejected before USER_INPUT', activities: [], finished: true };
      }
      req.onConversation?.(r3Id);
      req.onActivity?.({ type: 'result', status: 'OK', response: 'done' });
      return { conversationId: r3Id, status: 'OK', response: 'done', activities: [], finished: true };
    });
    await errRuntime.setSession(root, 'fixture', true);
    await assert.rejects(drain(await errRuntime.beginStreamTurn({ modelId: 'fixture', prompt: 'ASK_1', historyBootstrap: 'PRIOR_HISTORY' })), /interrupted/);
    errRuntime.finishTurn();
    await flush();
    assert.equal(errRuntime.snapshot().conversationId, undefined);

    phase = 'structured-error';
    await drain(await errRuntime.beginStreamTurn({ modelId: 'fixture', prompt: 'ASK_2', historyBootstrap: 'PRIOR_HISTORY' }));
    errRuntime.finishTurn();
    await flush();
    assert.equal(errRuntime.snapshot().conversationId, undefined);
    assert.equal(errRuntime.snapshot().turns, 0);

    phase = 'ok';
    await drain(await errRuntime.beginStreamTurn({ modelId: 'fixture', prompt: 'ASK_3', historyBootstrap: 'PRIOR_HISTORY' }));
    errRuntime.finishTurn();
    assert.match(errPrompts[2], /PRIOR_HISTORY/);
    await errRuntime.close();

    // 3. Interrupted stale-resume fresh fallback re-arms historyPrefill + historyBootstrap (F2).
    const r5Id = 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc';
    const r5Db = new DatabaseSync(path.join(dataDir, 'conversations', `${r5Id}.db`));
    r5Db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB)');
    const r5Calls = [];
    const r5Runtime = createAntigravityRuntime(async (req) => {
      r5Calls.push(req.prompt);
      if (r5Calls.length === 1) throw new Error('conversation old-id does not exist');
      req.onConversation?.(r5Id);
      if (r5Calls.length === 2) {
        r5Db.prepare('INSERT INTO steps VALUES (0, 14, 3, NULL, ?)').run(Buffer.alloc(0));
        req.onActivity?.({ type: 'result', status: 'OK', response: 'ACK' });
        return { conversationId: r5Id, status: 'OK', response: 'ACK', activities: [], finished: true };
      }
      if (r5Calls.length === 3) throw new Error('interrupted mid-fallback');
      req.onActivity?.({ type: 'result', status: 'OK', response: 'done' });
      return { conversationId: r5Id, status: 'OK', response: 'done', activities: [], finished: true };
    });
    await r5Runtime.restoreConversation({
      conversationId: 'old-id',
      cwd: root,
      modelId: 'fixture',
      turns: 3,
      usage: {},
      systemPromptHash: 'same-hash',
    });
    const r5Req = { modelId: 'fixture', systemPromptHash: 'same-hash', historyPrefill: ['FB_A', 'FB_B'], historyBootstrap: 'FB_FINAL' };
    await assert.rejects(drain(await r5Runtime.beginStreamTurn({ ...r5Req, prompt: 'ASK_1' })), /interrupted mid-fallback/);
    r5Runtime.finishTurn();
    await flush();
    await drain(await r5Runtime.beginStreamTurn({ ...r5Req, prompt: 'ASK_2' }));
    r5Runtime.finishTurn();
    assert.equal(r5Calls[3], 'FB_A');
    assert.equal(r5Calls[4], 'FB_B');
    assert.match(r5Calls[5], /FB_FINAL/);
    await r5Runtime.close();
    r5Db.close();

    // 4. Empty metadata tables fail closed on both persistent and one-shot executors for closed-book nativeTools=[] (F5).
    const d1Id = '11111111-aaaa-4bbb-8ccc-dddddddddddd';
    const d1Db = new DatabaseSync(path.join(dataDir, 'conversations', `${d1Id}.db`));
    d1Db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER); INSERT INTO steps VALUES (0, 14); CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    d1Db.close();
    const f = fixture({ clock: false });
    let spawned = 0;
    f.executionDependencies.spawn = () => { spawned += 1; return f.child(980000 + spawned); };
    for (const executor of [new AgyDriverSession(f.executionDependencies), new AgyOneShotExecutor(f.executionDependencies)]) {
      await assert.rejects(
        executor.run({ binary: 'OFFLINE_NO_REAL_SPAWN', conversationId: d1Id, cwd: root, prompt: 'ASK', agentBody: 'BODY', agentRevision: 'rev1', nativeTools: [] }),
        /no CustomAgentSpec record found/,
      );
      await executor.close('shutdown');
    }
    assert.equal(spawned, 0);
  } finally {
    if (prevDataDir === undefined) delete process.env.JETSKI_APP_DATA_DIR;
    else process.env.JETSKI_APP_DATA_DIR = prevDataDir;
    if (prevBackoff === undefined) delete process.env.AGY_STALL_RETRY_BACKOFF_MS;
    else process.env.AGY_STALL_RETRY_BACKOFF_MS = prevBackoff;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
