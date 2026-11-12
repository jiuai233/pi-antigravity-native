
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgyDriverSession, AgyOneShotExecutor } from '../src/driver/agy-driver.ts';
import { stallContinuationPrompt } from '../src/input/prompt.ts';
import { captureNativeTurnBoundary, reconcileNativeTerminal } from '../src/native/native-terminal.ts';
import { createAntigravityRuntime } from '../src/runtime/runtime.ts';
import { fixture, flush } from './offline-fixture.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const historical = 'executor failed before the previous request could run';
function varint(n) { const bytes=[]; do { const b=n&127;n>>>=7;bytes.push(b|(n?128:0)); } while(n);return Buffer.from(bytes); }
function field(n, body) { const b=Buffer.isBuffer(body)?body:Buffer.from(body);return Buffer.concat([varint(n*8+2),varint(b.length),b]); }
const errorPayload=message=>field(24,field(3,field(2,message)));
const responsePayload=message=>field(20,field(1,message));

async function databaseFixture(run) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-terminal-'));
  const prior=process.env.JETSKI_APP_DATA_DIR;process.env.JETSKI_APP_DATA_DIR=root;
  fs.mkdirSync(path.join(root,'conversations'));
  const file=path.join(root,'conversations',id+'.db');
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,error_details BLOB,step_payload BLOB)');
  const add=(idx,type,payload=Buffer.alloc(0),status=3,error=null)=>db.prepare('INSERT INTO steps VALUES(?,?,?,?,?)').run(idx,type,status,error,payload);
  add(0,14);add(1,17,errorPayload(historical));
  try { return await run({root,file,db,add,boundary:captureNativeTurnBoundary(id,root),result:{conversation_id:id,status:'ERROR',response:'New verified answer\n',error:historical}}); }
  finally { db.close();if(prior===undefined)delete process.env.JETSKI_APP_DATA_DIR;else process.env.JETSKI_APP_DATA_DIR=prior;fs.rmSync(root,{recursive:true,force:true}); }
}

test('historical terminal error requires an exact old error plus a new completed native turn; preserves history and raw failure',()=>databaseFixture(({root,file,db,add,boundary,result})=>{
  add(2,14);add(3,132);add(4,15,responsePayload('New verified answer'));
  const before=fs.readFileSync(file);
  const value=reconcileNativeTerminal(result,boundary,root);
  assert.equal(value.result.status,'SUCCESS');assert.equal(value.result.error,undefined);
  assert.equal(result.status,'ERROR');assert.equal(result.error,historical);
  assert.equal(value.correction.original_error,historical);assert.equal(value.correction.historical_error_step,1);
  assert.equal(value.correction.before_step,1);assert.equal(value.correction.user_step,2);assert.equal(value.correction.completed_response_step,4);
  assert.equal(db.prepare('SELECT step_type FROM steps WHERE idx=1').get().step_type,17);
  assert.deepEqual(fs.readFileSync(file),before);
}));

