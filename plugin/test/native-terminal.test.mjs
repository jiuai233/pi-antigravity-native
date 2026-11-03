
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgyDriverSession, AgyOneShotExecutor } from '../src/driver/agy-driver.ts';
import { captureNativeTurnBoundary, reconcileNativeTerminal } from '../src/native/native-terminal.ts';
import { fixture, flush } from './offline-fixture.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const historical = 'executor failed before the previous request could run';
function varint(n) { const bytes=[]; do { const b=n&127;n>>>=7;bytes.push(b|(n?128:0)); } while(n);return Buffer.from(bytes); }
function field(n, body) { const b=Buffer.isBuffer(body)?body:Buffer.from(body);return Buffer.concat([varint(n*8+2),varint(b.length),b]); }
const errorPayload=message=>field(24,field(3,field(2,message)));
const responsePayload=message=>field(20,field(1,message));

function databaseFixture(run) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-terminal-'));
  const prior=process.env.JETSKI_APP_DATA_DIR;process.env.JETSKI_APP_DATA_DIR=root;
  fs.mkdirSync(path.join(root,'conversations'));
  const file=path.join(root,'conversations',id+'.db');
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,error_details BLOB,step_payload BLOB)');
  const add=(idx,type,payload=Buffer.alloc(0),status=3,error=null)=>db.prepare('INSERT INTO steps VALUES(?,?,?,?,?)').run(idx,type,status,error,payload);
  add(0,14);add(1,17,errorPayload(historical));
  try { run({root,file,db,add,boundary:captureNativeTurnBoundary(id,root),result:{conversation_id:id,status:'ERROR',response:'New verified answer\n',error:historical}}); }
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
      const pending=executor.run({binary:'OFFLINE_FAKE',conversationId:id,prompt:'new request',onDiagnostic:d=>diagnostics.push(d)});
      await flush();assert.equal(captured,1);
      child.send({event:'result',result:{conversation_id:id,status:'ERROR',error:historical,response:'New verified answer'}});
      assert.equal((await pending).status,'OK');assert.equal(reconciled,1);
      assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].phase,'historical_terminal_error');
      assert.equal(JSON.parse(diagnostics[0].message).original_error,historical);
    }finally{await executor.close('shutdown');}
  });
}
