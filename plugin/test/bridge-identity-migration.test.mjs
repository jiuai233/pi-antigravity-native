import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AgyPiBridge } from "../src/extension/bridge.ts";
import { ToolProjection } from "../src/extension/tool-projection.ts";
import { NativeWorkspaceRegistration } from "../src/native/native-workspace.ts";
import { stableBridgeIdentity } from "../src/native/bridge-identity.ts";
import { upgradeNativeConversationDb } from "../src/native/native-results.ts";
import { createAntigravityRuntime } from "../src/runtime/runtime.ts";
import { AgyDriverSession } from "../src/driver/agy-driver.ts";
import { fixture, flush } from "./offline-fixture.mjs";

function seed(dbPath, historicalStep) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB);"
    + "CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY, data BLOB);"
    + "CREATE TABLE trajectory_metadata_blob(id TEXT PRIMARY KEY, data BLOB);"
    + "CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);");
  const spec = Buffer.from([0x1a, 0x0d, 0x0a, 0x09, ...Buffer.from("view_file"), 0x10, 0x01]);
  const field46 = Buffer.concat([Buffer.from([0xf2, 0x02, spec.length]), spec]);
  const field1 = Buffer.concat([Buffer.from([0x0a, field46.length]), field46]);
  const ckpt = Buffer.from([0x28, 0x80, 0xd0, 0x0f]);
  const cascade = Buffer.concat([field1, Buffer.from([0x12, ckpt.length]), ckpt]);
  const exec = Buffer.concat([Buffer.from([0x52, cascade.length]), cascade]);
  const inner = Buffer.concat([Buffer.from([0x0a, spec.length]), spec]);
  const field18 = Buffer.concat([Buffer.from([0x92, 0x01, inner.length]), inner]);
  const field7 = Buffer.concat([Buffer.from([0x3a, field18.length]), field18]);
  const blob = Buffer.concat([Buffer.from([0x22, field7.length]), field7, Buffer.from([0x52, field18.length]), field18]);
  db.prepare("INSERT INTO executor_metadata VALUES(0,?)").run(exec);
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES('main',?)").run(blob);
  db.prepare("INSERT INTO gen_metadata VALUES(0,?)").run(Buffer.concat([Buffer.from([0x1a, field46.length]), field46]));
  db.prepare("INSERT INTO steps VALUES(0,14,3,NULL,?)").run(historicalStep);
  db.close();
}

test("restored random bridge migrates all native prompt records before spawn without replacing conversation or rewriting historical calls", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-identity-migration-"));
  const dataDirectory = path.join(root, "native-data");
  const prior = process.env.JETSKI_APP_DATA_DIR;
  process.env.JETSKI_APP_DATA_DIR = dataDirectory;
  const paths = { agentDir: path.join(root, "pi"), agentRoot: path.join(root, "agents"), dataDirectory };
  const old = new NativeWorkspaceRegistration({ ...paths, cwd: root, id: "p41001-aaaaaaaaaaaa" });
  const current = new NativeWorkspaceRegistration({ ...paths, cwd: root, id: "p41002-bbbbbbbbbbbb",
    serverName: stableBridgeIdentity(paths.agentDir, root, "persisted-pi-session").serverName });
  const tools = [{ name: "read", description: "Read.", parameters: { type: "object", properties: { path: { type: "string" } } } }];
  const project = workspace => new ToolProjection({ bridge: new AgyPiBridge(workspace.serverName), skills: () => [] })
    .prepare(workspace, "System.", tools);
  const previous = project(old), next = project(current);
  const id = "11111111-2222-4333-8444-555555555555", dbPath = path.join(dataDirectory, "conversations", id + ".db");
  const historicalStep = Buffer.from(JSON.stringify({ oldServer: old.serverName, oldSchema: old.schemaDirectory, result: "HISTORY_PRESERVED" }));
  seed(dbPath, historicalStep);
  assert.equal(upgradeNativeConversationDb(id, root, previous.nativeTools, previous.agentBody).status, "migrated");
  assert.equal(previous.nativeContractHash, next.nativeContractHash);
  assert.notEqual(previous.agentBody, next.agentBody);
  const f = fixture({ clock: false });
  const requests = [], spawned = [];
  f.executionDependencies.spawn = (_binary, args) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const table of ["executor_metadata", "trajectory_metadata_blob", "gen_metadata"]) {
        const bytes = Buffer.from(db.prepare("SELECT data FROM " + table).get().data);
        assert.ok(bytes.includes(Buffer.from(current.serverName)), table + " must contain stable routing before spawn");
        assert.ok(!bytes.includes(Buffer.from(old.serverName)), table + " must no longer contain the random routing hint");
      }
      assert.deepEqual(Buffer.from(db.prepare("SELECT step_payload FROM steps").get().step_payload), historicalStep);
    } finally { db.close(); }
    const child = f.child(930001 + spawned.length);
    spawned.push({ child, args });
    return child;
  };
  const driver = new AgyDriverSession(f.executionDependencies);
  const runtime = createAntigravityRuntime({ run(request) { requests.push(request); return driver.run({ ...request, binary: "OFFLINE_NEVER_SPAWN" }); },
    snapshot: () => driver.snapshot(), close: (...args) => driver.close(...args) }, undefined, f.childrenHost);
  try {
    await runtime.setSession(root, "identity-fixture", false);
    await runtime.restoreConversation({ conversationId: id, modelId: "identity-fixture", cwd: root, turns: 4, usage: {},
      systemPromptHash: "unchanged-system", nativeContractHash: previous.nativeContractHash });
    const turn = await runtime.beginStreamTurn({ prompt: "Continue.", modelId: "identity-fixture",
      systemPromptHash: "unchanged-system", nativeContractHash: next.nativeContractHash,
      agent: next.name, agentBody: next.agentBody, nativeTools: next.nativeTools, bridgeBootstrap: current.routingHint });
    await flush();
    assert.equal(spawned.length, 1);
    assert.equal(requests[0].conversationId, id);
    assert.ok(requests[0].prompt.startsWith(current.routingHint));
    assert.doesNotMatch(requests[0].prompt, new RegExp(old.serverName));
    assert.equal(spawned[0].args[spawned[0].args.indexOf("--conversation") + 1], id);
    spawned[0].child.send({ event: "init", conversation_id: id });
    spawned[0].child.send({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: "CONTINUED" } });
    for (;;) { const event = await turn.next(); if (!event || event.type === "result") break; }
    assert.equal(runtime.snapshot().conversationId, id);
    t.diagnostic(JSON.stringify({ nativeMetadataTablesAlignedBeforeSpawn: 3, conversationPreserved: true,
      historicalStepByteEqual: true, restoredRoutingHintCurrent: true, realNativeProcesses: 0, externalModelCalls: 0 }));
  } finally {
    await runtime.close(); old.dispose(); current.dispose();
    if (prior === undefined) delete process.env.JETSKI_APP_DATA_DIR; else process.env.JETSKI_APP_DATA_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
