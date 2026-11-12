import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AgyPiBridge, canonicalToolDefinitions } from "../src/extension/bridge.ts";
import { ToolProjection } from "../src/extension/tool-projection.ts";
import { activateSkillDescription, activateSkillParameters, usableSkillCatalog } from "../src/extension/skills.ts";
import { NativeWorkspaceRegistration, sweepDeadNativeWorkspaces } from "../src/native/native-workspace.ts";
import { bridgeToolName } from "../src/native/native-tool-names.ts";
import { acquireNativeBridgeLease, stableBridgeIdentity, isBridgeOwnerDead } from "../src/native/bridge-identity.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-prefix-stable-"));
  const paths = { agentDir: path.join(root, "pi"), agentRoot: path.join(root, "agents"), dataDirectory: path.join(root, "data") };
  return { root, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const toolA = { name: "z_tool", description: "Fixture Z.", parameters: {
  type: "object", properties: { z: { type: "string" }, a: { type: "object", properties: { z: { type: "integer" }, a: { type: "string" } }, required: ["z", "a"] } },
  required: ["a"], additionalProperties: false,
} };
const toolB = { name: "a_tool", description: "Fixture A.", parameters: { type: "object", properties: { code: { type: "string" } } } };
const reorderedA = { ...toolA, parameters: { additionalProperties: false, required: ["a"],
  properties: { a: { required: ["z", "a"], properties: { a: { type: "string" }, z: { type: "integer" } }, type: "object" }, z: { type: "string" } }, type: "object" } };

test("equal tool/property permutations yield identical real projection, MCP JSON and system body without mutating SDK declarations", async () => {
  const f = fixture(), workspace = new NativeWorkspaceRegistration({ ...f.paths, cwd: f.root, id: "p41001-aaaaaaaaaaaa" });
  const bridge = new AgyPiBridge(workspace.serverName);
  const projection = new ToolProjection({ bridge, skills: () => [] });
  try {
    bridge.setToolPrefix(""); await bridge.start();
    const list = async () => (await fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).text();
    const input = [toolA, toolB], before = JSON.stringify(input);
    const first = projection.prepare(workspace, "System.", input); bridge.refreshTools();
    const firstCatalog = await list(), revision = bridge.catalogRevision;
    const second = projection.prepare(workspace, "System.", [toolB, reorderedA]); bridge.refreshTools();
    assert.equal(second.agentBody, first.agentBody);
    assert.equal(second.nativeContractHash, first.nativeContractHash);
    assert.equal(await list(), firstCatalog);
    assert.equal(bridge.catalogRevision, revision);
    assert.equal(JSON.stringify(input), before);
    const changed = { ...toolA, parameters: { ...toolA.parameters, properties: { ...toolA.parameters.properties, z: { type: "number" } } } };
    const third = projection.prepare(workspace, "System.", [changed, toolB]); bridge.refreshTools();
    assert.notEqual(third.nativeContractHash, first.nativeContractHash);
    assert.notEqual(await list(), firstCatalog);
    assert.ok(bridge.catalogRevision > revision);
    const description = projection.prepare(workspace, "System.", [{ ...toolA, description: "Changed contract." }, toolB]);
    assert.notEqual(description.agentBody, first.agentBody);
  } finally { await bridge.close(); workspace.dispose(); f.cleanup(); }
});

test("canonicalization preserves tuple/enum/oneOf/required arrays and skill duplicate precedence", () => {
  const schema = { type: "array", prefixItems: [{ type: "string" }, { type: "number" }],
    enum: ["z", "a"], oneOf: [{ const: "z" }, { const: "a" }], required: ["z", "a"] };
  assert.deepEqual(canonicalToolDefinitions([{ name: "t", parameters: schema }])[0].parameters, schema);
  const a = { name: "a", description: "A", filePath: "/a", baseDir: "/" };
  const z = { name: "z", description: "Z", filePath: "/z", baseDir: "/" };
  assert.equal(activateSkillDescription([z, a]), activateSkillDescription([a, z]));
  assert.deepEqual(activateSkillParameters([z, a]), activateSkillParameters([a, z]));
  assert.equal(usableSkillCatalog([z, { ...z, filePath: "/other" }])[0].filePath, "/z");
});

test("logical identities survive bridge rebuilds and isolate session, profile and cwd", () => {
  const f = fixture();
  try {
    const logical = stableBridgeIdentity(f.paths.agentDir, f.root, "session-a");
    assert.deepEqual(stableBridgeIdentity(f.paths.agentDir, f.root, "session-a"), logical);
    for (const different of [
      stableBridgeIdentity(f.paths.agentDir, f.root, "session-b"),
      stableBridgeIdentity(f.paths.agentDir, path.join(f.root, "other"), "session-a"),
      stableBridgeIdentity(path.join(f.root, "other-profile"), f.root, "session-a"),
    ]) assert.notEqual(different.serverName, logical.serverName);
    if (process.platform === "win32") assert.deepEqual(stableBridgeIdentity(f.paths.agentDir.toUpperCase(), f.root.toUpperCase(), "session-a"), logical);
    const realParent = path.join(f.root, "profile-parent"), aliasParent = path.join(f.root, "profile-alias");
    fs.mkdirSync(realParent); fs.symlinkSync(realParent, aliasParent, "junction");
    const unborn = path.join(aliasParent, "new-profile");
    const beforeCreation = stableBridgeIdentity(unborn, f.root, "session-a");
    fs.mkdirSync(unborn);
    assert.deepEqual(stableBridgeIdentity(unborn, f.root, "session-a"), beforeCreation);
    assert.deepEqual(stableBridgeIdentity(path.join(realParent, "new-profile"), f.root, "session-a"), beforeCreation);
    const a = new NativeWorkspaceRegistration({ ...f.paths, cwd: f.root, id: "p41001-aaaaaaaaaaaa", serverName: logical.serverName });
    const b = new NativeWorkspaceRegistration({ ...f.paths, cwd: f.root, id: "p41002-bbbbbbbbbbbb", serverName: logical.serverName });
    try {
      a.writeSystemPrompt("System.", [toolA, toolB]);
      b.writeSystemPrompt("System.", [toolB, reorderedA]);
      assert.equal(a.agentBody, b.agentBody);
      assert.equal(a.schemaDirectory, b.schemaDirectory);
      assert.notEqual(a.directory, b.directory);
      assert.notEqual(a.agentPath, b.agentPath);
      assert.doesNotMatch(a.agentBody, /p4100[12]-|aaaaaaaaaaaa|bbbbbbbbbbbb/);
    } finally { a.dispose(); b.dispose(); }
  } finally { f.cleanup(); }
});

test("live/unverified/PID-reused owners cannot be stolen and stale release cannot remove a successor", () => {
  const f = fixture();
  const opts = { agentDir: f.paths.agentDir, cwd: f.root, sessionId: "session-a" };
  try {
    const old = acquireNativeBridgeLease({ ...opts, ownerId: "old", pid: 41001, isDeadPid: () => false });
    assert.throws(() => acquireNativeBridgeLease({ ...opts, ownerId: "new", pid: 41002, isDeadPid: () => false }), /live or unverified/);
    let reclaimed;
    const next = acquireNativeBridgeLease({ ...opts, ownerId: "new", pid: 41002, isDeadPid: pid => pid === 41001,
      onDeadOwner: id => { reclaimed = id; } });
    assert.equal(reclaimed, "old");
    assert.equal(old.release(), false);
    assert.throws(() => acquireNativeBridgeLease({ ...opts, ownerId: "reused-pid", pid: 41001, isDeadPid: () => false }), /live or unverified/);
    assert.equal(next.release(), true);
    assert.equal(isBridgeOwnerDead(process.pid), false);
    assert.equal(isBridgeOwnerDead(-1), false);
  } finally { f.cleanup(); }
});

function childReceipt(child) {
  return new Promise((resolve, reject) => {
    let text = "", error = "";
    child.stdout.on("data", chunk => { text += chunk; const line = text.split("\n")[0]; if (text.includes("\n")) { try { resolve(JSON.parse(line)); } catch (e) { reject(e); } } });
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("exit", code => { if (!text.includes("\n")) reject(new Error(`Child exited ${code}: ${error}`)); });
  });
}
test("real process race has one owner; killing it releases SQLite locks and permits recovery", async () => {
  const f = fixture();
  const moduleUrl = new URL("../src/native/bridge-identity.ts", import.meta.url).href;
  const source = `import { acquireNativeBridgeLease } from ${JSON.stringify(moduleUrl)};
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const opts=JSON.parse(process.argv[1]);
try {
  acquireNativeBridgeLease({...opts,ownerId:"p"+process.pid+"-aaaaaaaaaaaa"});
  const db=new DatabaseSync(path.join(opts.agentDir,"antigravity","bridge-leases.db"));
  console.log(JSON.stringify({ok:true,pid:process.pid}));
  process.stdin.on("data",()=>{db.exec("BEGIN IMMEDIATE");console.log(JSON.stringify({locked:true}));});
  setInterval(()=>{},1000);
} catch(e){console.log(JSON.stringify({ok:false,error:e.message}));}`;
  const opts = JSON.stringify({ agentDir: f.paths.agentDir, cwd: f.root, sessionId: "race-session" });
  const children = [0, 1].map(() => spawn(process.execPath, ["--input-type=module", "-e", source, opts], { stdio: ["pipe", "pipe", "pipe"] }));
  try {
    const results = await Promise.all(children.map(childReceipt));
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.match(results.find(r => !r.ok).error, /live or unverified/);
    const winner = children[results.findIndex(r => r.ok)];
    const locked = childReceipt(winner);
    winner.stdin.write("lock\n");
    assert.deepEqual(await locked, { locked: true });
    const exited = once(winner, "exit"); winner.kill(); await exited;
    let oldOwner;
    const restored = acquireNativeBridgeLease({ agentDir: f.paths.agentDir, cwd: f.root, sessionId: "race-session", ownerId: "new-after-crash",
      onDeadOwner: id => { oldOwner = id; } });
    assert.match(oldOwner, /^p\d+-aaaaaaaaaaaa$/);
    assert.equal(restored.release(), true);
  } finally {
    await Promise.all(children.map(async child => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill(); await ended; } }));
    f.cleanup();
  }
});

