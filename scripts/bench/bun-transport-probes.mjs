// Bun-native component probes complementing real BaseExecutor/Mux workload benches.
// Modes: serialization | body | upload | backlog | all. Run with Bun only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { loadSessionMessages, buildCheckpoints } from "./mux-fixtures.mjs";
import { beforeUpload, resetSchedulerForTests } from "../../open-sse/scheduling/trafficScheduler.js";

if (!globalThis.Bun) throw new Error("Run with Bun");
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const source = path.join(os.homedir(), ".mux/sessions/e8cf0d0b8f/chat.jsonl");
const messages = loadSessionMessages(source);
const stats = (xs) => { const s=[...xs].sort((a,b)=>a-b); const p=n=>+(s[Math.min(s.length-1,Math.ceil(n*s.length)-1)]||0).toFixed(2); return {p50:p(.5),p95:p(.95),p99:p(.99),max:+Math.max(0,...s).toFixed(2)}; };
const mb = n => +(n/1048576).toFixed(2);

async function startServer(temp) {
  const key=path.join(temp,"key.pem"), cert=path.join(temp,"cert.pem");
  if (!fs.existsSync(key)) execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-subj","/CN=127.0.0.1","-keyout",key,"-out",cert,"-days","1"],{stdio:"ignore"});
  const child=spawn("node",["scripts/bench/upstream-child.mjs",key,cert],{stdio:["ignore","pipe","inherit"]});
  const port=await new Promise((resolve,reject)=>{let b="";const timer=setTimeout(()=>reject(new Error("server timeout")),10000);child.stdout.on("data",d=>{b+=d;const m=b.match(/\d+/);if(m){clearTimeout(timer);resolve(+m[0]);}});});
  return {child,url:`https://127.0.0.1:${port}/v1/chat/completions`};
}
async function send(url, body) { const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body}); const rd=r.body.getReader(); while(!(await rd.read()).done){} }
async function sentinel(url, running, samples) { while(running.on){const t=performance.now();await new Promise(r=>setImmediate(r));const sched=performance.now()-t;const f=performance.now();await send(url,"{}");samples.push({sched,fetch:performance.now()-f,total:performance.now()-t});await Bun.sleep(20);} }
function heavyBody(targetTokens=300000){const cp=buildCheckpoints(messages,[targetTokens])[0].messages;return JSON.stringify({model:"benchmark-model",stream:true,messages:cp});}

async function serialization() {
  const sizes=[65536,131072,262144,393216,524288]; // token targets ~256KB..2MB serialized
  const conc=[1,4,8,16], rows=[];
  for(const target of sizes){const bodyObj=JSON.parse(heavyBody(target));const bytes=Buffer.byteLength(JSON.stringify(bodyObj));for(const n of conc){const durations=[],lags=[];for(let rep=0;rep<7;rep++){let fired=false;const lt=performance.now();setImmediate(()=>{lags.push(performance.now()-lt);fired=true;});const t=performance.now();await Promise.all(Array.from({length:n},async()=>{const x=performance.now();JSON.stringify(bodyObj);durations.push(performance.now()-x);}));while(!fired)await new Promise(r=>setImmediate(r));}rows.push({bytes,mb:mb(bytes),concurrency:n,stringify:stats(durations),schedulingLag:stats(lags)});}}
  return rows;
}
async function transport(mode) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"9router-bun-transport-"));const heavy=await startServer(temp),victim=await startServer(temp);const body=heavyBody();const bytes=Buffer.byteLength(body);const levels=mode==="body"?[8]:[1,2,4,8,16];const forms=mode==="body"?["string","uint8array"]:["string"];const rows=[];
  try{for(const form of forms){for(const n of levels){const loop=monitorEventLoopDelay({resolution:2});loop.enable();const running={on:true},samples=[];const sv=sentinel(victim.url,running,samples);await Bun.sleep(50);const payload=form==="string"?body:new TextEncoder().encode(body);const heap0=process.memoryUsage();const cpu0=process.cpuUsage();const t=performance.now();await Promise.all(Array.from({length:n},()=>send(heavy.url,payload)));const wall=performance.now()-t;const cpu=process.cpuUsage(cpu0);const heap1=process.memoryUsage();running.on=false;await sv;loop.disable();rows.push({form,concurrency:n,bytes,aggregateMBps:+((bytes*n/1048576)/(wall/1000)).toFixed(1),perRequestMBps:+((bytes/1048576)/(wall/1000)).toFixed(1),batchWallMs:+wall.toFixed(2),victim:stats(samples.map(x=>x.total)),scheduling:stats(samples.map(x=>x.sched)),runtimeLagP95:+(Number(loop.percentile(95))/1e6).toFixed(2),cpuMs:+((cpu.user+cpu.system)/1000).toFixed(2),heapDeltaMB:+((heap1.heapUsed-heap0.heapUsed)/1048576).toFixed(2),rssDeltaMB:+((heap1.rss-heap0.rss)/1048576).toFixed(2)});}}}finally{heavy.child.kill();victim.child.kill();fs.rmSync(temp,{recursive:true,force:true});}return rows;
}
async function backlog(){const temp=fs.mkdtempSync(path.join(os.tmpdir(),"9router-bun-backlog-"));const heavy=await startServer(temp),victim=await startServer(temp);const body=heavyBody(),bytes=Buffer.byteLength(body),rows=[];try{for(const n of [8,16,25,50]){resetSchedulerForTests();const loop=monitorEventLoopDelay({resolution:2});loop.enable();const running={on:true},samples=[];const sv=sentinel(victim.url,running,samples);await Bun.sleep(50);const waits=[];const heap0=process.memoryUsage();const t=performance.now();await Promise.all(Array.from({length:n},async()=>{const a=performance.now();await beforeUpload({actualBytes:bytes});waits.push(performance.now()-a);await send(heavy.url,body);}));const wall=performance.now()-t;const heap1=process.memoryUsage();running.on=false;await sv;loop.disable();rows.push({burst:n,admission:stats(waits),victim:stats(samples.map(x=>x.total)),batchWallMs:+wall.toFixed(2),rps:+(n/(wall/1000)).toFixed(1),heapDeltaMB:+((heap1.heapUsed-heap0.heapUsed)/1048576).toFixed(2),rssDeltaMB:+((heap1.rss-heap0.rss)/1048576).toFixed(2),runtimeLagP95:+(Number(loop.percentile(95))/1e6).toFixed(2)});}}finally{heavy.child.kill();victim.child.kill();fs.rmSync(temp,{recursive:true,force:true});}return rows;}

const mode=process.argv[2]||"all";const out={runtime:`Bun ${Bun.version}`,mode};if(mode==="serialization"||mode==="all")out.serialization=await serialization();if(mode==="body"||mode==="all")out.body=await transport("body");if(mode==="upload"||mode==="all")out.upload=await transport("upload");if(mode==="backlog"||mode==="all")out.backlog=await backlog();process.stdout.write("BUN_TRANSPORT_RESULTS_START\n"+JSON.stringify(out,null,2)+"\nBUN_TRANSPORT_RESULTS_END\n");
