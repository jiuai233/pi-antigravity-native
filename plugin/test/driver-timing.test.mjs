import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { test } from "node:test";
import { AgyDriverSession, AgyOneShotExecutor } from "../src/driver/agy-driver.ts";
import { fixture, flush } from "./offline-fixture.mjs";

const ID = "11111111-1111-1111-1111-111111111111";
const completed = (child, response = "fixture reply") => child.send({
  event: "result", result: { status: "SUCCESS", conversation_id: ID, response },
});
const phases = events => events.map(event => event.phase);

test("persistent timing separates backpressure, stdout, parsed activity and text; queued reuse stays one process", async t => {
  const f = fixture();
  const child = f.child(970001);
  let completeWrite;
  const written = [];
  child.stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) {
    written.push(chunk.toString()); completeWrite = done;
  } });
  child.stdin.on("finish", () => { child.exitCode = 0; child.emit("close", 0, null); });
  let spawns = 0;
  const driver = new AgyDriverSession(f.executionDependencies);
  t.after(() => driver.close("shutdown"));
  const events = [], queuedEvents = [];
  const request = (prompt, sink) => ({ prompt, binary: "OFFLINE_FAKE", conversationId: ID,
    onDiagnostic: event => sink.push(event), spawnOverride: () => { spawns++; return child; } });
  const pending = driver.run(request("PROMPT_SECRET", events));
  await flush();
  assert.deepEqual(phases(events), ["local_run_start", "stdin_ready", "stdin_write_start"]);
  await f.tick(17);
  assert.equal(events.some(event => event.phase === "stdin_write_complete"), false);
  completeWrite(); await flush();
  assert.equal(events.find(event => event.phase === "stdin_write_complete").atMs, 1017);
  assert.deepEqual(JSON.parse(written[0]), { event: "user", message: { role: "user", content: "PROMPT_SECRET" } });
  await f.tick(23); child.stdout.write("UNKNOWN_SECRET\n");
  await f.tick(31); child.send({ event: "init", conversation_id: ID, init: {} });
  assert.equal(events.some(event => event.phase === "activity_first"), false);
  await f.tick(7); child.send({ event: "step_update", step_update: {
    step_type: "tool", step_index: 1, state: "ACTIVE", tool_name: "fixture", tool_info: { parameters: { secret: "ARGS_SECRET" } },
  } });
  await f.tick(13); child.send({ event: "step_update", step_update: {
    step_type: "tool", step_index: 1, state: "DONE", tool_name: "fixture",
  } });
  await f.tick(19); child.send({ event: "step_update", step_update: {
    step_type: "agent_response", step_index: 2, state: "ACTIVE", text_delta: "RESPONSE_SECRET",
  } });
  const queued = driver.run(request("SECOND_PROMPT_SECRET", queuedEvents));
  await flush();
  assert.deepEqual(phases(queuedEvents), ["local_run_start"]);
  completed(child); assert.equal((await pending).status, "OK");
  await flush(); completeWrite(); await flush();
  completed(child); assert.equal((await queued).status, "OK");
  assert.equal(spawns, 1);
  assert.equal(events.find(event => event.phase === "stdin_ready").reusedProcess, false);
  assert.equal(queuedEvents.find(event => event.phase === "stdin_ready").reusedProcess, true);
  assert.equal(events.find(event => event.phase === "stdout_first_byte").atMs, 1040);
  assert.equal(events.find(event => event.phase === "activity_first").atMs, 1078);
  assert.equal(events.find(event => event.phase === "activity_first").activityType, "tool_start");
  assert.equal(events.find(event => event.phase === "response_text_first").atMs, 1110);
  for (const sink of [events, queuedEvents]) {
    for (const phase of ["stdout_first_byte", "activity_first", "response_text_first"]) {
      assert.equal(sink.filter(event => event.phase === phase).length, 1);
    }
    assert.doesNotMatch(JSON.stringify(sink), /SECRET/);
    assert.ok(sink.every(event => event.executionMode === "persistent"));
  }
});

test("throwing diagnostic sinks cannot interrupt direct executor results or configured stalls", async t => {
  t.mock.method(console, "warn", () => {});
  for (const oneShot of [false, true]) for (const ending of ["result", "stall"]) {
    const f = fixture();
    const child = f.child(970002);
    f.childrenHost.spawnSync = (_cmd, args) => {
      f.kills.push(Number(args.at(-1)));
      queueMicrotask(() => { child.exitCode = 1; child.emit("close", 1, null); });
    };
    const driver = oneShot ? new AgyOneShotExecutor(f.executionDependencies) : new AgyDriverSession(f.executionDependencies);
    const pending = driver.run({ prompt: "fixture", binary: "OFFLINE_FAKE", conversationId: ID,
      onDiagnostic: () => { throw Error("diagnostic sink failed"); },
      inactivityTimeoutMs: ending === "stall" ? 20 : 0,
      spawnOverride: () => child,
    }).catch(error => error);
    await flush();
    assert.doesNotThrow(() => child.emit("spawn"));
    if (ending === "result") {
      completed(child);
      assert.equal((await pending).status, "OK");
    } else {
      await f.tick(21);
      assert.match((await pending).message, /stream stalled/);
      assert.equal(f.kills.length, 1);
    }
    await driver.close("shutdown");
  }
});

test("real local child pipes report host boundaries in both execution modes without AGY or network", async t => {
  for (const oneShot of [false, true]) await t.test(oneShot ? "argv child" : "stdin child", async () => {
    const events = [];
    let closed;
    const childCode = `
      const send = e => process.stdout.write(JSON.stringify(e) + "\\n");
      const respond = () => {
        send({event:"init",conversation_id:"${ID}",init:{}});
        setTimeout(() => send({event:"step_update",step_update:{step_type:"agent_response",state:"ACTIVE"}}), 10);
        setTimeout(() => {
          send({event:"step_update",step_update:{step_type:"agent_response",state:"DONE",text_delta:"child fixture"}});
          send({event:"result",result:{status:"SUCCESS",conversation_id:"${ID}",response:"child fixture"}});
          ${oneShot ? "setTimeout(() => process.exit(0), 10);" : ""}
        }, 20);
      };
      ${oneShot ? "respond();" : 'require("node:readline").createInterface({input:process.stdin}).on("line", respond).on("close", () => process.exit(0));'}
    `;
    const driver = oneShot ? new AgyOneShotExecutor() : new AgyDriverSession();
    try {
      const result = await driver.run({ prompt: "fixture", binary: process.execPath,
        onDiagnostic: event => events.push(event),
        spawnOverride: (_binary, _args, options) => {
          const child = spawn(process.execPath, ["-e", childCode], options);
          closed = new Promise(resolve => child.once("close", resolve));
          return child;
        },
      });
      assert.equal(result.status, "OK");
      assert.equal(result.response, "child fixture");
      const wanted = oneShot
        ? ["local_run_start", "argv_spawn_start", "argv_spawned", "stdout_first_byte", "activity_first", "response_text_first"]
        : ["local_run_start", "stdin_ready", "stdin_write_start", "stdin_write_complete", "stdout_first_byte", "activity_first", "response_text_first"];
      assert.deepEqual(phases(events), wanted);
      for (let i = 1; i < events.length; i++) assert.ok(events[i].atMs >= events[i - 1].atMs);
      assert.doesNotMatch(JSON.stringify(events), /child fixture|--print|prompt|headers/);
    } finally {
      await driver.close("shutdown");
      await closed;
    }
  });
});
