import { afterEach, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

let restoreFixture;
afterEach(() => { restoreFixture?.(); restoreFixture = undefined; });

// Production modules are imported by each test. Only timers/host effects are fake.
export function fixture(extra = {}) {
  restoreFixture?.();
  let now = 1_000;
  let seq = 0;
  const timers = new Map();
  const children = new Map();
  const kills = [];
  const hooks = new Map();
  const mocked = extra.clock === false ? [] : [
    mock.method(Date, 'now', () => now),
    mock.method(globalThis, 'setTimeout', (fn, ms) => {
      const id = { value: ++seq, unref() { return this; }, ref() { return this; } };
      timers.set(id, { at: now + ms, fn });
      return id;
    }),
    mock.method(globalThis, 'clearTimeout', id => timers.delete(id)),
  ];
  const envKeys = ['AGY_TURN_TIMEOUT_MS', 'AGY_STALL_TIMEOUT_MS',
    'AGY_TOOL_STALL_TIMEOUT_MS', 'AGY_STALL_RETRY_BACKOFF_MS'];
  const priorEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  restoreFixture = () => {
    for (const fn of mocked) fn.mock.restore();
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const childrenHost = {
    registryScope: {},
    process: {
      platform: 'win32',
      on: (event, fn) => hooks.set(event, fn),
      kill: () => { throw new Error('Real process.kill forbidden in offline tests'); },
    },
    spawnSync: (_cmd, args) => {
      const pid = Number(args.at(-1));
      kills.push(pid);
      const child = children.get(pid);
      if (child) { child.exitCode = 1; child.emit('close', 1, null); }
    },
  };
  const executionDependencies = {
    childrenHost,
    spawn: () => { throw new Error('Real spawn forbidden in offline tests'); },
    captureNativeTurnBoundary: () => null,
    reconcileNativeTerminal: result => ({ result, correction: null }),
    ...Object.fromEntries(['spawn', 'upgradeNativeConversationDb', 'captureNativeTurnBoundary',
      'reconcileNativeTerminal'].filter(key => key in extra).map(key => [key, extra[key]])),
  };
  const providerOptions = {
    dependencies: Object.fromEntries([
      'latestUserPrompt', 'piHistoryBootstrap', 'normalizeContext', 'getCurrentSystemPrompt',
      'getCurrentTools', 'resolveBridgeResultsFromContext', 'resolveAgyModelEffort', 'calculateCost',
      'createAssistantMessageEventStream', 'readNativeToolResult',
    ].filter(key => key in extra).map(key => [key, extra[key]])),
    ...(extra.readAgyProcessProfile ? { getProcessProfile: extra.readAgyProcessProfile } : {}),
    ...(extra.createAntigravityRuntime ? { createIsolatedRuntime: extra.createAntigravityRuntime } : {}),
  };
  return {
    childrenHost, executionDependencies, providerOptions, env: process.env, kills, hooks, timers,
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    child(pid) {
      const child = new EventEmitter();
      Object.assign(child, { pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
      child.stdin.on('finish', () => { child.exitCode = 0; child.emit('close', 0, null); });
      child.send = event => child.stdout.write(`${JSON.stringify(event)}\n`);
      children.set(pid, child);
      return child;
    },
  };
}

export const flush = () => new Promise(resolve => setImmediate(resolve));
export function memoryStream() {
  const events = [];
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  return { events, ended, push: event => events.push(event), end: () => finish() };
}