test("dead workspace sweep preserves a live successor's shared schema and private routing", () => {
  const f = fixture();
  const opts = { agentDir: f.paths.agentDir, cwd: f.root, sessionId: "sweep-session" };
  const old = acquireNativeBridgeLease({ ...opts, ownerId: "p41001-aaaaaaaaaaaa", pid: 41001, isDeadPid: () => true });
  const previous = new NativeWorkspaceRegistration({ ...f.paths, cwd: f.root, id: old.ownerId, serverName: old.serverName });
  let current;
  try {
    previous.registerMcpServer("http://127.0.0.1:1/mcp", "old"); previous.writeSystemPrompt("System.", []);
    current = acquireNativeBridgeLease({ ...opts, ownerId: "p41002-bbbbbbbbbbbb", pid: 41002, isDeadPid: pid => pid === 41001 });
    fs.mkdirSync(previous.schemaDirectory, { recursive: true });
    fs.writeFileSync(path.join(previous.schemaDirectory, "live.json"), "LIVE");
    const swept = sweepDeadNativeWorkspaces({ ...f.paths, cwd: f.root, isDeadPid: pid => pid === 41001 });
    assert.ok(swept.includes(old.ownerId));
    assert.equal(fs.existsSync(previous.directory), false);
    assert.equal(fs.readFileSync(path.join(previous.schemaDirectory, "live.json"), "utf8"), "LIVE");
    assert.equal(old.release(), false);
    assert.throws(() => acquireNativeBridgeLease({ ...opts, ownerId: "intruder", isDeadPid: () => false }), /live or unverified/);
  } finally { current?.release(); f.cleanup(); }
});