// agy joins every text segment of a turn into `response` (measured with agy 1.5.5 stream-json).
const toolTurn=(add,last='Second segment',middle=()=>add(4,132),first='First segment')=>{add(2,14);add(3,15,responsePayload(first));middle();add(5,15);add(6,15,last===null?Buffer.alloc(0):responsePayload(last));};
test('historical terminal error is corrected for a completed turn with tool calls and several text segments',()=>databaseFixture(({root,add,boundary,result})=>{
  toolTurn(add);
  const value=reconcileNativeTerminal({...result,response:'First segment\nSecond segment\n'},boundary,root);
  assert.equal(value.result.status,'SUCCESS');assert.equal(value.correction.completed_response_step,6);
}));
test('historical terminal error is corrected when an intermediate planner segment already ends with a newline',()=>databaseFixture(({root,add,boundary,result})=>{
  toolTurn(add,'Second segment',undefined,'First segment\n');
  const value=reconcileNativeTerminal({...result,response:'First segment\n\nSecond segment\n'},boundary,root);
  assert.equal(value.result.status,'SUCCESS');assert.equal(value.correction.completed_response_step,6);
}));
for(const [label,status,errBlob] of [
  ['mcp-tool-error-status-7',7,Buffer.from('Command exited with code 1')],
  ['mcp-tool-invalid-status-4',4,Buffer.from('invalid arguments')],
]){
  test(`historical terminal error is corrected after recovered MCP tool failure: ${label}`,()=>databaseFixture(({root,add,boundary,result})=>{
    toolTurn(add,'Second segment',()=>add(4,132,Buffer.alloc(0),status,errBlob));
    const value=reconcileNativeTerminal({...result,response:'First segment\nSecond segment\n'},boundary,root);
    assert.equal(value.result.status,'SUCCESS');assert.equal(value.correction.completed_response_step,6);
  }));
}
for(const [kind,response,extra] of [
  ['extra-text','First segment\nSecond segment\nUnseen segment\n'],
  ['reordered','Second segment\nFirst segment\n'],
  ['unhealed-error-at-end','First segment\n',add=>()=>{add(4,17,errorPayload(historical));}],
  ['mcp-tool-canceled-status-6','First segment\nSecond segment\n',add=>()=>add(4,132,Buffer.alloc(0),6,null)],
  ['non-mcp-step-status-7','First segment\nSecond segment\n',add=>()=>add(4,101,Buffer.alloc(0),7,Buffer.from('err'))],
  ['planner-status-7','First segment\nSecond segment\n',add=>()=>add(4,15,Buffer.alloc(0),7,Buffer.from('err'))],
  ['planner-status-6','First segment\nSecond segment\n',add=>()=>add(4,15,Buffer.alloc(0),6,null)],
  ['final-step-without-text','First segment\n',null],
]){
  test(`tool-call turn keeps the failure: ${kind}`,()=>databaseFixture(({root,add,boundary,result})=>{
    if(kind==='unhealed-error-at-end'){
      add(2,14);add(3,15,responsePayload('First segment'));add(4,17,errorPayload(historical));
    }else if(extra===null)toolTurn(add,null);else if(extra)toolTurn(add,undefined,extra(add));else toolTurn(add);
    const value=reconcileNativeTerminal({...result,response},boundary,root);
    assert.equal(value.result.status,'ERROR');assert.equal(value.correction,null);
  }));
}

