
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AgyTurnController } from '../src/runtime/turn.ts';
import { newTurnOutcome, applyEvent } from '../src/driver/reducer.ts';
import { parseAgyLine } from '../src/driver/events.ts';
import { streamAntigravity } from '../src/provider/stream.ts';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { fixture, flush, memoryStream } from './offline-fixture.mjs';
import { registerWrapperTool } from '../src/extension/wrapper-tool.ts';
import { readNativeToolResult } from '../src/native/native-results.ts';
import { resolveAgyDataDirectory } from '../src/native/native-workspace.ts';
import { AgyReplayStore } from '../src/provider/replay.ts';

// Encode the existing CLI ToolInfo layout, not a new media output protocol.
function storedPayload(args, output) {
  const tool = new BinaryWriter();
  for (const [key, value] of Object.entries(args)) {
    const entry = new BinaryWriter().tag(1, WireType.LengthDelimited).string(key)
      .tag(2, WireType.LengthDelimited).string(value).finish();
    tool.tag(1, WireType.LengthDelimited).bytes(entry);
  }
  const text = new BinaryWriter().tag(1, WireType.LengthDelimited).string(output).finish();
  tool.tag(2, WireType.LengthDelimited).bytes(text);
  return new BinaryWriter().tag(140, WireType.LengthDelimited).bytes(tool.finish()).finish();
}

function registerWrapper(replay) {
  let wrapper;
  registerWrapperTool({ registerTool: tool => { wrapper = tool; } }, replay);
  return wrapper;
}

for (const mode of ['active-done', 'done-only', 'late-path', 'missing-record', 'error']) {
  test(`provider parses video ${mode} events and executes only the recorded-result wrapper`, async t => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-media-replay-'));
    const originalDataDirectory = process.env.JETSKI_APP_DATA_DIR;
    process.env.JETSKI_APP_DATA_DIR = path.join(cwd, 'cli-data');
    try {
      const file = path.join(cwd, 'clip.Mp4');
      // A real binary source acts as a tripwire for accidental read replay.
      const binary = Buffer.from('\x00\x00\x00\x18ftypmp42\x00VIDEO_BINARY_TRIPWIRE\xff', 'latin1');
      fs.writeFileSync(file, binary);
      const args = { AbsolutePath: file };
      const output = 'Native video result: 2 frames inspected.\n00:01 blue square\n00:02 orange circle';
      const directory = path.join(resolveAgyDataDirectory(cwd), 'conversations');
      fs.mkdirSync(directory, { recursive: true });
      const database = new DatabaseSync(path.join(directory, 'fixture.db'));
      try {
        database.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)');
        if (mode !== 'missing-record') {
          database.prepare('INSERT INTO steps VALUES (?, ?)').run(7, storedPayload(args, output));
        }
      } finally { database.close(); }
      const f = fixture({
        latestUserPrompt: () => ({ prompt: 'fixture' }), piHistoryBootstrap: () => undefined,
        normalizeContext: context => context, getCurrentSystemPrompt: () => '',
        readAgyProcessProfile: () => ({}), resolveAgyModelEffort: () => undefined,
        resolveBridgeResultsFromContext: () => 0, calculateCost: () => {},
        createAssistantMessageEventStream: memoryStream, readNativeToolResult,
        WRAPPER_TOOL_NAME: 'antigravity',
        createAntigravityRuntime: () => { throw new Error('Unexpected isolated runtime'); },
      });
      const controller = new AgyTurnController('fixture');
      const outcome = newTurnOutcome();
      const send = event => {
        for (const activity of applyEvent(outcome, parseAgyLine(JSON.stringify(event)))) {
          controller.push(activity);
        }
      };
      const step = (state, parameters, extra = {}) => ({ event: 'step_update', step_update: {
        step_index: 7, step_type: 'tool', state, tool_name: 'view_file',
        tool_info: { parameters, ...extra },
      } });
      if (mode !== 'done-only') {
        send(step('ACTIVE', mode === 'late-path' ? {} : args));
        send(step('ACTIVE', mode === 'late-path' ? {} : args));
      }
      const replay = new AgyReplayStore();
      const stream = streamAntigravity({ ...f.providerOptions,
        runtime: { beginStreamTurn: () => controller, finishTurn() {}, steerActiveTurn() {}, snapshot: () => ({ cwd, conversationId: 'fixture' }) },
        replay, bridge: { refreshTools() {}, serverName: 'fixture' },
      })({ id: 'fixture', api: 'fixture', provider: 'antigravity' }, { messages: [] }, {});
      await flush();
      const startsBeforeDone = stream.events.filter(event => event.type === 'toolcall_start').length;
      send(mode === 'error'
        ? step('ERROR', args, { error: { message: 'Native video inspection failed' } })
        : step('DONE', args, { output: '2 frames, CLI summary' }));
      send({ event: 'result', result: { status: 'SUCCESS', response: '' } });
      controller.close();
      await stream.ended;
      assert.equal(startsBeforeDone, mode === 'done-only' ? 0 : 1);
      const terminal = stream.events.at(-1);
      assert.equal(terminal.type, 'done');
      const calls = terminal.message.content.filter(block => block.type === 'toolCall');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, 'antigravity');
      const starts = stream.events.filter(event => event.type === 'toolcall_start');
      const ends = stream.events.filter(event => event.type === 'toolcall_end');
      assert.equal(starts.length, 1);
      assert.equal(ends.length, 1);
      assert.equal(starts[0].contentIndex, ends[0].contentIndex);
      const wrapper = registerWrapper(replay);
      if (mode === 'error') {
        await assert.rejects(wrapper.execute(calls[0].id, calls[0].arguments), /Native video inspection failed/);
      } else {
        const result = await wrapper.execute(calls[0].id, calls[0].arguments);
        if (mode === 'missing-record') {
          assert.match(result.content[0].text, /summary only; full native result unavailable/);
          assert.match(result.content[0].text, /2 frames, CLI summary/);
        } else {
          assert.equal(result.content[0].text, output);
          assert.equal(result.details.output, output);
          const rendered = wrapper.renderResult(result, { expanded: true },
            { fg: (_color, text) => text }, { isError: false });
          assert.ok(rendered.text.includes(output));
        }
        assert.doesNotMatch(JSON.stringify(result), /ftyp|VIDEO_BINARY_TRIPWIRE|\\u0000/);
        t.diagnostic(JSON.stringify({ mode, tool: calls[0].name, startsBeforeDone, result }));
      }
      assert.equal(replay.size, 0);
      assert.deepEqual(fs.readFileSync(file), binary);
    } finally {
      if (originalDataDirectory === undefined) delete process.env.JETSKI_APP_DATA_DIR;
      else process.env.JETSKI_APP_DATA_DIR = originalDataDirectory;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