test("a closed host's failed lease release is recoverable by a new host after an external database lock clears", async () => {
  const { BridgeHost } = await import("../src/extension/bridge-host.ts");
  const f = fixture();
  const make = () => new BridgeHost({ pushBridgeCall: () => false, finishBridgeCall: () => {} }, () => f.root, f.paths);
  const first = make(), second = make();
  let blocker, locked = false;
  try {
    await first.ensureRegistered(undefined, f.root, "locked-session");
    blocker = new DatabaseSync(path.join(f.paths.agentDir, "antigravity", "bridge-leases.db"));
    blocker.exec("BEGIN IMMEDIATE"); locked = true;
    await assert.rejects(first.teardown(), /database is locked/);
    assert.equal(first.bridge.running, false);
    blocker.exec("ROLLBACK"); locked = false;
    await second.ensureRegistered(undefined, f.root, "locked-session");
    assert.equal(second.bridge.serverName, first.bridge.serverName);
    assert.equal(second.bridge.running, true);
    await first.teardown(); // Stale old handle must not delete the new lease.
    const intruder = make();
    await assert.rejects(intruder.ensureRegistered(undefined, f.root, "locked-session"), /live or unverified/);
  } finally {
    if (locked) blocker.exec("ROLLBACK");
    blocker?.close();
    await first.teardown(); await second.teardown(); f.cleanup();
  }
});