test('self-healed in-turn errors succeed with error count on both fresh Turn 0 and zero-prior-error conversations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-healed-'));
  const prior = process.env.JETSKI_APP_DATA_DIR; process.env.JETSKI_APP_DATA_DIR = root;
  fs.mkdirSync(path.join(root, 'conversations'));
  const file = path.join(root, 'conversations', id + '.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,error_details BLOB,step_payload BLOB)');
  const add = (idx, type, payload = Buffer.alloc(0), status = 3, error = null) =>
    db.prepare('INSERT INTO steps VALUES(?,?,?,?,?)').run(idx, type, status, error, payload);
  try {
    // 1. Fresh Turn 0 (conversationId undefined before request) with CLEARED planner/tool before 2 errors, then healed.
    const freshBoundary = captureNativeTurnBoundary(undefined, root);
    add(0, 14);
    add(1, 15, Buffer.alloc(0), 5);
    add(2, 132, Buffer.alloc(0), 5);
    add(3, 17, errorPayload('API error (attempt 1): INTERNAL (code 500): retry'));
    add(4, 17, errorPayload('API error (attempt 2): UNAVAILABLE (code 503): retry'));
    add(5, 132, Buffer.alloc(0), 7, Buffer.from('exit 1'));
    add(6, 15, responsePayload('Healed answer'));
    const healed0 = reconcileNativeTerminal(
      { conversation_id: id, status: 'ERROR', error: 'API error (attempt 2): UNAVAILABLE (code 503): retry', response: 'Healed answer\n' },
      freshBoundary, root,
    );
    assert.equal(healed0.result.status, 'SUCCESS');
    assert.equal(healed0.correction.kind, 'healed_in_turn_error');
    assert.equal(healed0.correction.in_turn_error_count, 2);

    // 2. Resumed conversation with zero prior errors before Turn 1.
    db.exec('DELETE FROM steps');
    add(0, 14); add(1, 15, responsePayload('Clean turn 0'));
    const zeroErrBoundary = captureNativeTurnBoundary(id, root);
    assert.deepEqual(zeroErrBoundary.errors, []);
    // Historical path still rejects when errors=[] and no in-turn 17 exists.
    add(2, 14); add(3, 15, responsePayload('Clean turn 1'));
    assert.equal(
      reconcileNativeTerminal({ conversation_id: id, status: 'ERROR', error: 'unseen', response: 'Clean turn 1\n' }, zeroErrBoundary, root).correction,
      null,
    );
    // In-turn 17 followed by DONE planner succeeds.
    db.exec('DELETE FROM steps WHERE idx >= 2');
    add(2, 14);
    add(3, 15, responsePayload('Part A'));
    add(4, 17, errorPayload('API error (attempt 1): INTERNAL (code 500): retry'));
    add(5, 15, responsePayload('Part B'));
    const healed1 = reconcileNativeTerminal(
      { conversation_id: id, status: 'ERROR', error: 'API error (attempt 1): INTERNAL (code 500): retry', response: 'Part A\nPart B\n' },
      zeroErrBoundary, root,
    );
    assert.equal(healed1.result.status, 'SUCCESS');
    assert.equal(healed1.correction.kind, 'healed_in_turn_error');
    assert.equal(healed1.correction.in_turn_error_count, 1);
  } finally {
    db.close();
    if (prior === undefined) delete process.env.JETSKI_APP_DATA_DIR; else process.env.JETSKI_APP_DATA_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [kind, buildSteps, response] of [
  ['error-at-end-unhealed', (add) => { add(2, 14); add(3, 15, responsePayload('Partial')); add(4, 17, errorPayload(historical)); }, 'Partial\n'],
  ['canceled-before-error', (add) => { add(2, 14); add(3, 132, Buffer.alloc(0), 6); add(4, 17, errorPayload(historical)); add(5, 15, responsePayload('Answer')); }, 'Answer\n'],
  ['cleared-user-input', (add) => { add(2, 14, Buffer.alloc(0), 5); add(3, 17, errorPayload(historical)); add(4, 15, responsePayload('Answer')); }, 'Answer\n'],
  ['checkpoint-in-turn', (add) => { add(2, 14); add(3, 17, errorPayload(historical)); add(4, 23); add(5, 15, responsePayload('Answer')); }, 'Answer\n'],
  ['cleared-planner-after-error', (add) => { add(2, 14); add(3, 17, errorPayload(historical)); add(4, 15, Buffer.alloc(0), 5); add(5, 15, responsePayload('Answer')); }, 'Answer\n'],
  ['generating-planner-after-error', (add) => { add(2, 14); add(3, 17, errorPayload(historical)); add(4, 15, Buffer.alloc(0), 8); add(5, 15, responsePayload('Answer')); }, 'Answer\n'],
  ['mismatched-healed-text', (add) => { add(2, 14); add(3, 17, errorPayload(historical)); add(4, 15, responsePayload('Answer')); }, 'Different\n'],
  ['unmatched-error-message', (add) => { add(2, 14); add(3, 17, errorPayload('in-turn error')); add(4, 15, responsePayload('Answer')); }, 'Answer\n'],
]) {
  test(`in-turn error is NOT marked healed when unsafe: ${kind}`, () => databaseFixture(({ root, add, boundary, result }) => {
    buildSteps(add);
    const errText = kind === 'unmatched-error-message' ? 'neither-prior-nor-in-turn' : historical;
    const value = reconcileNativeTerminal({ ...result, error: errText, response }, boundary, root);
    assert.equal(value.result.status, 'ERROR');
    assert.equal(value.correction, null);
  }));
}

