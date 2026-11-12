import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { AgyPrefixAudit, PREFIX_AUDIT_ENTRY } from '../src/native/prefix-audit.ts';
import { registerAgyCommand } from '../src/extension/agy-command.ts';

const ID = '11111111-1111-1111-1111-111111111111';
const scalar = (writer, n, value) => writer.tag(n, WireType.Varint).uint64(BigInt(value));
const blob = (writer, n, value) => writer.tag(n, WireType.LengthDelimited).bytes(value);
function metadata({ system = 'SYSTEM_SECRET\n', prompts = ['USER_SECRET'], cache = 0, output = 2, annotation = 'one', seconds = 270, nanos = 972360100, failed = false } = {}) {
  const usage = new BinaryWriter(); scalar(usage, 2, 10); scalar(usage, 3, output); scalar(usage, 5, cache);
  const chat = new BinaryWriter(); blob(chat, 1, Buffer.from(system)); blob(chat, 4, usage.finish()); scalar(chat, 3, 427);
  const tool = new BinaryWriter().tag(1, WireType.LengthDelimited).string('read')
    .tag(2, WireType.LengthDelimited).string('DESCRIPTION_SECRET');
  blob(chat, 8, tool.finish());
  for (const prompt of prompts) {
    const msg = new BinaryWriter().tag(1, WireType.LengthDelimited).string(annotation)
      .tag(3, WireType.LengthDelimited).string(prompt);
    scalar(msg, 2, 1); scalar(msg, 4, annotation.length);
    // Non-public fields deliberately contain invalid UTF-8; the audit only hashes opaque bytes.
    blob(msg, 17, Uint8Array.of(0xff, 0xfe)); blob(msg, 20, Uint8Array.of(0xff));
    blob(chat, 2, msg.finish());
  }
  const duration = new BinaryWriter(); scalar(duration, 1, seconds); scalar(duration, 2, nanos);
  blob(chat, 11, duration.finish());
  const root = blob(new BinaryWriter(), 1, chat.finish());
  if (failed) blob(root, 5, Buffer.from('ERROR_SECRET'));
  return root.finish();
}
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
  t.after(() => db.close());
  const events = [];
  const audit = new AgyPrefixAudit(e => events.push(e));
  const put = (idx, options) => db.prepare('INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)').run(idx, metadata(options));
  return { db, events, audit, put };
}
const tool = { name: 'codemode', description: 'DESCRIPTION_SECRET', parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } };
const agent = { name: 'pi-native-one', agentBody: 'AGENT_SECRET' };

test('records changed components without mutating declarations or storing their content', () => {
  const events = []; const audit = new AgyPrefixAudit(e => events.push(e));
  const before = JSON.stringify(tool);
  audit.recordLocal('SYSTEM_SECRET\r\n', [tool], agent);
  audit.recordLocal('SYSTEM_SECRET\r\n', [tool], agent);
  assert.equal(events.length, 1);
  const reordered = { ...tool, parameters: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' } };
  audit.recordLocal('SYSTEM_SECRET\n', [reordered], { ...agent, name: 'pi-native-two', agentBody: 'changed' });
  assert.deepEqual(events.at(-1).changes, ['system_line_endings', 'bridge_identity', 'schema_order:codemode', 'agent_body']);
  audit.recordLocal('SYSTEM_SECRET\n', [{ ...reordered, description: 'new catalog' }], agent);
  assert.ok(events.at(-1).changes.includes('tool_description:codemode'));
  audit.recordLocal('SYSTEM_SECRET\n', [{ ...tool, name: 'late' }, tool], agent);
  assert.ok(events.at(-1).changes.includes('tool_list_or_order'));
  assert.ok(events.at(-1).changes.includes('tool_added:late'));
  assert.equal(JSON.stringify(tool), before);
  assert.doesNotMatch(JSON.stringify(events), /SYSTEM_SECRET|DESCRIPTION_SECRET|AGENT_SECRET/);
});

test('correlates successful native cache usage with append-only history, newline drift and sampling gaps', t => {
  const { db, events, audit, put } = fixture(t);
  put(0); audit.observeNative(ID, db);
  put(1, { prompts: ['USER_SECRET', 'ANSWER_SECRET'], annotation: 'different id', cache: 1000 });
  audit.observeNative(ID, db); audit.observeNative(ID, db);
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).historyPrefixPreserved, true);
  assert.deepEqual(events.at(-1).changes, []);
  assert.match(audit.summary(), /99\.0%/);
  put(2, { prompts: ['USER_SECRET', 'ANSWER_SECRET', 'TOOL_SECRET'] }); audit.observeNative(ID, db);
  assert.deepEqual(events.at(-1).changes, []);
  assert.match(audit.details().join('\n'), /零缓存原因: 未定/);
  assert.equal(events.at(-1).snapshot.ttftMs, 270972.3601);
  put(4, { system: 'SYSTEM_SECRET\r\n', prompts: ['USER_SECRET', 'ANSWER_SECRET', 'TOOL_SECRET'] });
  audit.observeNative(ID, db);
  assert.deepEqual(events.at(-1).changes, ['system_line_endings']);
  assert.equal(events.at(-1).missingGenerations, 1);
  put(5, { prompts: ['REWRITTEN_SECRET'] }); audit.observeNative(ID, db);
  assert.ok(events.at(-1).changes.includes('history_record_changed'));
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
});

