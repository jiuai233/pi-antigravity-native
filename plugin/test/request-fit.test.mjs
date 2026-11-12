// DEBT-0060: agy hands the model only the first 192,000 UTF-8 bytes of one
// input. An oversized current request keeps its beginning and end (where the
// actual ask usually is) and names the omitted lines.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fitBridgeToolOutput, fitNativeRequest, MAX_BRIDGE_OUTPUT_BYTES } from '../src/input/pi-input.ts';
import { AgyPiBridge, resolveBridgeResultsFromContext } from '../src/extension/bridge.ts';
import { ToolProjection } from '../src/extension/tool-projection.ts';
import { executionSurface } from '../src/native/native-profile.ts';
import { steerNoticePrompt } from '../src/input/prompt.ts';
import { streamAntigravity } from '../src/provider/stream.ts';
import { AgyTurnController } from '../src/runtime/turn.ts';
import { fixture, memoryStream } from './offline-fixture.mjs';

const MAX_INLINE = 160_000;
const ASK = 'FINAL ASK: reply with KIWI-4417';
const bytes = text => Buffer.byteLength(text, 'utf8');
const numbered = (count, last) => `${Array.from({ length: count },
  (_, i) => `row ${String(i + 1).padStart(6, '0')}: ${'x'.repeat(40)}`).join('\n')}\n${last}`;

async function temporaryRun(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'agy-request-fit-'));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('a request within one agy input is sent unchanged', () => {
  assert.equal(fitNativeRequest('short ask'), 'short ask');
  const exact = 'a'.repeat(MAX_INLINE);
  assert.equal(fitNativeRequest(exact), exact);
});

test('an oversized request keeps its beginning and end inline and archives the full original', () => temporaryRun(directory => {
  const prompt = numbered(5000, ASK);
  assert.ok(bytes(prompt) > 192_000);
  const fitted = fitNativeRequest(prompt, { readable: true, directory });
  assert.ok(bytes(fitted) <= MAX_INLINE);
  assert.ok(fitted.includes('row 000001:'));
  assert.ok(fitted.endsWith(ASK));
  assert.match(fitted, /view_file/);
  const file = JSON.parse(fitted.match(/Full original: (".*?")\./)[1]);
  assert.equal(readFileSync(file, 'utf8'), prompt);
  const [, from, to] = fitted.match(/lines (\d+)-(\d+)/).map(Number);
  const lines = prompt.split('\n');
  assert.ok(from > 1 && to < lines.length);
  assert.ok(fitted.includes(lines[from - 2]), 'last kept head line');
  assert.ok(!fitted.includes(lines[from - 1]), 'first omitted line');
  assert.ok(!fitted.includes(lines[to - 1]), 'last omitted line');
  assert.ok(fitted.includes(lines[to]), 'first kept tail line');
  assert.equal(fitNativeRequest(prompt, { readable: true, directory }), fitted, 'deterministic across re-entries');
}));

test('without native file reading the omitted middle is stated and no file is written', () => temporaryRun(directory => {
  const fitted = fitNativeRequest(numbered(5000, ASK), { readable: false, directory });
  assert.ok(bytes(fitted) <= MAX_INLINE);
  assert.ok(fitted.endsWith(ASK));
  assert.match(fitted, /omitted/);
  assert.doesNotMatch(fitted, /Full original|view_file/);
  assert.equal(existsSync(path.join(directory, 'requests')), false);
}));

test('cuts never split a multi-byte character', () => temporaryRun(directory => {
  const last = '最后的问题：结论是什么？';
  const fitted = fitNativeRequest(`${'需求说明：'.repeat(30_000)}${last}`, { readable: true, directory });
  assert.ok(bytes(fitted) <= MAX_INLINE);
  assert.ok(!fitted.includes('\uFFFD'));
  assert.ok(fitted.endsWith(last));
}));

async function sentRequest(text, prepared, directory) {
  const f = fixture({
    piHistoryBootstrap: () => undefined, normalizeContext: context => context,
    getCurrentSystemPrompt: () => '', getCurrentTools: () => [], resolveBridgeResultsFromContext: () => 0,
    calculateCost: () => {}, createAssistantMessageEventStream: memoryStream, readAgyProcessProfile: () => ({}),
  });
  const requests = [];
  const runtime = () => ({
    async setSession() {}, snapshot: () => ({ cwd: os.tmpdir() }), finishTurn() {}, steerActiveTurn() {}, async close() {},
    async beginStreamTurn(request) {
      requests.push(request);
      const controller = new AgyTurnController(request.prompt);
      controller.push({ type: 'result', status: 'OK', response: 'ok' });
      controller.close();
      return controller;
    },
  });
  const stream = streamAntigravity({
    ...f.providerOptions,
    dependencies: { ...f.providerOptions.dependencies,
      fitNativeRequest: (value, options) => fitNativeRequest(value, { ...options, directory }) },
    runtime: runtime(), createIsolatedRuntime: runtime,
    replay: {}, bridge: { refreshTools() {}, serverName: 'fixture' }, isActiveTool: () => false,
    prepareAgent: async () => prepared,
  })({ id: 'fixture', api: 'fixture', provider: 'antigravity' }, { messages: [{ role: 'user', content: text }] }, {});
  await stream.ended;
  assert.equal(requests.length, 1);
  return requests[0].prompt;
}

