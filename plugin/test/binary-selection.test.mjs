import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import extension from '../index.ts';

const patchedBinary = path.join(os.homedir(), '.gemini', 'bin', 'agy-512k');
const keepaliveBinary = path.join(os.homedir(), '.gemini', 'bin', 'agy-512k-keepalive');

function configure(t, { platform, exists, keepalive = false, binary, autoUpdate }) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const keys = ['AGY_BINARY', 'AGY_CLI_DISABLE_AUTO_UPDATE', 'PI_CODING_AGENT_DIR'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-binary-selection-'));
  process.env.PI_CODING_AGENT_DIR = root;
  for (const [key, value] of [['AGY_BINARY', binary], ['AGY_CLI_DISABLE_AUTO_UPDATE', autoUpdate]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  const originalExists = fs.existsSync;
  const mocked = mock.method(fs, 'existsSync', file => file === patchedBinary ? exists : file === keepaliveBinary ? keepalive : originalExists(file));
  t.after(() => {
    mocked.mock.restore();
    Object.defineProperty(process, 'platform', descriptor);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  extension(new Proxy({}, { get: () => () => {} }));
}

test('macOS selects an existing 512K binary and disables its automatic update', t => {
  configure(t, { platform: 'darwin', exists: true });
  assert.equal(process.env.AGY_BINARY, patchedBinary);
  assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
});

test('macOS prefers an installed keepalive copy when no binary is explicitly selected', t => {
  configure(t, { platform: 'darwin', exists: true, keepalive: true });
  assert.equal(process.env.AGY_BINARY, keepaliveBinary);
  assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
});

test('an explicit 512K binary opts out of automatic keepalive selection', t => {
  configure(t, { platform: 'darwin', exists: true, keepalive: true, binary: patchedBinary });
  assert.equal(process.env.AGY_BINARY, patchedBinary);
});

test('macOS without a patched binary keeps standard binary discovery', t => {
  configure(t, { platform: 'darwin', exists: false });
  assert.equal(process.env.AGY_BINARY, undefined);
  assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, undefined);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform} keeps standard binary discovery even if the Mac path exists`, t => {
    configure(t, { platform, exists: true });
    assert.equal(process.env.AGY_BINARY, undefined);
    assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, undefined);
  });
}

test('an explicit binary and automatic-update setting take priority', t => {
  configure(t, { platform: 'darwin', exists: true, binary: '/custom/agy', autoUpdate: 'false' });
  assert.equal(process.env.AGY_BINARY, '/custom/agy');
  assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'false');
});

test('automatic Mac selection preserves an explicit automatic-update setting', t => {
  configure(t, { platform: 'darwin', exists: true, autoUpdate: 'false' });
  assert.equal(process.env.AGY_BINARY, patchedBinary);
  assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'false');
});