test('pending and usage-only records are not falsely reported as cold requests', t => {
  const { db, events, audit, put } = fixture(t);
  put(0, { output: 0 }); audit.observeNative(ID, db);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'pending');
  assert.doesNotMatch(audit.summary(), /0\.0%/);
  put(0); audit.observeNative(ID, db);
  put(1, { prompts: [], cache: 1000 }); audit.observeNative(ID, db);
  assert.equal(events.filter(e => e.kind === 'native').length, 1);
  assert.equal(events.find(e => e.kind === 'native').snapshot.generation, 0);
  assert.equal(events.at(-1).status, 'usage_only');
  assert.match(audit.summary(), /最新 #1 仅用量/);
});

test('samples complete records above 8MiB without a size-based gap', t => {
  const { db, events, audit, put } = fixture(t);
  put(0, { prompts: ['x'.repeat(8 * 1024 * 1024 + 1)] });
  audit.observeNative(ID, db);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'native');
  assert.equal(events[0].snapshot.messageCount, 1);
});

test('restores branch-local baselines, not messages, and compares the next native generation', t => {
  const { db, events, audit, put } = fixture(t);
  audit.recordLocal('SYSTEM_SECRET', [tool], agent); put(0); audit.observeNative(ID, db);
  const restored = new AgyPrefixAudit(e => events.push(e));
  restored.restore(events.map(data => ({ type: 'custom', customType: PREFIX_AUDIT_ENTRY, data })));
  put(1, { prompts: ['USER_SECRET', 'ANSWER_SECRET'] }); restored.observeNative(ID, db);
  assert.equal(events.at(-1).previousGeneration, 0);
  assert.equal(events.at(-1).historyPrefixPreserved, true);
  restored.recordLocal('SYSTEM_SECRET', [tool], agent);
  assert.match(restored.details().join('\n'), /本次检查未变/);
});

test('diagnostics schedule no timers and ignore text/thinking delta activity', t => {
  const audit = new AgyPrefixAudit(() => {});
  const samples = [];
  const source = () => ID;
  t.mock.method(globalThis, 'setTimeout', () => { throw Error('unexpected timer'); });
  t.mock.method(globalThis, 'setInterval', () => { throw Error('unexpected interval'); });
  t.mock.method(audit, 'sample', (...args) => samples.push(args));
  for (const type of ['text', 'thought', 'native_thinking_snapshot', 'usage', 'tool_done']) {
    audit.observeActivity({ type }, source, 'fixture');
  }
  assert.equal(samples.length, 0);
  for (const type of ['response_end', 'bridge_call', 'result']) audit.observeActivity({ type }, source, 'fixture');
  assert.equal(samples.length, 3);
  assert.deepEqual(samples[0], [ID, 'fixture']);
});