const defaultAgent = { name: 'agent', nativeTools: ['view_file', 'generate_image'], nativeContractHash: 'h' };

test('the provider sends the fitted request, with a file pointer when view_file is available', () => temporaryRun(async directory => {
  assert.equal(await sentRequest('short ask', defaultAgent, directory), 'short ask');
  const sent = await sentRequest(numbered(5000, ASK), defaultAgent, directory);
  assert.ok(bytes(sent) <= MAX_INLINE);
  assert.ok(sent.endsWith(ASK));
  assert.match(sent, /Full original: .*view_file/s);
}));

test('closed-book agents and summary requests keep the beginning and end without a file pointer', () => temporaryRun(async directory => {
  const closed = await sentRequest(numbered(5000, ASK), { ...defaultAgent, nativeTools: [] }, directory);
  assert.ok(bytes(closed) <= MAX_INLINE);
  assert.ok(closed.endsWith(ASK));
  assert.doesNotMatch(closed, /Full original|view_file/);
  const instructions = 'Summarize the conversation above. FINAL INSTRUCTION KIWI-4417';
  const summary = await sentRequest(`<conversation>\n${numbered(5000, 'end')}\n</conversation>\n\n${instructions}`,
    defaultAgent, directory);
  assert.ok(bytes(summary) <= MAX_INLINE);
  assert.ok(summary.endsWith(instructions), 'Pi puts summary instructions last');
  assert.doesNotMatch(summary, /Full original|view_file/);
}));

test('bridge tool output within 10,240 bytes is returned unchanged, and 1 byte over keeps head+tail and archives full output', () => temporaryRun(directory => {
  assert.equal(fitBridgeToolOutput('short output', { directory }), 'short output');
  const exact = 'a'.repeat(MAX_BRIDGE_OUTPUT_BYTES);
  assert.equal(fitBridgeToolOutput(exact, { directory }), exact);
  assert.equal(existsSync(path.join(directory, 'tool-output')), false);

  const oneByteOver = `${'a'.repeat(5000)}\n${'b'.repeat(5240)}`;
  assert.equal(bytes(oneByteOver), MAX_BRIDGE_OUTPUT_BYTES + 1);
  const fittedOneOver = fitBridgeToolOutput(oneByteOver, { directory });
  assert.ok(bytes(fittedOneOver) <= MAX_BRIDGE_OUTPUT_BYTES);
  const oneOverFile = JSON.parse(fittedOneOver.match(/Full output: (".*?")\./)[1]);
  assert.equal(readFileSync(oneOverFile, 'utf8'), oneByteOver);

  const toolText = numbered(400, ASK);
  assert.ok(bytes(toolText) > MAX_BRIDGE_OUTPUT_BYTES);
  const fitted = fitBridgeToolOutput(toolText, { readable: true, directory });
  assert.ok(bytes(fitted) <= MAX_BRIDGE_OUTPUT_BYTES);
  assert.ok(fitted.includes('row 000001:'));
  assert.ok(fitted.endsWith(ASK));
  assert.match(fitted, /view_file/);
  const file = JSON.parse(fitted.match(/Full output: (".*?")\./)[1]);
  assert.equal(readFileSync(file, 'utf8'), toolText);
  const [, from, to] = fitted.match(/lines (\d+)-(\d+)/).map(Number);
  const lines = toolText.split('\n');
  assert.ok(from > 1 && to < lines.length);
  assert.ok(fitted.includes(lines[from - 2]), 'last kept head line');
  assert.ok(!fitted.includes(lines[from - 1]), 'first omitted line');
  assert.ok(!fitted.includes(lines[to - 1]), 'last omitted line');
  assert.ok(fitted.includes(lines[to]), 'first kept tail line');
}));

