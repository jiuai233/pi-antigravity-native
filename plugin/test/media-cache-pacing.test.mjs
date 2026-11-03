import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  MEDIA_CACHE_MIN_BYTES,
  MEDIA_CACHE_SETTLE_MS,
  runPreInvocationCacheHook,
} from "../src/native/native-cache-hook.mjs";
import { executionSurface } from "../src/native/native-profile.ts";
import { NativeWorkspaceRegistration } from "../src/native/native-workspace.ts";

function encodeVarint(value) {
  let v = BigInt(value);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeTimestampField(fieldNumber, timestampMs) {
  const seconds = BigInt(Math.floor(timestampMs / 1000));
  const nanos = BigInt((timestampMs % 1000) * 1_000_000);
  const body = Buffer.concat([
    encodeVarint((1n << 3n) | 0n),
    encodeVarint(seconds),
    encodeVarint((2n << 3n) | 0n),
    encodeVarint(nanos),
  ]);
  return Buffer.concat([
    encodeVarint((BigInt(fieldNumber) << 3n) | 2n),
    encodeVarint(body.length),
    body,
  ]);
}

function createConversationFixture(root, conversationId, steps, transcriptLines) {
  const convDir = path.join(root, "conversations");
  const logsDir = path.join(root, "brain", conversationId, ".system_generated", "logs");
  fs.mkdirSync(convDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const dbPath = path.join(convDir, `${conversationId}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB)");
  const insert = db.prepare("INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)");
  for (const s of steps) {
    insert.run(s.idx, s.stepType, s.status, s.metadata ?? null);
  }
  db.close();
  const transcriptPath = path.join(logsDir, "transcript_full.jsonl");
  fs.writeFileSync(transcriptPath, `${transcriptLines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return { dbPath, transcriptPath };
}

test("default workspace registration installs single PreInvocation hook and cleans up on dispose", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cache-ws-"));
  try {
    const ws = new NativeWorkspaceRegistration({
      cwd: root,
      id: "pacing-12345678",
      agentDir: path.join(root, "pi"),
      agentRoot: path.join(root, "agents"),
      dataDirectory: path.join(root, "cli"),
    });
    ws.writeSystemPrompt("System prompt.", [], executionSurface.profiles.default);
    const agentMd = fs.readFileSync(ws.agentPath, "utf8");
    assert.match(agentMd, /^hooks: \[hooks\.json\]$/m);
    assert.equal(fs.existsSync(ws.cacheHooksPath), true);
    assert.equal(fs.existsSync(ws.cacheHookScriptPath), true);

    const hooks = JSON.parse(fs.readFileSync(ws.cacheHooksPath, "utf8"));
    const spec = hooks[ws.cacheHookName];
    assert.ok(spec);
    assert.equal(spec.PostInvocation, undefined);
    assert.deepEqual(spec.PreInvocation, [
      { type: "command", command: "node --no-warnings ./native-cache-hook.mjs", timeout: 30 },
    ]);

    ws.writeSystemPrompt("Closed prompt.", [], executionSurface.profiles.evidence_only_v1);
    assert.doesNotMatch(fs.readFileSync(ws.agentPath, "utf8"), /^hooks:/m);
    assert.equal(fs.existsSync(ws.cacheHooksPath), false);
    assert.equal(fs.existsSync(ws.cacheHookScriptPath), false);

    ws.writeSystemPrompt("System prompt again.", [], executionSurface.profiles.default);
    assert.equal(fs.existsSync(ws.cacheHooksPath), true);
    ws.dispose();
    assert.equal(fs.existsSync(ws.agentPath), false);
    assert.equal(fs.existsSync(ws.cacheHooksPath), false);
    assert.equal(fs.existsSync(ws.cacheHookScriptPath), false);
    assert.equal(fs.existsSync(ws.agentDirectory), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PreInvocation pacing waits only the remaining net gap from finished_generating_at when retained media >= 10 MB", async () => {
  assert.equal(MEDIA_CACHE_SETTLE_MS, 15_000);
  assert.equal(MEDIA_CACHE_MIN_BYTES, 10_000_000);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cache-hook-"));
  try {
    const cid = "c4d14630-fixture";
    const mediaFile = path.join(root, "video.mp4");
    fs.writeFileSync(mediaFile, Buffer.alloc(12_000_000, 0xaa));

    const finishMs = 1_793_613_754_096;
    const { transcriptPath } = createConversationFixture(
      root,
      cid,
      [
        { idx: 1, stepType: 15, status: 3, metadata: encodeTimestampField(7, finishMs - 60_000) },
        { idx: 2, stepType: 132, status: 3 },
        { idx: 3, stepType: 15, status: 3, metadata: encodeTimestampField(7, finishMs) },
        { idx: 4, stepType: 132, status: 3 },
      ],
      [
        { step_index: 2, type: "GENERIC", status: "DONE", media: [{ mime_type: "video/mp4", uri: mediaFile }] },
        { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE" },
        { step_index: 4, type: "GENERIC", status: "DONE" },
      ],
    );

    const waits = [];
    // 500ms net gap after step 3 finished generating -> should wait 14,500ms.
    const paced = await runPreInvocationCacheHook(
      { conversationId: cid, transcriptPath, initialNumSteps: 5, invocationNum: 2, workspacePaths: [root] },
      { now: () => finishMs + 500, wait: async (ms) => { waits.push(ms); } },
    );
    assert.equal(paced.waitedMs, 14_500);
    assert.equal(paced.reason, "paced-large-media-gap");
    assert.deepEqual(waits, [14_500]);

    // Tool took 18,000ms (>= 15,000ms) -> 0ms wait.
    const alreadySatisfied = await runPreInvocationCacheHook(
      { conversationId: cid, transcriptPath, initialNumSteps: 5, invocationNum: 2, workspacePaths: [root] },
      { now: () => finishMs + 18_000, wait: async (ms) => { waits.push(ms); } },
    );
    assert.equal(alreadySatisfied.waitedMs, 0);
    assert.equal(alreadySatisfied.reason, "gap-already-satisfied");
    assert.deepEqual(waits, [14_500]);

    // If media was only read at step 4 (after last completed model step 3), prior model step had 0 media -> 0ms wait.
    const beforeMediaModel = await runPreInvocationCacheHook(
      { conversationId: cid, transcriptPath, initialNumSteps: 3, invocationNum: 1, workspacePaths: [root] },
      { now: () => finishMs - 59_500, wait: async (ms) => { waits.push(ms); } },
    );
    assert.equal(beforeMediaModel.waitedMs, 0);
    assert.equal(beforeMediaModel.reason, "below-media-threshold");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
