import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { piHistoryBootstrap, piHistoryBootstrapChunks } from '../src/input/pi-input.ts';

const user = content => ({ role: 'user', content });
const answer = text => ({ role: 'assistant', content: [{ type: 'text', text }] });
const call = (name, args = {}) => ({ role: 'assistant', content: [{ type: 'toolCall', name, arguments: args }] });
const result = (name, text) => ({ role: 'toolResult', toolName: name, content: [{ type: 'text', text }] });
const archivedFile = prompt => JSON.parse(prompt.match(/Full prior transcript: (".*?")\./)[1]);

function temporaryRun(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-history-test-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('large tool results retain earlier task requests and complete small exchanges', () => temporaryRun(directory => {
  const task = 'Create a separate thread to handle Pro network drops; explain the cause first.';
  const clarification = 'The issue is Pro disconnecting, not the unfinished reply. Restate the task.';
  const context = { messages: [
    user(task), answer('I will check the connection.'), user(clarification),
    call('bash', { command: 'inspect-large-output' }), result('bash', 'large-output '.repeat(25_000)),
    call('read', { path: 'connection.json' }), result('read', '{"state":"connected"}'),
    answer('The connection is live.'), user('Is Pro still alive?'),
  ] };
  const original = JSON.stringify(context);
  const restored = piHistoryBootstrap(context, directory);
  assert.ok(restored.includes(task));
  assert.ok(restored.includes(clarification));
  assert.ok(restored.includes('[tool call: read {"path":"connection.json"}]'));
  assert.ok(restored.includes('tool read:\n{"state":"connected"}'));
  assert.ok(!restored.includes('[tool call: bash'));
  assert.ok(!restored.includes('tool bash:'));
  assert.match(restored, /Archived message\/tool exchange/);
  assert.ok(restored.length < 241_000);
  const full = readFileSync(archivedFile(restored), 'utf8');
  assert.ok(full.includes('[tool call: bash {"command":"inspect-large-output"}]'));
  assert.ok(full.includes('large-output '.repeat(25_000)));
  assert.ok(!full.includes('Is Pro still alive?'));
  assert.equal(piHistoryBootstrap(context, directory), restored);
  assert.equal(JSON.stringify(context), original);
}));

test('an oversized user message has a complete readable original and exact line range', () => temporaryRun(directory => {
  const requirement = 'Preserve every item in this specification.\n' + 'long requirement\n'.repeat(16_000);
  const restored = piHistoryBootstrap({ messages: [user(requirement), answer('Acknowledged.'), user('Continue.')] }, directory);
  assert.match(restored, /Archived user message/);
  assert.ok(restored.length < 241_000);
  const full = readFileSync(archivedFile(restored), 'utf8');
  const range = restored.match(/Archived user message: ".*?", lines (\d+)-(\d+)/);
  assert.equal(full.split('\n').slice(Number(range[1]) - 1, Number(range[2])).join('\n'), 'user:\n' + requirement);
  assert.ok(restored.includes('assistant:\nAcknowledged.'));
}));

test('large tool arguments are archived with their result, never split into partial JSON', () => temporaryRun(directory => {
  const args = { body: 'argument-data '.repeat(20_000) };
  const restored = piHistoryBootstrap({ messages: [user('Keep this task.'), call('write', args), result('write', 'done'), user('Continue.')] }, directory);
  assert.ok(restored.includes('Keep this task.'));
  assert.ok(!restored.includes('[tool call: write'));
  assert.ok(!restored.includes('tool write:'));
  const full = readFileSync(archivedFile(restored), 'utf8');
  const line = full.split('\n').find(line => line.startsWith('[tool call: write '));
  assert.deepEqual(JSON.parse(line.slice('[tool call: write '.length, -1)), args);
  assert.ok(full.includes('tool write:\ndone'));
}));

// Same text the SDK renders for a compaction entry (convertToLlm).
const compactionSummary = text => ({ role: 'user', content: [{ type: 'text',
  text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${text}\n</summary>` }] });
const bytes = text => Buffer.byteLength(text, 'utf8');
// agy hands the model at most 192,000 UTF-8 bytes of one USER_INPUT.
const AGY_DELIVERED_BYTES = 192_000;
const summaryText = '压缩摘要：保留视频分析结论与文件路径。'.repeat(260);
const older = '较早的用户要求：逐帧对比头发与面部细节。'.repeat(1000);
const toolOutput = '工具输出：帧差分统计数据。'.repeat(1500);
const newest = '最新的用户补充：保持正面朝向一致。'.repeat(1500);
const compactedBranch = request => ({ messages: [
  compactionSummary(summaryText), user(older), call('bash', { command: 'diff-frames' }),
  result('bash', toolOutput), user(newest), answer('收到。'), user(request),
] });

test('multi-byte history is budgeted in UTF-8 bytes and keeps the compaction summary first', () => temporaryRun(directory => {
  const request = '继续分析第 216 帧。';
  assert.ok(bytes(summaryText + older + toolOutput + newest) > AGY_DELIVERED_BYTES);
  const restored = piHistoryBootstrap(compactedBranch(request), directory);
  assert.ok(bytes(`${restored}\n\n${request}`) <= AGY_DELIVERED_BYTES - 16_000);
  assert.ok(restored.includes(summaryText));
  assert.ok(restored.includes(newest));
  assert.ok(restored.includes(older));
  assert.match(restored, /Archived message\/tool exchange/);
  assert.ok(readFileSync(archivedFile(restored), 'utf8').includes(toolOutput));
}));

// DEBT-0059: a rebuild with no new user message must keep the tool work already
// done for the current request, without unfinished calls.
const callWithId = (id, name, args = {}) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] });
const resultFor = (id, name, text) => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }] });

test('completed tool exchanges after the latest user message are restored as work already done', () => temporaryRun(directory => {
  const context = { messages: [
    user('Earlier task.'), answer('Done earlier.'), user('Count the files, then summarize.'),
    callWithId('c1', 'bash', { command: 'ls | wc -l' }), resultFor('c1', 'bash', '42'),
    { role: 'assistant', content: [{ type: 'text', text: 'Counted; now summarizing.' },
      { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'pending.txt' } }] },
  ] };
  const restored = piHistoryBootstrap(context, directory);
  assert.ok(restored.includes('Earlier task.'));
  assert.ok(restored.includes('[tool call: bash {"command":"ls | wc -l"}]'));
  assert.ok(restored.includes('tool bash:\n42'));
  assert.ok(restored.includes('Counted; now summarizing.'));
  assert.ok(!restored.includes('pending.txt'), 'a call without a result is not completed work');
  assert.ok(!restored.includes('Count the files'), 'the current request is sent separately');
  const history = restored.indexOf('Earlier task.');
  const progress = restored.indexOf('## Work already done for the current request');
  assert.ok(history >= 0 && progress > history);
  assert.ok(restored.indexOf('tool bash:\n42') > progress);
  assert.ok(restored.endsWith('## Current user request'));
}));

test('completed work is restored even when the current request has no earlier history', () => temporaryRun(directory => {
  const restored = piHistoryBootstrap({ messages: [
    user('Run the build.'), callWithId('c1', 'bash', { command: 'npm run build' }), resultFor('c1', 'bash', 'build ok'),
  ] }, directory);
  assert.ok(restored);
  assert.match(restored, /## Work already done for the current request/);
  assert.ok(restored.includes('tool bash:\nbuild ok'));
  assert.equal(piHistoryBootstrap({ messages: [user('Run the build.')] }, directory), undefined);
}));

test('a branch ending with a user message has no completed-work section', () => temporaryRun(directory => {
  assert.doesNotMatch(piHistoryBootstrap(compactedBranch('继续。'), directory), /Work already done/);
}));

test('condensed history keeps the completed work inline within the input budget', () => temporaryRun(directory => {
  const request = '继续。';
  const context = compactedBranch(request);
  context.messages.push(callWithId('c9', 'bash', { command: 'diff-frames --all' }), resultFor('c9', 'bash', '帧差分完成：12 处变化'));
  const restored = piHistoryBootstrap(context, directory);
  assert.match(restored, /Archived message\/tool exchange/);
  assert.ok(restored.includes('帧差分完成：12 处变化'));
  assert.ok(restored.includes(summaryText));
  assert.ok(bytes(`${restored}\n\n${request}`) <= AGY_DELIVERED_BYTES - 16_000);
}));

test('a large current request shrinks restored history instead of being cut off', () => temporaryRun(directory => {
  const request = '当前请求：' + '请完整保留这段需求。'.repeat(4900);
  const restored = piHistoryBootstrap(compactedBranch(request), directory);
  assert.ok(bytes(`${restored}\n\n${request}`) < AGY_DELIVERED_BYTES);
  assert.match(restored, /Archived summary/);
  assert.ok(readFileSync(archivedFile(restored), 'utf8').includes(summaryText));
}));

test('multi-chunk bootstrap restores ~360 KB and ~720 KB histories fully inline without archiving or exceeding 176 KB per turn', () => temporaryRun(directory => {
  for (const turnCount of [8, 16]) {
    const messages = [];
    const markers = [];
    for (let i = 0; i < turnCount; i++) {
      const uMark = `USER_TURN_MARKER_${i}_HEAD`;
      const aMark = `ASSISTANT_TURN_MARKER_${i}_TAIL`;
      markers.push(uMark, aMark);
      messages.push(
        user(`${uMark}\n` + `第 ${i} 轮用户需求细节说明。`.repeat(450)),
        answer(`${aMark}\n` + `第 ${i} 轮模型完整推理结论与代码定位。`.repeat(450)),
      );
    }
    const ask = '汇总上述所有轮次的标记。';
    messages.push(user(ask));
    const plan = piHistoryBootstrapChunks({ messages }, directory);
    assert.ok(plan.prefill.length >= 1 && plan.prefill.length <= 4);
    assert.ok(plan.bootstrap);
    for (const chunk of plan.prefill) {
      assert.ok(bytes(chunk) <= 176_000, `prefill chunk ${bytes(chunk)} > 176,000`);
      assert.doesNotMatch(chunk, /Archived /);
    }
    assert.ok(bytes(`${plan.bootstrap}\n\n${ask}`) <= 176_000);
    assert.doesNotMatch(plan.bootstrap, /Archived /);
    assert.equal(existsSync(path.join(directory, 'history')), false, 'lossless multi-chunk restore should not write archive files');
    const combined = [...plan.prefill, plan.bootstrap].join('\n\n');
    let cursor = -1;
    for (const marker of markers) {
      const next = combined.indexOf(marker);
      assert.ok(next > cursor, `marker ${marker} missing or out of chronological order`);
      cursor = next;
    }
  }
}));

test('multi-chunk bootstrap shifts history into prefill when the current user request is huge', () => temporaryRun(directory => {
  const earlierSpec = 'SPEC_ANCHOR_KEEP_WHOLE\n' + '关键历史上下文不能被压缩成 8KB 指针。'.repeat(2_200);
  const hugeAsk = '当前超大请求：' + '请对照完整历史规格逐条核验。'.repeat(3_600);
  const plan = piHistoryBootstrapChunks({
    messages: [user(earlierSpec), answer('已记录全部历史规格。'), user(hugeAsk)],
  }, directory);
  assert.equal(plan.prefill.length, 1);
  assert.ok(plan.prefill[0].includes('SPEC_ANCHOR_KEEP_WHOLE'));
  assert.doesNotMatch(plan.prefill[0], /Archived /);
  assert.ok(plan.bootstrap);
  assert.match(plan.bootstrap, /Part 1 of the prior pi history was loaded/);
  assert.ok(bytes(`${plan.bootstrap}\n\n${hugeAsk}`) < AGY_DELIVERED_BYTES);
}));

test('multi-chunk bootstrap condenses >900 KB history and single >172 KB monster tool outputs while keeping user turns inline', () => temporaryRun(directory => {
  const monsterOutput = 'MONSTER_LINE '.repeat(18_000); // ~234 KB > 172 KB single-chunk cap
  const messages = [
    compactionSummary('COMPACTION_SUMMARY_ANCHOR ' + summaryText),
    user('FIRST_USER_GOAL ' + '保留第一轮核心目标。'.repeat(900)),
    call('bash', { command: 'dump-huge-log' }),
    result('bash', monsterOutput),
  ];
  for (let i = 0; i < 18; i++) {
    messages.push(
      user(`USER_KEEP_${i} ` + '用户补充约束。'.repeat(300)),
      call('read', { path: `module-${i}.ts` }),
      result('read', `MODULE_BODY_${i} ` + '模块源码内容摘录。'.repeat(1_800)),
    );
  }
  const ask = '继续实施。';
  messages.push(user(ask));

  const plan = piHistoryBootstrapChunks({ messages }, directory);
  assert.equal(plan.prefill.length, 4);
  assert.ok(plan.bootstrap);
  for (const chunk of plan.prefill) assert.ok(bytes(chunk) <= 176_000);
  assert.ok(bytes(`${plan.bootstrap}\n\n${ask}`) <= 176_000);

  const combined = [...plan.prefill, plan.bootstrap].join('\n\n');
  assert.ok(combined.includes('COMPACTION_SUMMARY_ANCHOR'));
  assert.ok(combined.includes('FIRST_USER_GOAL'));
  for (let i = 0; i < 18; i++) assert.ok(combined.includes(`USER_KEEP_${i}`));
  // Monster 234 KB tool output is archived with exact line pointers, while recent exchanges stay inline.
  assert.ok(!combined.includes(monsterOutput));
  assert.match(combined, /Archived message\/tool exchange/);
  assert.ok(combined.includes('MODULE_BODY_17'));
  assert.ok(readFileSync(archivedFile(combined), 'utf8').includes('MONSTER_LINE'));
}));