test("failed private-file cleanup is retried before a successor can own the same schema", async () => {
  const { BridgeHost } = await import("../src/extension/bridge-host.ts");
  const f = fixture();
  const make = () => new BridgeHost({ pushBridgeCall: () => false, finishBridgeCall: () => {} }, () => f.root, f.paths);
  const first = make(), second = make();
  let configPath;
  try {
    await first.ensureRegistered(undefined, f.root, "cleanup-fault");
    configPath = path.join(first.processProfile().mcpDirectory, ".agents", "mcp_config.json");
    fs.unlinkSync(configPath); fs.mkdirSync(configPath);
    await assert.rejects(first.teardown(), /EISDIR|illegal operation on a directory/);
    assert.equal(first.bridge.running, false);
    await assert.rejects(second.ensureRegistered(undefined, f.root, "cleanup-fault"), /EISDIR|illegal operation on a directory/);
    fs.rmdirSync(configPath);
    await second.ensureRegistered(undefined, f.root, "cleanup-fault");
    const schema = path.join(f.paths.dataDirectory, "mcp", second.bridge.serverName, "current.json");
    fs.mkdirSync(path.dirname(schema), { recursive: true }); fs.writeFileSync(schema, "NEW_OWNER");
    await first.teardown();
    assert.equal(fs.readFileSync(schema, "utf8"), "NEW_OWNER");
    assert.equal(second.bridge.running, true);
  } finally {
    if (configPath && fs.existsSync(configPath) && fs.statSync(configPath).isDirectory()) fs.rmdirSync(configPath);
    await first.teardown(); await second.teardown(); f.cleanup();
  }
});

test("injected setup failure under database contention retires only a transport that never started", async () => {
  const { BridgeHost } = await import("../src/extension/bridge-host.ts");
  const f = fixture();
  const make = () => new BridgeHost({ pushBridgeCall: () => false, finishBridgeCall: () => {} }, () => f.root, f.paths);
  const failed = make(), recovered = make(), running = make(), contender = make();
  let blocker, locked = false;
  const originalSetName = failed.bridge.setServerName.bind(failed.bridge);
  failed.bridge.setServerName = () => {
    blocker = new DatabaseSync(path.join(f.paths.agentDir, "antigravity", "bridge-leases.db"));
    blocker.exec("BEGIN IMMEDIATE"); locked = true;
    throw new Error("INJECTED_SETUP_FAILURE");
  };
  try {
    await assert.rejects(failed.ensureRegistered(undefined, f.root, "setup-fault"), /database is locked/);
    assert.equal(failed.bridge.running, false);
    blocker.exec("ROLLBACK"); locked = false;
    await recovered.ensureRegistered(undefined, f.root, "setup-fault");
    await failed.teardown();
    assert.equal(recovered.bridge.running, true);
    await running.bridge.start();
    await assert.rejects(running.ensureRegistered(undefined, f.root, "active-transport"), /Cannot rebind a running/);
    assert.equal(running.bridge.running, true);
    await assert.rejects(contender.ensureRegistered(undefined, f.root, "active-transport"), /live or unverified/);
    await running.teardown();
    await contender.ensureRegistered(undefined, f.root, "active-transport");
  } finally {
    failed.bridge.setServerName = originalSetName;
    if (locked) blocker.exec("ROLLBACK");
    blocker?.close();
    await failed.teardown(); await recovered.teardown(); await running.teardown(); await contender.teardown(); f.cleanup();
  }
});

