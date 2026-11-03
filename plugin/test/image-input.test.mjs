import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rehydrateSessionImages, storeImageAttachments } from '../src/input/image-input.ts';
import { latestUserPrompt, piHistoryBootstrap } from '../src/input/pi-input.ts';

const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 71]);
const image = { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' };
const temporaryDirectory = () => mkdtempSync(path.join(os.tmpdir(), 'agy-image-test-'));

test('cache preserves original bytes and reuses a stable file without temporary leftovers', () => {
  const directory = temporaryDirectory();
  try {
    const [file] = storeImageAttachments([image], directory);
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(storeImageAttachments([image], directory)[0], file);
    assert.match(file, /[a-f0-9]{64}\.png$/);
    assert.deepEqual(readdirSync(directory), [path.basename(file)]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('image-only user input is adapted internally without modifying the chat message', () => {
  const directory = temporaryDirectory();
  try {
    const context = { messages: [{ role: 'user', content: [image] }] };
    const before = JSON.stringify(context);
    const result = latestUserPrompt(context, directory);
    assert.equal(result.images, 1);
    assert.match(result.prompt, /native view_file/);
    assert.doesNotMatch(result.prompt, /omitted|does not support|text-only/);
    const file = JSON.parse(result.prompt.split('\n').find(line => line.startsWith('1. ')).slice(3));
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(JSON.stringify(context), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('history restoration rebuilds deleted cache files from recorded image blocks', () => {
  const directory = temporaryDirectory();
  try {
    const context = { messages: [
      { role: 'user', content: [{ type: 'text', text: 'Inspect this.' }, image] },
      { role: 'assistant', content: [{ type: 'text', text: 'An image.' }] },
      { role: 'user', content: 'What color was it?' },
    ] };
    const first = piHistoryBootstrap(context, directory);
    const file = JSON.parse(first.split('\n').find(line => line.startsWith('1. ')).slice(3));
    assert.deepEqual(readFileSync(file), bytes);
    rmSync(file);
    assert.equal(piHistoryBootstrap(context, directory), first);
    assert.deepEqual(readFileSync(file), bytes);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('full-branch rehydration includes originals recorded before a compaction entry', () => {
  const directory = temporaryDirectory();
  try {
    const branch = [
      { type: 'message', message: { role: 'user', content: [image] } },
      { type: 'compaction', summary: 'An earlier image was discussed.' },
      { type: 'message', message: { role: 'user', content: 'Use the earlier image.' } },
    ];
    const before = JSON.stringify(branch);
    const [file] = rehydrateSessionImages(branch, directory);
    assert.deepEqual(readFileSync(file), bytes);
    rmSync(file);
    assert.deepEqual(rehydrateSessionImages(branch, directory), [file]);
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(JSON.stringify(branch), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