for (const [label, details, correctable] of [
  ['null', null, true],
  ['empty-blob', Buffer.alloc(0), true],
  ['nonempty-text', 'a new current-turn failure', false],
  ['empty-text', '', false],
  ['numeric-zero', 0, false],
  ['numeric-error', 1, false],
]) {
  test(`current-turn error_details requires a known empty representation: ${label}`, () => databaseFixture(({root,file,add,boundary,result}) => {
    add(2,14); add(3,132,Buffer.alloc(0),3,details); add(4,15,responsePayload('New verified answer'));
    const before = fs.readFileSync(file);
    const value = reconcileNativeTerminal(result,boundary,root);
    if (correctable) assert.equal(value.result.status,'SUCCESS');
    else { assert.equal(value.result,result); assert.equal(value.correction,null); }
    assert.deepEqual(fs.readFileSync(file),before);
  }));
}

for(const kind of ['same-error-in-current-turn','new-error','pending-step','no-new-user','no-final-response','different-response','multiple-new-users','noncontiguous','error-details']){
  test(`current-turn evidence does not permit correction: ${kind}`,()=>databaseFixture(({root,add,boundary,result})=>{
    if(kind!=='no-new-user')add(2,14);
    if(kind==='same-error-in-current-turn')add(3,17,errorPayload(historical));
    else if(kind==='new-error')add(3,17,errorPayload('new real failure'));
    else if(kind==='pending-step')add(3,132,Buffer.alloc(0),1);
    else if(kind==='multiple-new-users')add(3,14);
    else if(kind==='error-details')add(3,132,Buffer.alloc(0),3,Buffer.from('failure'));
    else if(kind!=='noncontiguous')add(3,132);
    add(4,kind==='no-final-response'?132:15,responsePayload(kind==='different-response'?'Other answer':'New verified answer'));
    const value=reconcileNativeTerminal(result,boundary,root);assert.equal(value.result,result);assert.equal(value.correction,null);
  }));
}
for(const kind of ['missing-boundary','unknown-conversation','different-error','timeout','cancelled','already-success','empty-response']){
  test(`terminal identity is not weakened: ${kind}`,()=>databaseFixture(({root,add,boundary,result})=>{
    add(2,14);add(3,15,responsePayload('New verified answer'));
    if(kind==='missing-boundary')boundary=null;
    if(kind==='unknown-conversation')result.conversation_id='87654321-1234-1234-1234-123456789abc';
    if(kind==='different-error')result.error='different executor failure';
    if(kind==='timeout')result.status='TIMEOUT';if(kind==='cancelled')result.status='CANCELLED';
    if(kind==='already-success')result.status='SUCCESS';if(kind==='empty-response')result.response='';
    assert.equal(reconcileNativeTerminal(result,boundary,root).correction,null);
  }));
}

test('missing or invalid native record leaves failure untouched',()=>databaseFixture(({root,db,boundary,result})=>{
  assert.equal(captureNativeTurnBoundary('../unowned',root),null);
  db.exec('DROP TABLE steps');
  assert.equal(captureNativeTurnBoundary(id,root),null);
  assert.equal(reconcileNativeTerminal(result,boundary,root).correction,null);
}));

