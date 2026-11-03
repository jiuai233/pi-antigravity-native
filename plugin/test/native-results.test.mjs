import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import test from 'node:test';
import {
  decodeNativeToolResult,
  readNativeToolResult,
  upgradeNativeConversationDb,
} from '../src/native/native-results.ts';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/native-view-file-1.4.4.json', import.meta.url), 'utf8'));
const payload = Buffer.from(fixture.payloadBase64, 'base64');

test('captured CLI 1.4.4 native record restores bounds and original file output', () => {
  const result = decodeNativeToolResult(payload);
  assert.equal(result.args.StartLine, '260');
  assert.equal(result.args.EndLine, '265');
  assert.equal(result.args.toolAction, undefined);
  assert.equal(result.args.toolSummary, undefined);
  assert.match(result.output, /Showing lines 260 to 265/);
  assert.match(result.output, /260: AGY_RANGE_260=/);
  assert.doesNotMatch(result.output, /fixture line 1\n/);
});

test('native record lookup reads the exact persisted step from the session data directory', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-record-'));
  const original = process.env.JETSKI_APP_DATA_DIR;
  process.env.JETSKI_APP_DATA_DIR = 'cli-data';
  try {
    const directory = path.join(cwd, 'cli-data', 'conversations');
    fs.mkdirSync(directory, { recursive: true });
    const database = new DatabaseSync(path.join(directory, 'fixture.db'));
    database.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)');
    database.prepare('INSERT INTO steps VALUES (?, ?)').run(2, payload);
    database.close();
    assert.deepEqual(readNativeToolResult('fixture', 2, cwd), decodeNativeToolResult(payload));
    assert.throws(() => readNativeToolResult('fixture', 99, cwd), /not persisted/);
  } finally {
    if (original === undefined) delete process.env.JETSKI_APP_DATA_DIR;
    else process.env.JETSKI_APP_DATA_DIR = original;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('native image replay uses every persisted attachment even after the original source is gone', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-images-'));
  const original = process.env.JETSKI_APP_DATA_DIR;
  process.env.JETSKI_APP_DATA_DIR = 'cli-data';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
  try {
    const source = path.join(cwd, 'original.png');
    fs.writeFileSync(source, png);
    const response = new BinaryWriter().tag(1, WireType.LengthDelimited).string('Recorded native image result');
    for (const name of ['native-1.png', 'native-2.png']) {
      const file = path.join(cwd, name);
      fs.writeFileSync(file, png);
      const media = new BinaryWriter().tag(1, WireType.LengthDelimited).string('image/png')
        .tag(5, WireType.LengthDelimited).string(pathToFileURL(file).href).finish();
      response.tag(4, WireType.LengthDelimited).bytes(media);
    }
    const parameter = new BinaryWriter().tag(1, WireType.LengthDelimited).string('AbsolutePath')
      .tag(2, WireType.LengthDelimited).string(source).finish();
    const tool = new BinaryWriter().tag(1, WireType.LengthDelimited).bytes(parameter)
      .tag(2, WireType.LengthDelimited).bytes(response.finish()).finish();
    const bytes = new BinaryWriter().tag(140, WireType.LengthDelimited).bytes(tool).finish();
    const directory = path.join(cwd, 'cli-data', 'conversations');
    fs.mkdirSync(directory, { recursive: true });
    const db = new DatabaseSync(path.join(directory, 'images.db'));
    try {
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)');
      db.prepare('INSERT INTO steps VALUES (?, ?)').run(3, bytes);
    } finally { db.close(); }
    fs.unlinkSync(source);
    const result = readNativeToolResult('images', 3, cwd);
    assert.equal(result.output, 'Recorded native image result');
    assert.equal(result.content[0].text, result.output);
    const images = result.content.filter(part => part.type === 'image');
    assert.equal(images.length, 2);
    for (const image of images) {
      assert.equal(image.mimeType, 'image/png');
      assert.deepEqual(Buffer.from(image.data, 'base64'), png);
    }
  } finally {
    if (original === undefined) delete process.env.JETSKI_APP_DATA_DIR;
    else process.env.JETSKI_APP_DATA_DIR = original;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function legacyFixture(run) {
  const root = path.join(os.tmpdir(), 'agy-resume-migration-tests');
  fs.mkdirSync(root, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, 'case-'));
  const original = process.env.JETSKI_APP_DATA_DIR;
  process.env.JETSKI_APP_DATA_DIR = 'cli-data';
  try {
    const directory = path.join(cwd, 'cli-data', 'conversations');
    fs.mkdirSync(directory, { recursive: true });
    const dbPath = path.join(directory, 'legacy.db');
    const database = new DatabaseSync(dbPath);
    database.exec(`
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

    database.prepare('INSERT INTO executor_metadata VALUES (?, ?)').run(0, execMeta);
    database.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', trajBlob);
    database.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, genMeta);
    try { run({ cwd, database, originals: [execMeta, trajBlob, genMeta] }); }
    finally { database.close(); }
  } finally {
    if (original === undefined) delete process.env.JETSKI_APP_DATA_DIR;
    else process.env.JETSKI_APP_DATA_DIR = original;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function storedMetadata(database) {
  return ['executor_metadata', 'trajectory_metadata_blob', 'gen_metadata']
    .map(table => Buffer.from(database.prepare(`SELECT data FROM ${table}`).get().data));
}

test('legacy migration adds tools and 512k atomically and is idempotent', () => legacyFixture(({ cwd, database }) => {
  assert.deepEqual(upgradeNativeConversationDb('legacy', cwd), { status: 'migrated' });
  assert.deepEqual(upgradeNativeConversationDb('legacy', cwd), { status: 'unchanged' });
  const [exec, blob, gen] = storedMetadata(database);
  for (const bytes of [exec, blob, gen]) assert.ok(bytes.includes(Buffer.from('generate_image')));
  assert.ok(exec.includes(Buffer.from([0x28, 0x80, 0xa0, 0x1f])));
}));

for (const scenario of ['locked', 'interrupted']) {
  test(`legacy migration ${scenario} reports failure, preserves all metadata and can retry`, () => legacyFixture(({ cwd, database, originals }) => {
    if (scenario === 'locked') database.exec('BEGIN EXCLUSIVE');
    else database.exec("CREATE TRIGGER fail_blob BEFORE UPDATE ON trajectory_metadata_blob BEGIN SELECT RAISE(ABORT, 'fixture write interruption'); END");
    const result = upgradeNativeConversationDb('legacy', cwd);
    if (scenario === 'locked') database.exec('ROLLBACK');
    assert.equal(result.status, 'failed');
    assert.match(result.message, scenario === 'locked' ? /locked/i : /fixture write interruption/);
    assert.deepEqual(storedMetadata(database), originals, 'no table may retain a partial upgrade');
    if (scenario === 'interrupted') database.exec('DROP TRIGGER fail_blob');
    assert.deepEqual(upgradeNativeConversationDb('legacy', cwd), { status: 'migrated' });
  }));
}

test('closed migration removes native whitelist entries from all restore records; reopening restores builtin entries', () => legacyFixture(({ cwd, database }) => {
  assert.equal(upgradeNativeConversationDb('legacy', cwd).status, 'migrated');
  const gen = database.prepare('SELECT data FROM gen_metadata WHERE idx=0').get().data;
  for (let i = 1; i < 6; i++) database.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(i, gen);
  // The first live resume exposed that field 2 is builtin, not enabled.
  // Repair even those malformed false-builtin native entries by removing membership.
  for (const table of ['executor_metadata', 'trajectory_metadata_blob', 'gen_metadata']) {
    for (const row of database.prepare(`SELECT rowid AS rid, data FROM ${table}`).all()) {
      const bytes = Buffer.from(row.data);
      for (const name of ['view_file', 'generate_image']) {
        const pattern = Buffer.concat([Buffer.from(name), Buffer.from([0x10, 0x01])]);
        for (let index = bytes.indexOf(pattern); index !== -1; index = bytes.indexOf(pattern, index + pattern.length)) {
          bytes[index + pattern.length - 1] = 0;
        }
      }
      database.prepare(`UPDATE ${table} SET data=? WHERE rowid=?`).run(bytes, row.rid);
    }
  }
  assert.equal(upgradeNativeConversationDb('legacy', cwd, []).status, 'migrated');
  assert.equal(upgradeNativeConversationDb('legacy', cwd, []).status, 'unchanged');
  const bytes = [...storedMetadata(database), ...database.prepare('SELECT data FROM gen_metadata').all().map(row => Buffer.from(row.data))];
  for (const record of bytes) for (const name of ['view_file', 'generate_image']) {
    assert.ok(!record.includes(Buffer.from(name)), 'closed filters must remove membership, not set builtin=false');
  }
  assert.equal(upgradeNativeConversationDb('legacy', cwd).status, 'migrated');
  for (const record of storedMetadata(database)) for (const name of ['view_file', 'generate_image']) {
    assert.ok(record.includes(Buffer.concat([Buffer.from(name), Buffer.from([0x10, 0x01])])));
  }
}));

test('a missing conversation is unchanged and is not created', () => legacyFixture(({ cwd }) => {
  assert.deepEqual(upgradeNativeConversationDb('absent', cwd), { status: 'unchanged' });
  assert.equal(fs.existsSync(path.join(cwd, 'cli-data/conversations/absent.db')), false);
}));
