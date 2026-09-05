// Small isolated process check, no gateway build or load traffic.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import http from 'node:http';
import {freePort} from './harness.mjs';
const port=await freePort();
const child=spawn(process.execPath,['--import',new URL('./telemetry.mjs',import.meta.url).pathname,'-e','setInterval(()=>{globalThis.__gatewayBenchAdmission({actualBytes:42});},10)'],{env:{...process.env,BENCH_CONTROL_PORT:String(port),BENCH_CONTROL_TOKEN:'test'},stdio:'ignore'});
const control=action=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:'/'+action,headers:{authorization:'test'}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>resolve({code:res.statusCode,body:JSON.parse(text)}));}).on('error',reject);});
try {
  for(let i=0;;i++){try{await control('start');break;}catch(e){if(i===50)throw e;await sleep(10);}}
  await sleep(60);const first=await control('stop');
  assert.equal(first.code,200);assert(first.body.admissions.length>0);assert(first.body.lagMs.length>0);assert.equal(first.body.dropped,0);
  assert.equal((await control('stop')).code,409);
  await sleep(40);await control('start');await sleep(30);const second=await control('stop');
  assert(second.body.start>first.body.start);assert(second.body.admissions.every(e=>e.offsetMs<second.body.elapsedMs));
  console.log('telemetry window checks passed');
} finally {const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