test('event sampling closes its read-only connection and journal failure does not abort work', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-prefix-audit-'));
  const old = process.env.JETSKI_APP_DATA_DIR;
  process.env.JETSKI_APP_DATA_DIR = path.join(root, 'cli');
  const dir = path.join(root, 'cli', 'conversations'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ID}.db`);
  const writer = new DatabaseSync(file);
  writer.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
  writer.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(metadata()); writer.close();
  t.after(() => { if (old === undefined) delete process.env.JETSKI_APP_DATA_DIR; else process.env.JETSKI_APP_DATA_DIR = old; fs.rmSync(root, { recursive: true, force: true }); });
  const before = fs.readFileSync(file);
  const events = []; const audit = new AgyPrefixAudit(e => events.push(e));
  audit.observeActivity({ type: 'response_end' }, () => ID, root);
  assert.equal(events.length, 1);
  assert.deepEqual(fs.readFileSync(file), before);
  const warnings = []; t.mock.method(console, 'warn', text => warnings.push(text));
  const broken = new AgyPrefixAudit(() => { throw Error('disk full'); });
  assert.doesNotThrow(() => broken.sample(ID, root));
  assert.equal(warnings.length, 1);
  assert.match(broken.details().join('\n'), /journal\/Error/);
  fs.renameSync(file, `${file}.closed`); // Windows also verifies no connection is kept open.
});

test('/agy shows the audit through the real registered command without a model call', async () => {
  let command; const notifications = []; const audit = new AgyPrefixAudit(() => {});
  audit.recordDiagnostic({ phase: 'driver_recycle', atMs: 1, message: 'agent' });
  registerAgyCommand({ registerCommand: (_name, def) => { command = def; } }, {
    runtime: { snapshot: () => ({ turns: 0, executor: { mode: 'persistent', state: 'idle' } }) }, sync: {}, audit,
  });
  await command.handler('', { ui: { notify: text => notifications.push(text) } });
  assert.match(notifications[0], /prefix audit: v1/);
  assert.match(notifications[0], /最近配置回收: agent/);
});

test('backfills completed generations even when the newest record is pending or failed', t => {
  const { db, events, audit, put } = fixture(t);
  put(0, { cache: 90 }); put(1, { prompts: ['USER_SECRET', 'SECOND_SECRET'], cache: 91 });
  put(2, { output: 0 });
  audit.observeNative(ID, db);
  assert.deepEqual(events.filter(e => e.kind === 'native').map(e => e.snapshot.generation), [0, 1]);
  assert.equal(events.at(-1).status, 'pending');
  assert.match(audit.summary(), /上次缓存 90\.1%.*最新 #2 用量待完成/);
  put(2, { failed: true }); audit.observeNative(ID, db);
  assert.equal(events.at(-1).status, 'failed');
  assert.match(audit.details().join('\n'), /完整=2 待完成=0 仅用量=0 失败=1/);
  const count = events.length; audit.observeNative(ID, db);
  assert.equal(events.length, count, 'unchanged failure does not flood the journal');
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
});

test('refreshes same-generation usage and TTFT after native metadata settles', t => {
  const { db, events, audit, put } = fixture(t);
  put(0, { cache: 10, seconds: 1, nanos: 0 }); audit.observeNative(ID, db);
  put(0, { cache: 90, seconds: 9, nanos: 0 }); audit.observeNative(ID, db);
  assert.equal(events.length, 2);
  assert.equal(events[1].snapshot.cacheReadTokens, 90);
  assert.equal(events[1].snapshot.ttftMs, 9000);
  assert.equal(events[1].recordUpdated, true);
  assert.equal(events[1].previousGeneration, undefined);
  assert.match(audit.summary(), /90\.0%/);
  audit.observeNative(ID, db);
  assert.equal(events.length, 2);
});

test('a late pending generation repairs the next comparison without moving the latest sample backward', t => {
  const { db, events, audit, put } = fixture(t);
  put(0); audit.observeNative(ID, db);
  put(1, { output: 0 }); put(2, { prompts: ['USER_SECRET', 'SECOND_SECRET', 'THIRD_SECRET'] });
  audit.observeNative(ID, db);
  assert.equal(events.at(-1).missingGenerations, 1);
  put(1, { prompts: ['USER_SECRET', 'SECOND_SECRET'] }); audit.observeNative(ID, db);
  const latest = events.filter(e => e.kind === 'native').at(-1);
  assert.equal(latest.snapshot.generation, 2);
  assert.equal(latest.previousGeneration, 1);
  assert.equal(latest.missingGenerations, 0);
  assert.equal(latest.historyPrefixPreserved, true);
  assert.match(audit.details().join('\n'), /#2 · 对照=1 · 缺口=0/);
});

test('journal failures retry native and local baselines and update UI only after acceptance', t => {
  const { db, put } = fixture(t);
  const events = []; const views = []; let fail = true;
  t.mock.method(console, 'warn', () => {});
  const audit = new AgyPrefixAudit(e => {
    if (fail) { const error = Error('PRIVATE_SECRET'); error.name = 'TOKEN_SECRET'; throw error; }
    events.push(e);
  }, () => views.push(audit.summary()));
  put(0, { cache: 90 });
  assert.doesNotThrow(() => audit.observeNative(ID, db));
  audit.recordLocal('SYSTEM_SECRET', [tool], agent);
  assert.equal(events.length, 0);
  assert.match(audit.details().join('\n'), /journal\/Error/);
  assert.doesNotMatch(audit.details().join('\n'), /SECRET/);
  fail = false;
  audit.observeNative(ID, db); audit.recordLocal('SYSTEM_SECRET', [tool], agent);
  assert.deepEqual(events.map(e => e.kind), ['native', 'local']);
  assert.match(views.at(-1), /90\.0%/);
  assert.doesNotMatch(audit.details().join('\n'), /journal\/Error/);
  const restored = new AgyPrefixAudit(e => events.push(e));
  restored.restore(events.map(data => ({ type: 'custom', customType: PREFIX_AUDIT_ENTRY, data })));
  restored.observeNative(ID, db);
  assert.equal(events.length, 2);
  assert.match(restored.summary(), /90\.0%/);
});

test('journal failure in the middle of a batch never skips uncommitted generations', t => {
  const { db, put } = fixture(t);
  const events = []; let fail = true;
  t.mock.method(console, 'warn', () => {});
  const audit = new AgyPrefixAudit(e => {
    if (fail && e.kind === 'native' && e.snapshot.generation === 1) throw Error('disk full');
    events.push(e);
  });
  put(0); put(1); put(2);
  audit.observeNative(ID, db);
  assert.deepEqual(events.map(e => e.snapshot.generation), [0]);
  fail = false; audit.observeNative(ID, db);
  assert.deepEqual(events.map(e => e.snapshot.generation), [0, 1, 2]);
});

test('malformed records are explicit coverage gaps and cannot suppress later complete records', t => {
  const { db, events, audit, put } = fixture(t);
  db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(Uint8Array.of(0xff));
  put(1, { cache: 90 }); audit.observeNative(ID, db);
  assert.equal(events[0].kind, 'native_observation');
  assert.equal(events[0].status, 'invalid');
  assert.equal(events[1].snapshot.generation, 1);
  assert.match(audit.details().join('\n'), /无法解析=1/);
  assert.match(audit.summary(), /90\.0%/);
});

test('conversation switches and detached UI keep durable samples isolated and usable', t => {
  const { db, events, put } = fixture(t);
  const audit = new AgyPrefixAudit(e => events.push(e), () => { throw Error('detached UI'); });
  put(0, { cache: 90 });
  assert.doesNotThrow(() => audit.observeNative(ID, db));
  const other = '22222222-2222-2222-2222-222222222222';
  assert.doesNotThrow(() => audit.observeNative(other, db));
  assert.equal(events.at(-1).snapshot.conversationId, other);
  assert.equal(events.at(-1).previousGeneration, undefined);
  assert.deepEqual(events.at(-1).changes, ['baseline']);
});

test('late insertion into a previously missing generation is discovered without losing later samples', t => {
  const { db, events, audit, put } = fixture(t);
  put(0); put(2, { prompts: ['USER_SECRET', 'SECOND_SECRET', 'THIRD_SECRET'] });
  audit.observeNative(ID, db);
  assert.equal(events.at(-1).missingGenerations, 1);
  put(1, { prompts: ['USER_SECRET', 'SECOND_SECRET'] });
  audit.observeNative(ID, db);
  const native = events.filter(e => e.kind === 'native');
  assert.ok(native.some(e => e.snapshot.generation === 1));
  assert.equal(native.at(-1).snapshot.generation, 2);
  assert.equal(native.at(-1).previousGeneration, 1);
  assert.equal(native.at(-1).missingGenerations, 0);
});

test('restore skips malformed diagnostic entries, preserves valid samples and refreshes only once', t => {
  const { db, events, audit, put } = fixture(t);
  put(0, { cache: 90 }); audit.observeNative(ID, db);
  let refreshes = 0;
  const restored = new AgyPrefixAudit(() => { throw Error('restore must not journal'); }, () => refreshes++);
  const bad = [
    { version: 1, kind: 'native', atMs: 1 },
    { version: 1, kind: 'local', atMs: 1, snapshot: { tools: [] }, changes: [] },
    { version: 1, kind: 'native_observation', atMs: Infinity, generation: -1, status: 'pending' },
  ].map(data => ({ type: 'custom', customType: PREFIX_AUDIT_ENTRY, data }));
  assert.doesNotThrow(() => restored.restore([
    ...events.map(data => ({ type: 'custom', customType: PREFIX_AUDIT_ENTRY, data })),
    ...bad,
    { type: 'custom', customType: 'pi-antigravity-turn-diagnostic' },
    ...Array.from({ length: 1000 }, (_, i) => ({ type: 'custom', customType: 'pi-antigravity-turn-diagnostic',
      data: { phase: 'attempt_end', atMs: i + 1, attempt: 1, status: 'OK' } })),
  ]));
  assert.equal(refreshes, 1);
  assert.match(restored.summary(), /90\.0%/);
  assert.match(restored.details().join('\n'), /restore\/InvalidEntry/);
});

test('runtime snapshot getter failure cannot abort event delivery', () => {
  const events = []; const audit = new AgyPrefixAudit(e => events.push(e));
  assert.doesNotThrow(() => audit.observeActivity({ type: 'result' }, () => { throw Error('PRIVATE_SECRET'); }));
  assert.equal(events[0].kind, 'warning');
  assert.equal(events[0].stage, 'native_source');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SECRET/);
});

test('host timing is attempt-scoped, restoreable and clearly distinct from service timing', () => {
  const audit = new AgyPrefixAudit(() => {});
  const first = [
    { phase: 'attempt_start', atMs: 1000, attempt: 1 },
    { phase: 'local_run_start', atMs: 1002, attempt: 1 },
    { phase: 'stdin_ready', atMs: 1012, attempt: 1 },
    { phase: 'stdin_write_complete', atMs: 1014, attempt: 1 },
    { phase: 'stdout_first_byte', atMs: 1102, attempt: 1 },
    { phase: 'response_text_first', atMs: 272002, attempt: 1 },
    { phase: 'attempt_end', atMs: 273000, attempt: 1, status: 'OK' },
  ];
  for (const event of first) audit.recordDiagnostic(event);
  assert.match(audit.details().join('\n'), /首段回复正文=271\.000秒/);
  assert.match(audit.details().join('\n'), /不等于 HTTPS 发出、模型首 token/);
  audit.recordDiagnostic({ phase: 'attempt_start', atMs: 300000, attempt: 2 });
  audit.recordDiagnostic({ phase: 'local_run_start', atMs: 300002, attempt: 2 });
  audit.recordDiagnostic({ phase: 'response_text_first', atMs: 300003, attempt: 1 });
  assert.doesNotMatch(audit.details().join('\n'), /首段回复正文=/);
  const restored = new AgyPrefixAudit(() => {});
  restored.restore(first.map(data => ({ type: 'custom', customType: 'pi-antigravity-turn-diagnostic', data })));
  assert.match(restored.details().join('\n'), /首段回复正文=271\.000秒/);
});
