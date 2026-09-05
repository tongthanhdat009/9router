// Node orchestrator/client/upstreams fixed; only actual Next gateway runtime varies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {validateSse, summary} from './validate.mjs';
const root=path.resolve(import.meta.dirname,'../../..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'9r-http-bench-'));
const children=[];
const output=path.resolve(process.env.BENCH_OUTPUT || 'gateway-benchmark.json');
const bun=process.env.BUN_BIN || path.join(os.homedir(),'.bun/bin/bun');
const result={schema:1,status:'incomplete',rows:[],missing:['policy matrix','request-internal stages','independent sentinel','body/serialization A/B','resource settle','native CPU profile','60s sustained'],client:{executable:process.execPath,version:process.version}};
// Do not inherit host secrets, proxy settings, HOME state, or repo .env contents.
const env={PATH:process.env.PATH,HOME:temp,DATA_DIR:temp,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',JWT_SECRET:'benchmark-local-only',API_KEY_SECRET:'benchmark-local-only',MACHINE_ID_SALT:'benchmark-local-only'};
fs.writeFileSync(path.join(temp,'.gateway-benchmark'),'1');
function launch(exe,args,extra={}) {
 const child=spawn(exe,args,{cwd:root,env:{...env,...extra},stdio:['ignore','pipe','pipe']});
 children.push(child); child.stderr.on('data',()=>{}); return child;
}
async function port() {
 const s=net.createServer(); s.listen(0,'127.0.0.1'); await once(s,'listening'); const p=s.address().port; await new Promise(r=>s.close(r));
 if ([20127,20128].includes(p)) throw Error('protected port'); return p;
}
async function server(script,extra) {
 const c=launch(process.execPath,[path.join(import.meta.dirname,script)],extra);
 let text=''; const deadline=Date.now()+10000;
 c.stdout.on('data',d=>{text=(text+d).slice(-2000)});
 while(!/PORT (\d+)/.test(text)) {if(c.exitCode!==null||Date.now()>deadline) throw Error('upstream startup failed'); await sleep(20)}
 return +text.match(/PORT (\d+)/)[1];
}
async function command(exe,args,extra={}) {
 const c=launch(exe,args,extra); c.stdout.on('data',()=>{});
 const [code]=await once(c,'exit'); if(code!==0) throw Error('command failed: '+path.basename(exe)+' '+args[0]+' exit '+code);
}
async function post(p,key,model) {
 const body=JSON.stringify({model,stream:true,messages:[{role:'user',content:'benchmark sentinel'}]});
 const t=performance.now();
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:p,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
   const headersMs=performance.now()-t; let text=''; let first=null;
   res.on('data',c=>{first??=performance.now()-t;text+=c;if(text.length>65536) req.destroy(Error('response bound exceeded'))});
   res.on('error',reject); res.on('end',()=>{
    try {if(res.statusCode!==200) throw Error('HTTP '+res.statusCode);validateSse(text);resolve({headersMs,firstByteMs:first,totalMs:performance.now()-t,clientBodyBytes:Buffer.byteLength(body)})}catch(e){reject(e)}
   });
  }); req.setTimeout(15000,()=>req.destroy(Error('request timeout')));req.on('error',reject);req.end(body);
 });
}
try {
 if (['.env','.env.local','.env.production','.env.production.local'].some(name => fs.existsSync(path.join(root,name)))) throw Error('isolation preflight: Next would load repository env files; use an env-free source checkout');
 // Explicit dedicated build; no stale standalone artifact and no modification of normal .next.
 const dist=path.join(temp,'next-build');
 await command(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'build','--webpack'],{NEXT_DIST_DIR:dist});
 result.buildId=fs.readFileSync(path.join(dist,'BUILD_ID'),'utf8').trim();
 const upstream=await server('upstream.mjs',{});
 const config=path.join(temp,'seed.json'); const keys=path.join(temp,'keys.json');
 fs.writeFileSync(config,JSON.stringify({upstreams:{bench:'http://127.0.0.1:'+upstream+'/v1'}}));
 await command(process.execPath,['--no-warnings','--loader',path.join(root,'scripts/benchmark-loader.mjs'),path.join(import.meta.dirname,'seed.mjs'),config,keys]);
 const {key}=JSON.parse(fs.readFileSync(keys,'utf8'));
 result.bun=JSON.parse(execFileSync(bun,['-e','console.log(JSON.stringify({version:Bun.version,revision:Bun.revision,executable:process.execPath}))'],{env,encoding:'utf8'}));
 for(const runtime of ['bun','node']) {
  const p=await port();
  const c=launch(runtime==='bun'?bun:process.execPath,[path.join(root,'custom-server.js'),'--port',String(p),'--hostname','127.0.0.1'],{PORT:String(p),NEXT_DIST_DIR:dist});
  c.stdout.on('data',()=>{});
  let ready=false;
  for(let i=0;i<100;i++) {try {await post(p,key,'bench/benchmark-model');ready=true;break}catch{} if(c.exitCode!==null)break;await sleep(200)}
  if(!ready)throw Error(runtime+' gateway startup/route validation failed');
  for(let i=0;i<3;i++)await post(p,key,'bench/benchmark-model');
  const samples=[];for(let i=0;i<10;i++)samples.push(await post(p,key,'bench/benchmark-model'));
  result.rows.push({runtime,policy:'default',upstream:'http',proxy:false,samples,ttft:summary(samples.map(x=>x.firstByteMs))});
  c.kill('SIGTERM');await once(c,'exit');
 }
 result.status='smoke-only';
} catch(e) {result.error=e.message;process.exitCode=1}
finally {
 for(const c of children)if(c.exitCode===null&&!c.signalCode)c.kill('SIGTERM');
 await sleep(500);
 for(const c of children)if(c.exitCode===null&&!c.signalCode)c.kill('SIGKILL');
 fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
 fs.rmSync(temp,{recursive:true,force:true});
 console.log(JSON.stringify({status:result.status,error:result.error,output}));
}