test("real BridgeHost teardown/reload keeps model body stable while transport, token and cross-session routing stay isolated", async () => {
  const { BridgeHost } = await import("../src/extension/bridge-host.ts");
  const { registerSessionHooks } = await import("../src/extension/session-hooks.ts");
  const f = fixture();
  const make = () => new BridgeHost({ pushBridgeCall: () => false, finishBridgeCall: () => {} }, () => f.root, f.paths);
  const first = make(), successor = make(), other = make();
  const ui = { notify() {} };
  const config = host => {
    const value = JSON.parse(fs.readFileSync(path.join(host.processProfile().mcpDirectory, ".agents", "mcp_config.json"), "utf8"));
    return value.mcpServers[host.bridge.serverName];
  };
  const rpc = async (host, token, name = "read") => fetch(host.bridge.url, { method: "POST", headers: { "content-type": "application/json", "x-pi-bridge-token": token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { path: "fixture" } } }) });
  try {
    await first.ensureRegistered(ui, f.root, "real-session");
    const firstPrepared = await first.prepareAgent("System.", [toolA, toolB]);
    const old = config(first);
    await assert.rejects(successor.ensureRegistered(ui, f.root, "real-session"), /live or unverified/);
    const hooks = new Map();
    const order = [];
    registerSessionHooks({
      pi: { on(name, cb) { const list = hooks.get(name) ?? []; list.push(cb); hooks.set(name, list); } },
      runtime: { async close() { order.push("runtime-closed"); } },
      sync: {}, monitor: { stopPolling() {}, async stopLiveTasks() {}, dispose() { order.push("disposed"); } },
      bridge: first, refreshStaleModels: async () => {},
    });
    for (const hook of hooks.get("session_shutdown")) await hook();
    assert.deepEqual(order, ["runtime-closed", "disposed"]);
    await successor.ensureRegistered(ui, f.root, "real-session");
    const nextPrepared = await successor.prepareAgent("System.", [toolB, reorderedA]);
    assert.equal(nextPrepared.agentBody, firstPrepared.agentBody);
    assert.equal(successor.bridge.serverName, first.bridge.serverName);
    const next = config(successor);
    assert.notEqual(next.headers["x-pi-bridge-token"], old.headers["x-pi-bridge-token"]);
    assert.equal((await rpc(successor, old.headers["x-pi-bridge-token"])).status, 403);
    await other.ensureRegistered(ui, f.root, "other-session");
    assert.notEqual(other.bridge.serverName, successor.bridge.serverName);
    assert.notEqual(other.bridge.url, successor.bridge.url);
    const longName = "edge_devtools_unattended_performance_analyze_insight_with_long_name";
    for (const [host, label] of [[successor, "SELF"], [other, "OTHER"]]) {
      await host.prepareAgent("System.", ["read", longName].map(name => ({ name, description: "Read.", parameters: { type: "object", properties: { path: { type: "string" } } } })));
      host.bridge.refreshTools();
      host.bridge.setOnCall(call => { queueMicrotask(() => host.bridge.resolveCall(call.id, { content: label + ":" + call.tool, isError: false })); return true; });
    }
    for (const [host, label] of [[successor, "SELF"], [other, "OTHER"]]) {
      const own = config(host);
      const response = await rpc(host, own.headers["x-pi-bridge-token"]);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).result.content[0].text, label + ":read");
      const alias = bridgeToolName(host.bridge.serverName, longName);
      assert.equal(("mcp_" + host.bridge.serverName + "_" + alias).length, 64);
      const longResponse = await rpc(host, own.headers["x-pi-bridge-token"], alias);
      assert.equal((await longResponse.json()).result.content[0].text, label + ":" + longName);
    }
    assert.equal((await rpc(other, next.headers["x-pi-bridge-token"])).status, 403);
  } finally { await first.teardown(); await successor.teardown(); await other.teardown(); f.cleanup(); }
});