test('AgyPiBridge fits oversized tool and steer outputs within 10,240 bytes and respects closed-book profiles', () => temporaryRun(async directory => {
  const bridge = new AgyPiBridge('bfixture1');
  bridge.setToolPrefix('');
  bridge.setArchiveDirectory(directory);
  bridge.setToolSource(() => [{ name: 'bash', description: 'Run bash', parameters: { type: 'object' } }]);
  bridge.refreshTools();
  const largeOutput = numbered(400, 'FINAL_TAIL_ERROR_LINE_99');
  let pendingCallId;
  let nextCall = Promise.withResolvers();
  bridge.setOnCall(call => {
    pendingCallId = call.id;
    nextCall.resolve(call.id);
    return true;
  });
  await bridge.start();
  try {
    const callTool = async (name, args = {}) => {
      const res = await fetch(bridge.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json()).result;
    };

    // 1. Normal profile with steer + oversized tool output: steer stays intact,
    // combined text stays <= 10,240 bytes, and archive holds only the tool output.
    const steerText = steerNoticePrompt('Check the final error line first.');
    const pendingPromise = callTool('bash', { command: 'npm test' });
    await nextCall.promise;
    nextCall = Promise.withResolvers();
    resolveBridgeResultsFromContext(
      bridge,
      [{ role: 'toolResult', toolCallId: pendingCallId, isError: false, content: [{ type: 'text', text: largeOutput }] }],
      { text: steerText, delivered: () => {} },
    );
    const steeredResult = await pendingPromise;
    assert.equal(steeredResult.isError, false);
    assert.equal(steeredResult.content.length, 2);
    assert.equal(steeredResult.content[0].text, steerText);
    assert.ok(steeredResult.content[1].text.endsWith('FINAL_TAIL_ERROR_LINE_99'));
    assert.ok(bytes(`${steeredResult.content[0].text}\n${steeredResult.content[1].text}`) <= MAX_BRIDGE_OUTPUT_BYTES);
    const archivedPath = JSON.parse(steeredResult.content[1].text.match(/Full output: (".*?")\./)[1]);
    assert.equal(readFileSync(archivedPath, 'utf8'), largeOutput);

    // 2. Closed-book profile (evidence_only_v1) disables file pointers and writes no new archive file.
    const closedDir = path.join(directory, 'closed');
    bridge.setArchiveDirectory(closedDir);
    const projection = new ToolProjection({
      bridge,
      skills: () => [],
      readProfile: () => executionSurface.profiles.evidence_only_v1,
    });
    projection.refreshSkillTools();
    pendingCallId = undefined;
    const closedPromise = callTool('bash', { command: 'npm test' });
    await nextCall.promise;
    nextCall = Promise.withResolvers();
    bridge.resolveCall(pendingCallId, { content: largeOutput, isError: false });
    const closedResult = await closedPromise;
    assert.equal(closedResult.isError, false);
    assert.ok(bytes(closedResult.content[0].text) <= MAX_BRIDGE_OUTPUT_BYTES);
    assert.ok(closedResult.content[0].text.endsWith('FINAL_TAIL_ERROR_LINE_99'));
    assert.doesNotMatch(closedResult.content[0].text, /Full output|view_file/);
    assert.equal(existsSync(path.join(closedDir, 'tool-output')), false);

    // 3. Long steer + tiny or large tool output stays within MAX_BRIDGE_OUTPUT_BYTES,
    // and long archive directory paths dynamically shrink kept head+tail.
    const longArchiveDir = path.join(directory, 'long-temp', 'a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100));
    bridge.setReadable(true);
    bridge.setArchiveDirectory(longArchiveDir);
    const longPathFitted = fitBridgeToolOutput('H'.repeat(6000) + 'T'.repeat(6000), { directory: longArchiveDir });
    assert.ok(bytes(longPathFitted) <= MAX_BRIDGE_OUTPUT_BYTES);

    const deepUnicodeDir = path.join(directory, 'deep-unicode', ...Array.from({ length: 18 }, () => '临'.repeat(100)));
    const deepPathFitted = fitBridgeToolOutput('H'.repeat(6000) + 'T'.repeat(6000), { directory: deepUnicodeDir });
    assert.ok(bytes(deepPathFitted) <= MAX_BRIDGE_OUTPUT_BYTES);

    for (const [steerBody, toolBody] of [
      ['s'.repeat(10000), 'ok'],
      ['s'.repeat(9700), largeOutput],
    ]) {
      pendingCallId = undefined;
      const p = callTool('bash', { command: 'npm test' });
      await nextCall.promise;
    nextCall = Promise.withResolvers();
      resolveBridgeResultsFromContext(
        bridge,
        [{ role: 'toolResult', toolCallId: pendingCallId, isError: false, content: [{ type: 'text', text: toolBody }] }],
        { text: steerNoticePrompt(steerBody), delivered: () => {} },
      );
      const r = await p;
      const joined = r.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      assert.ok(bytes(joined) <= MAX_BRIDGE_OUTPUT_BYTES, `expected ${bytes(joined)} <= ${MAX_BRIDGE_OUTPUT_BYTES}`);
    }
  } finally {
    await bridge.close();
  }
}));