for(const oneShot of [false,true]) {
  test(`${oneShot?'one-shot':'persistent'} consumes a proven correction and records original status`,async()=>{
    let captured=0,reconciled=0;const diagnostics=[];
    const f=fixture({upgradeNativeConversationDb:()=>({status:'unchanged'}),
      captureNativeTurnBoundary:()=>{captured++;return {marker:'captured-before-request'};},
      reconcileNativeTerminal:(result,boundary)=>{reconciled++;assert.equal(boundary.marker,'captured-before-request');return {result:{...result,status:'SUCCESS',error:undefined},correction:{original_status:'ERROR',original_error:historical,user_step:2,completed_response_step:3}};}});
    const child=f.child(oneShot?900202:900201);f.executionDependencies.spawn=()=>child;
    const executor=oneShot?new AgyOneShotExecutor(f.executionDependencies):new AgyDriverSession(f.executionDependencies);
    try {
      const pending=executor.run({binary:'OFFLINE_FAKE',conversationId:id,prompt:'new request',onDiagnostic:d=>{ if (d.phase.endsWith('_error')) diagnostics.push(d); }});
      await flush();assert.equal(captured,1);
      child.send({event:'result',result:{conversation_id:id,status:'ERROR',error:historical,response:'New verified answer'}});
      assert.equal((await pending).status,'OK');assert.equal(reconciled,1);
      assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].phase,'historical_terminal_error');
      assert.equal(JSON.parse(diagnostics[0].message).original_error,historical);
    }finally{await executor.close('shutdown');}
  });
}

