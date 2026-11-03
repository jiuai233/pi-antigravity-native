import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { NativeThinkingObserver } from '../src/native/native-thinking.ts';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const GENERATING = 8;
const DONE = 3;

function payload(text) {
  const planner = new BinaryWriter()
    .tag(3, WireType.LengthDelimited).string(text)
    // Deliberately invalid UTF-8 remains opaque in these non-public fields.
    .tag(16, WireType.LengthDelimited).bytes(Uint8Array.of(0xff, 0xfe))
    .tag(14, WireType.LengthDelimited).bytes(Uint8Array.of(0xff)).finish();
  return new BinaryWriter().tag(20, WireType.LengthDelimited).bytes(planner).finish();
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-thinking-'));
  const previous = process.env.JETSKI_APP_DATA_DIR;
  process.env.JETSKI_APP_DATA_DIR = 'native-data';
  const directory = path.join(root, 'native-data', 'conversations');
  fs.mkdirSync(directory, { recursive: true });
  const snapshots = [];
  const diagnostics = [];
  const writers = [];
  const observer = new NativeThinkingObserver({
    cwd: root,
    onSnapshot: snapshot => { snapshots.push(snapshot); return options.consume?.(snapshot) ?? false; },
    onDiagnostic: message => diagnostics.push(message),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
  });
  t.after(() => {
    try {
      observer.close();
      for (const writer of writers) writer.close();
    } finally {
      if (previous === undefined) delete process.env.JETSKI_APP_DATA_DIR;
      else process.env.JETSKI_APP_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  function create(id = A) {
    const db = new DatabaseSync(path.join(directory, `${id}.db`));
    writers.push(db);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
    return db;
  }
  function put(db, idx, text, status = GENERATING, stepType = 15) {
    db.prepare('INSERT OR REPLACE INTO steps VALUES (?, ?, ?, ?)').run(idx, stepType, status, payload(text));
  }
  return { observer, snapshots, diagnostics, create, put, directory };
}

function clock(t) {
  let seq = 0;
  const timers = new Map();
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    const id = ++seq;
    timers.set(id, { fn, ms });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  return timers;
}

// Real timer + real SQLite: a GENERATING row changes while the observer is alive.
test('polls live public thinking at the default interval, including Chinese and emoji', { timeout: 3000 }, async t => {
  let changed;
  const observed = new Promise(resolve => { changed = resolve; });
  const f = fixture(t, { consume: snapshot => {
    if (snapshot.text === '计划🙂：继续检查🚀') changed();
    return false;
  } });
  const db = f.create();
  f.put(db, 1, '');
  f.observer.prepare();
  f.observer.bind(A);
  assert.equal(f.snapshots[0].text, '');
  assert.equal(f.snapshots[0].status, GENERATING);
  f.put(db, 1, '计划🙂');
  f.observer.flush();
  f.put(db, 1, '计划🙂：继续检查🚀');
  await observed;
  f.observer.close();
  assert.deepEqual(f.snapshots.map(s => s.text), ['', '计划🙂', '计划🙂：继续检查🚀']);
  assert.deepEqual(f.snapshots.at(-1), {
    conversationId: A, stepId: 1, text: '计划🙂：继续检查🚀', status: GENERATING,
  });
  assert.deepEqual(f.diagnostics, []);
});

test('does not advance past an unconsumed earlier step, but still reports all later rows', t => {
  clock(t);
  let sealFirst = false;
  const f = fixture(t, { consume: s => s.stepId !== 1 || sealFirst });
  const db = f.create();
  f.put(db, 2, 'later', DONE);
  f.put(db, 1, 'active');
  f.put(db, 3, 'not a response', DONE, 14);
  f.observer.prepare();
  f.observer.bind(A);
  f.put(db, 1, 'active updated');
  f.observer.flush();
  assert.deepEqual(f.snapshots.map(s => [s.stepId, s.text]), [
    [1, 'active'], [2, 'later'], [1, 'active updated'], [2, 'later'],
  ]);
  sealFirst = true;
  f.observer.flush();
  const count = f.snapshots.length;
  f.observer.flush();
  f.observer.bind(A);
  assert.equal(f.snapshots.length, count);
});

test('existing conversation baseline excludes all historical steps and repeated bind preserves progress', t => {
  clock(t);
  const f = fixture(t, { consume: () => true });
  const db = f.create();
  f.put(db, 1, 'old', DONE);
  f.put(db, 5, 'old user', DONE, 14);
  f.observer.prepare(A);
  f.put(db, 6, 'new', DONE);
  f.observer.bind(A);
  f.observer.bind(A);
  assert.deepEqual(f.snapshots.map(s => s.stepId), [6]);
  f.observer.prepare(A);
  f.observer.bind(A);
  assert.equal(f.snapshots.length, 1);
  f.put(db, 7, 'next logical turn', DONE);
  f.observer.flush();
  assert.deepEqual(f.snapshots.map(s => s.stepId), [6, 7]);
});

test('failed baseline disables only that ID for the entire turn, even if its DB later appears', t => {
  const timers = clock(t);
  const f = fixture(t, { consume: () => true });
  f.observer.prepare(A);
  assert.equal(f.diagnostics.length, 1);
  const a = f.create(A);
  f.put(a, 1, 'must not replay', DONE);
  f.observer.bind(A);
  f.observer.flush();
  assert.equal(f.snapshots.length, 0);
  assert.equal(timers.size, 0);
  const b = f.create(B);
  f.put(b, 2, 'new ID', DONE);
  f.observer.bind(B);
  assert.deepEqual(f.snapshots.map(s => s.conversationId), [B]);
  f.observer.bind(A);
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.diagnostics.length, 1);
  assert.equal(timers.size, 0);
  f.observer.prepare(A);
  f.put(a, 2, 'new turn after recovery', DONE);
  f.observer.bind(A);
  assert.deepEqual(f.snapshots.map(s => s.text), ['new ID', 'new turn after recovery']);
});

test('new bind includes steps already persisted before init and waits quietly for a missing new DB', t => {
  clock(t);
  const f = fixture(t, { consume: () => true });
  f.observer.prepare();
  f.observer.bind(A);
  f.observer.flush();
  assert.deepEqual(f.diagnostics, []);
  const a = f.create(A);
  f.put(a, 0, 'already persisted', DONE);
  f.observer.bind(A);
  const b = f.create(B);
  f.put(b, 0, 'other conversation', DONE);
  f.observer.bind(B);
  assert.deepEqual(f.snapshots.map(s => [s.conversationId, s.text]), [
    [A, 'already persisted'], [B, 'other conversation'],
  ]);
});

test('decodes an entire read before delivery and retries malformed rows without skipping them', t => {
  clock(t);
  const f = fixture(t, { consume: () => true });
  const db = f.create();
  f.put(db, 1, 'first', DONE);
  db.prepare('INSERT INTO steps VALUES (2, 15, 8, ?)').run(Uint8Array.of(0xa2, 1, 9));
  f.put(db, 3, 'third', DONE);
  f.observer.prepare();
  f.observer.bind(A);
  f.observer.flush();
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.diagnostics.length, 1);
  f.put(db, 2, 'repaired', DONE);
  f.observer.flush();
  assert.deepEqual(f.snapshots.map(s => s.text), ['first', 'repaired', 'third']);
});

test('read lock failures do not wait, repeat diagnostics only on fault transitions, and recover', t => {
  clock(t);
  const f = fixture(t, { consume: () => false });
  const db = f.create();
  f.put(db, 1, 'visible');
  f.observer.prepare();
  db.exec('BEGIN EXCLUSIVE');
  try {
    const start = performance.now();
    f.observer.bind(A);
    f.observer.flush();
    assert.ok(performance.now() - start < 250, 'timeout: 0 must not stall on a writer lock');
    assert.equal(f.diagnostics.length, 1);
    assert.equal(f.snapshots.length, 0);
  } finally {
    db.exec('ROLLBACK');
  }
  f.observer.flush();
  assert.equal(f.snapshots.at(-1).text, 'visible');
  db.exec('BEGIN EXCLUSIVE');
  try {
    f.observer.flush();
    assert.equal(f.diagnostics.length, 2);
  } finally {
    db.exec('ROLLBACK');
  }
});

test('locked baseline never falls back to replaying history', t => {
  const timers = clock(t);
  const f = fixture(t);
  const db = f.create();
  f.put(db, 1, 'history');
  db.exec('BEGIN EXCLUSIVE');
  try { f.observer.prepare(A); } finally { db.exec('ROLLBACK'); }
  f.observer.bind(A);
  f.observer.flush();
  assert.equal(f.diagnostics.length, 1);
  assert.equal(f.snapshots.length, 0);
  assert.equal(timers.size, 0);
});

test('opens only read-only handles, leaves DB bytes unchanged, and releases timers and handles idempotently', t => {
  const timers = clock(t);
  const f = fixture(t, { consume: () => false });
  const db = f.create();
  f.put(db, 1, 'read me');
  const file = path.join(f.directory, `${A}.db`);
  const digest = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = digest();
  const filesBefore = fs.readdirSync(f.directory);
  const handles = new Set();
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (...args) {
    if (this !== db) handles.add(this);
    return prepare.apply(this, args);
  });
  f.observer.prepare(A);
  f.observer.bind(A);
  assert.equal(timers.size, 1);
  const [[id, timer]] = timers;
  assert.equal(timer.ms, 200);
  timers.delete(id);
  timer.fn();
  assert.equal(timers.size, 1, 'recursive timer leaves only one pending tick');
  f.observer.bind(A);
  assert.equal(timers.size, 1);
  assert.equal(handles.size, 2, 'baseline handle and lazy observation handle');
  const [baseline, active] = [...handles];
  assert.throws(() => baseline.prepare('SELECT 1'), /not open/i);
  assert.throws(() => active.exec('CREATE TABLE forbidden (id INTEGER)'), /readonly|read.only/i);
  f.observer.close();
  f.observer.close();
  f.observer.flush();
  f.observer.bind(A);
  assert.equal(timers.size, 0);
  assert.throws(() => active.prepare('SELECT 1'), /not open/i);
  assert.equal(digest(), before);
  assert.deepEqual(fs.readdirSync(f.directory), filesBefore);
});
