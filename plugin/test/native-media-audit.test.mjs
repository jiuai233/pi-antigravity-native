import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {collectNativeMedia,persistNativeMedia,NATIVE_MEDIA_ENTRY} from '../src/native/native-media-audit.ts';

test('native attachment audit matches actual bytes, records part provenance and persists once',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-media-audit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'a.wav'),attachment=path.join(root,'native.wav');
 const bytes=Buffer.from('neutral native attachment bytes');fs.writeFileSync(source,bytes);fs.writeFileSync(attachment,bytes);
 const logs=path.join(root,'brain','conversation','.system_generated','logs');fs.mkdirSync(logs,{recursive:true});
 const transcript=[{step_index:1,type:'PLANNER_RESPONSE',tool_calls:[{name:'view_file',args:{AbsolutePath:source}}]},
  {step_index:2,type:'GENERIC',media:[{mime_type:'audio/wav',uri:attachment}],created_at:'2026-10-27T03:34:18Z'}];
 fs.writeFileSync(path.join(logs,'transcript_full.jsonl'),transcript.map(JSON.stringify).join('\n')+'\n');
 const options={conversationId:'conversation',cwd:root,dataDirectory:root,probe:()=>({})};
 const [record]=collectNativeMedia(options);
 assert.equal(record.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(record.bytes,bytes.length);
 assert.deepEqual(record.requested_paths,[source]);assert.equal(record.source_match,'sha256-and-bytes');
 assert.equal(record.part_id,'step_2:part_0');assert.equal(record.part_id_source,'native-media-array-position');
 assert.equal(record.duration_seconds,undefined,'never invent duration from a model claim');
 const branch=[];const pi={appendEntry:(customType,data)=>branch.push({customType,data})};
 persistNativeMedia(pi,{...options,branch});persistNativeMedia(pi,{...options,branch});
 assert.equal(branch.length,1);assert.equal(branch[0].customType,NATIVE_MEDIA_ENTRY);assert.equal(branch[0].data.records[0].sha256,record.sha256);
 fs.writeFileSync(source,'changed after reception');
 assert.equal(collectNativeMedia(options)[0].source_match,'unmatched');
});

test('missing native evidence is a durable unavailable result, not a fabricated consumption',()=>{
 const entries=[];persistNativeMedia({appendEntry:(type,data)=>entries.push({type,data})},{conversationId:'absent',cwd:process.cwd(),dataDirectory:path.join(process.cwd(),'test-not-existing-native-store')});
 assert.equal(entries[0].data.status,'unavailable');assert.equal(entries[0].data.error.code,'ENOENT');
});