test('Pi retry after an unfinished persisted turn sends continuation prompt instead of resending raw user prompt, and resets on manual abort or new prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-retry-cont-'));
  const prior = process.env.JETSKI_APP_DATA_DIR; process.env.JETSKI_APP_DATA_DIR = root;
  fs.mkdirSync(path.join(root, 'conversations'));
  const file = path.join(root, 'conversations', id + '.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,error_details BLOB,step_payload BLOB)');
  const add = (idx, type, payload = Buffer.alloc(0), status = 3) =>
    db.prepare('INSERT INTO steps VALUES(?,?,?,NULL,?)').run(idx, type, status, payload);
  add(0, 14); add(1, 15, responsePayload('Prior turn'));

  const prompts = [];
  const diagnostics = [];
  let callIndex = 0;
  const drain = async (ctrl) => { while (await ctrl.next() !== null) {} };
  const runtime = createAntigravityRuntime(async (req) => {
    prompts.push(req.prompt);
    callIndex += 1;
    req.onConversation?.(id);
    if (callIndex === 1) {
      // Simulate AGY persisting USER_INPUT + tool + ERROR_STEP without finishing.
      add(2, 14); add(3, 132); add(4, 17, errorPayload('stream idle timeout'));
      return { conversationId: id, status: 'ERROR', error: 'stream idle timeout', response: '', finished: true };
    }
    if (callIndex === 2) {
      add(5, 14); add(6, 15, responsePayload('Continued answer'));
      return { conversationId: id, status: 'OK', response: 'Continued answer', finished: true };
    }
    if (callIndex === 3) {
      add(7, 14); add(8, 17, errorPayload('API error (attempt 2): UNAVAILABLE (code 503): retry'));
      return { conversationId: id, status: 'ERROR', error: 'API error (attempt 2): UNAVAILABLE (code 503): retry', response: '', finished: true };
    }
    add(9, 14); add(10, 15, responsePayload('Fresh user question answer'));
    return { conversationId: id, status: 'OK', response: 'Fresh user question answer', finished: true };
  }, (d) => diagnostics.push(d));

  try {
    await runtime.setSession(root, 'gemini-4-carbon', false);
    await runtime.restoreConversation({ conversationId: id, cwd: root, modelId: 'gemini-4-carbon', turns: 1, usage: {} });

    // Attempt 1 fails mid-turn after persisting USER_INPUT.
    const c1 = await runtime.beginStreamTurn({ prompt: 'Original huge user prompt', modelId: 'gemini-4-carbon' });
    await drain(c1);
    runtime.finishTurn();
    assert.equal(prompts[0], 'Original huge user prompt');

    // Attempt 2 (Pi auto-retry with identical prompt) sends continuation prompt instead!
    const c2 = await runtime.beginStreamTurn({ prompt: 'Original huge user prompt', modelId: 'gemini-4-carbon' });
    await drain(c2);
    runtime.finishTurn();
    assert.equal(prompts[1], stallContinuationPrompt());
    assert.ok(diagnostics.some((d) => d.phase === 'retry_continuation'));

    // Attempt 3 fails mid-turn, then user sends a DIFFERENT prompt -> must NOT replace with continuation prompt!
    const c3 = await runtime.beginStreamTurn({ prompt: 'Second prompt', modelId: 'gemini-4-carbon' });
    await drain(c3);
    runtime.finishTurn();
    const c4 = await runtime.beginStreamTurn({ prompt: 'Different third prompt', modelId: 'gemini-4-carbon' });
    await drain(c4);
    runtime.finishTurn();
    assert.equal(prompts[3], 'Different third prompt');
  } finally {
    await runtime.close();
    db.close();
    if (prior === undefined) delete process.env.JETSKI_APP_DATA_DIR; else process.env.JETSKI_APP_DATA_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const apiErrors = [
  'API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF',
  'API error (attempt 2): INTERNAL (code 500): Internal error encountered.',
  'API error (attempt 3): UNAVAILABLE (code 503): No capacity available for model fixture on the server',
];

for (const error of apiErrors) {
  test(`a matching API error followed by a completed retry is recovered: ${error}`, () => databaseFixture(({root,file,add,boundary,result}) => {
    add(2,14); add(3,17,errorPayload(error)); add(4,15,responsePayload('New verified answer'));
    result.error = error;
    const before = fs.readFileSync(file);
    const value = reconcileNativeTerminal(result,boundary,root);
    assert.equal(value.result.status,'SUCCESS');
    assert.equal(value.result.error,undefined);
    assert.equal(value.correction.kind,'healed_in_turn_error');
    assert.deepEqual(value.correction.in_turn_error_count,1);
    assert.equal(value.correction.original_error,error);
    assert.equal(result.status,'ERROR');
    assert.equal(result.error,error);
    assert.deepEqual(fs.readFileSync(file),before);
  }));
}

test('multiple native API retries recover only after the final completed response', () => databaseFixture(({root,add,boundary,result}) => {
  add(2,14);
  apiErrors.forEach((error,index) => add(3+index,17,errorPayload(error)));
  add(6,15,responsePayload('New verified answer'));
  result.error = apiErrors[0];
  const value = reconcileNativeTerminal(result,boundary,root);
  assert.equal(value.result.status,'SUCCESS');
  assert.deepEqual(value.correction.in_turn_error_count,3);
}));

for (const kind of ['no-response','pending-response','cancelled-response','failed-tool','new-unrecovered-error',
  'different-api-error','authentication-error','unknown-error-payload','unexecuted-tool-call','response-mismatch']) {
  test(`a retry does not hide an unresolved failure: ${kind}`, () => databaseFixture(({root,add,boundary,result}) => {
    result.error = apiErrors[0];
    add(2,14); add(3,17,errorPayload(apiErrors[0]));
    if (kind === 'failed-tool') add(4,132,Buffer.alloc(0),4);
    else if (kind === 'authentication-error') add(4,17,errorPayload('API error (attempt 2): PERMISSION_DENIED (code 403): Forbidden'));
    else if (kind === 'unknown-error-payload') add(4,17);
    else add(4,132);
    if (kind !== 'no-response') {
      const payload = kind === 'unexecuted-tool-call'
        ? field(20,Buffer.concat([field(1,'New verified answer'),field(7,field(1,'pending-tool'))]))
        : responsePayload(kind === 'response-mismatch' ? 'Different answer' : 'New verified answer');
      add(5,15,payload,kind === 'pending-response' ? 1 : kind === 'cancelled-response' ? 6 : 3);
    }
    if (kind === 'new-unrecovered-error') add(6,17,errorPayload(apiErrors[1]));
    if (kind === 'different-api-error') result.error = apiErrors[2];
    const value = reconcileNativeTerminal(result,boundary,root);
    assert.equal(value.result,result);
    assert.equal(value.correction,null);
  }));
}

test('a historical error cannot mask a final response with an unexecuted tool call', () => databaseFixture(({root,add,boundary,result}) => {
  add(2,14);
  add(3,15,field(20,Buffer.concat([field(1,'New verified answer'),field(7,field(1,'pending-tool'))])));
  assert.equal(reconcileNativeTerminal(result,boundary,root).result,result);
}));

for (const oneShot of [false,true]) for (const fresh of [false,true]) {
  test(`${oneShot ? 'one-shot' : 'persistent'} ${fresh ? 'first' : 'resumed'} turn recovers using actual SQLite records and terminal parsing`, () => databaseFixture(async ({root,db,add}) => {
    db.exec(fresh ? 'DELETE FROM steps' : 'DELETE FROM steps WHERE idx=1');
    const diagnostics=[];
    const f=fixture({upgradeNativeConversationDb:()=>({status:'unchanged'}),
      captureNativeTurnBoundary,reconcileNativeTerminal});
    const child=f.child(900210);
    f.executionDependencies.spawn=()=>child;
    const executor=oneShot ? new AgyOneShotExecutor(f.executionDependencies) : new AgyDriverSession(f.executionDependencies);
    try {
      const pending=executor.run({binary:'OFFLINE_FAKE',cwd:root,prompt:'new request',
        ...(fresh ? {} : {conversationId:id}),onDiagnostic:event=>{ if (event.phase.endsWith('_error')) diagnostics.push(event); }});
      await flush();
      if (fresh) child.send({event:'init',conversation_id:id,init:{}});
      const user=fresh ? 0 : 1;
      add(user,14);add(user+1,17,errorPayload(apiErrors[0]));add(user+2,15,responsePayload('New verified answer'));
      child.send({event:'result',result:{conversation_id:id,status:'ERROR',error:apiErrors[0],response:'New verified answer'}});
      const result=await pending;
      assert.equal(result.status,'OK');
      assert.equal(result.error,undefined);
      assert.equal(diagnostics[0].phase,'healed_in_turn_error');
      const evidence=JSON.parse(diagnostics[0].message);
      assert.equal(evidence.before_step,fresh ? -1 : 0);
      assert.deepEqual(evidence.in_turn_error_count,1);
      assert.equal(db.prepare('SELECT step_type FROM steps WHERE idx=?').get(user+1).step_type,17);
    } finally {await executor.close('shutdown');}
  }));
}

for (const oneShot of [false,true]) {
  test(`${oneShot ? 'one-shot' : 'persistent'} keeps a real API failure and its partial response`, () => databaseFixture(async ({root,add}) => {
    const diagnostics=[];
    const f=fixture({upgradeNativeConversationDb:()=>({status:'unchanged'}),
      captureNativeTurnBoundary,reconcileNativeTerminal});
    const child=f.child(900220);
    f.executionDependencies.spawn=()=>child;
    const executor=oneShot ? new AgyOneShotExecutor(f.executionDependencies) : new AgyDriverSession(f.executionDependencies);
    try {
      const pending=executor.run({binary:'OFFLINE_FAKE',cwd:root,conversationId:id,prompt:'new request',
        onDiagnostic:event=>{ if (event.phase.endsWith('_error')) diagnostics.push(event); }});
      await flush();
      add(2,14);add(3,15,responsePayload('Partial answer'),6);add(4,17,errorPayload(apiErrors[0]));
      child.send({event:'result',result:{conversation_id:id,status:'ERROR',error:apiErrors[0],response:'Partial answer'}});
      const result=await pending;
      assert.equal(result.status,'ERROR');
      assert.equal(result.error,apiErrors[0]);
      assert.equal(result.response,'Partial answer');
      assert.deepEqual(diagnostics,[]);
    } finally {await executor.close('shutdown');}
  }));
}
