// Node orchestrator/client/upstreams fixed; only actual Next gateway runtime varies.
// Plain-vs-TLS upstream x bun/node gateway matrix: ONE build, four cells.
// Client->gateway stays HTTP; gateway->upstream scheme varies by seeded prefix.
// Ephemeral self-signed cert; identical trust env injected into every cell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {validateSse, summary} from './validate.mjs';
import {runSmallC1, runHeavySingle, runHeavyConcurrent, runFanoutBurst, runVictimProbes} from './scenarios.mjs';
import {loadSessionMessages, buildCheckpoints} from '../mux-fixtures.mjs';
const sourceRoot=path.resolve(import.meta.dirname,'../../..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'9r-http-bench-'));
// Private (0600) artifact dir that survives temp teardown, for validator-failure raw SSE.
const artifactDir=fs.mkdtempSync(path.join(os.tmpdir(),'9r-gateway-artifact-'));
const root=path.join(temp,'source');
fs.mkdirSync(root);
for(const name of execFileSync('git',['ls-files','-z'],{cwd:sourceRoot,encoding:'utf8'}).split('\0').filter(Boolean)) {
 if(name.split('/').some(p=>p==='.env'||p.startsWith('.env.')))continue;
 const from=path.join(sourceRoot,name);if(!fs.statSync(from).isFile())continue;
 const to=path.join(root,name);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
}
fs.symlinkSync(path.join(sourceRoot,'node_modules'),path.join(root,'node_modules'),'dir');
const children=[];
const output=path.resolve(process.env.TLS_OUTPUT || '/tmp/m4-tls-matrix.json');
const bun=process.env.BUN_BIN || path.join(os.homedir(),'.bun/bin/bun');
const result={schema:1,status:'incomplete',rows:[],client:{executable:process.execPath,version:process.version}};
// Do not inherit host secrets, proxy settings, HOME state, or repo .env contents.
const env={PATH:process.env.PATH,HOME:temp,DATA_DIR:temp,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',JWT_SECRET:'benchmark-local-only',API_KEY_SECRET:'benchmark-local-only',MACHINE_ID_SALT:'benchmark-local-only'};
fs.writeFileSync(path.join(temp,'.gateway-benchmark'),'1');
function launch(exe,args,extra={}) {
 const child=spawn(exe,args,{cwd:root,env:{...env,...extra},stdio:['ignore','pipe','pipe']});
 children.push(child); child.stderr.on('data',d=>{child.errorTail=((child.errorTail||'')+d).slice(-3000)}); return child;
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
 const [code]=await once(c,'exit'); if(code!==0) throw Error('command failed: '+path.basename(exe)+' '+args[0]+' exit '+code+' '+c.errorTail);
}
function get(port,p) {return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:p},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve(JSON.parse(b))}catch(e){reject(e)}})}).on('error',reject)})}
function ok(port,p) {return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:p},res=>{res.resume();res.on('end',resolve)}).on('error',reject)})}
async function post(p,key,model,messages) {
 const body=JSON.stringify({model,stream:true,messages:messages||[{role:'user',content:'benchmark sentinel'}]});
 const t=performance.now();
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:p,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
   const headersMs=performance.now()-t; let text=''; let first=null;
   res.on('data',c=>{first??=performance.now()-t;text+=c;if(text.length>65536) req.destroy(Error('response bound exceeded'))});
   res.on('error',reject); res.on('end',()=>{
    try {if(res.statusCode!==200) throw Error('HTTP '+res.statusCode+' '+text.slice(0,300));validateSse(text);resolve({headersMs,firstByteMs:first,totalMs:performance.now()-t,clientBodyBytes:Buffer.byteLength(body),upstreamReceivedBytes:Number(res.headers['x-received-bytes']||0),doneVisible:text.includes('[DONE]')})}catch(e){
     // Preserve bounded raw SSE + ordering facts for validator failures; never bypass the check.
     try {
      const artifact=path.join(artifactDir,'sse-validation-failure.txt');
      fs.writeFileSync(artifact,text.slice(0,65536),{mode:0o600});
      const lines=text.split('\n').filter(l=>l.startsWith('data:'));
      const ordering={dataLines:lines.length,first:[lines[0],lines[1]],last:lines.slice(-3),donePosition:lines.indexOf('data: [DONE]')};
      e.message+=' | sseArtifact='+artifact+' | ordering='+JSON.stringify(ordering);
     } catch {}
     reject(e);
    }
   });
  }); req.setTimeout(15000,()=>req.destroy(Error('request timeout')));req.on('error',reject);req.end(body);
 });
}
try {
 if (['.env','.env.local','.env.production','.env.production.local'].some(name => fs.existsSync(path.join(root,name)))) throw Error('isolation preflight: Next would load repository env files; use an env-free source checkout');
 // Explicit dedicated build; no stale standalone artifact and no modification of normal .next.
 const dist=path.join(root,'.next');
 await command(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'build','--webpack'],{NEXT_DIST_DIR:'.next'});
 result.buildId=fs.readFileSync(path.join(dist,'BUILD_ID'),'utf8').trim();
 const certDir=fs.mkdtempSync(path.join(os.tmpdir(),'9r-tls-cert-'));
 const certP=path.join(certDir,'cert.pem');
 const keyP=path.join(certDir,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyP,'-out',certP,'-days','2','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
 result.cert={subject:'/CN=127.0.0.1',san:'IP:127.0.0.1',days:2,ephemeral:true,equalTrust:true};
 const plainPort=await server('upstream.mjs',{});
 const tlsPort=await server('upstream.mjs',{UPSTREAM_TLS:'1',UPSTREAM_KEY:keyP,UPSTREAM_CERT:certP});
 const config=path.join(temp,'seed.json'); const keys=path.join(temp,'keys.json');
 fs.writeFileSync(config,JSON.stringify({upstreams:{'bench-plain':'http://127.0.0.1:'+plainPort+'/v1','bench-tls':'https://127.0.0.1:'+tlsPort+'/v1'}}));
 await command(process.execPath,['--no-warnings','--loader',path.join(root,'scripts/benchmark-loader.mjs'),path.join(root,'scripts/bench/gateway/seed.mjs'),config,keys]);
 const {key}=JSON.parse(fs.readFileSync(keys,'utf8'));
 result.bun=JSON.parse(execFileSync(bun,['-e','console.log(JSON.stringify({version:Bun.version,revision:Bun.revision,executable:process.execPath}))'],{env,encoding:'utf8'}));
 const trustEnv={NODE_EXTRA_CA_CERTS:certP,NODE_TLS_REJECT_UNAUTHORIZED:'0'};
 const [heavyBody]=buildCheckpoints(loadSessionMessages(path.join(os.homedir(),'.mux/sessions/e8cf0d0b8f/chat.jsonl')),[300000]);
 const matrix=[['http','bun'],['http','node'],['https','bun'],['https','node']];
 for(const [scheme,runtime] of matrix) {
  const prefix=scheme==='https'?'bench-tls':'bench-plain';
  const model=prefix+'/benchmark-model';
  const upPort=scheme==='https'?tlsPort:plainPort;
  const p=await port();
  const c=launch(runtime==='bun'?bun:process.execPath,[path.join(root,'custom-server.js'),'--port',String(p),'--hostname','127.0.0.1'],{PORT:String(p),NEXT_DIST_DIR:'.next',...trustEnv});
  c.stdout.on('data',()=>{});
  let conc=null; let vic=null; let cellError=null;
  try {
   let ready=false;let lastError;
   for(let i=0;i<100;i++) {try {await post(p,key,model);ready=true;break}catch(e){lastError=e.message} if(c.exitCode!==null)break;await sleep(200)}
   if(!ready)throw Error(runtime+' gateway startup/route validation failed '+lastError+' '+c.errorTail);
   const ctx={key,model,heavyMessages:heavyBody.messages,summary,post:(m,messages)=>post(p,key,m,messages),get:(q)=>get(upPort,q),reset:()=>ok(upPort,'/__reset')};
   for(let i=0;i<3;i++)await post(p,key,model);
   conc=await runHeavyConcurrent(ctx,8);
   vic=await runVictimProbes(ctx,[8],100,1);
  } catch(e) {cellError=String(e&&e.message||e)}
  result.rows.push({cell:scheme+'/'+runtime,scheme,runtime,gatewayEnv:Object.keys(trustEnv),conc,vic,error:cellError,runtimeIdentity:{bun:result.bun,buildId:result.buildId,client:result.client}});
  c.kill('SIGTERM');await once(c,'exit');
 }
 result.status='tls-matrix-measured';
} catch(e) {result.error=e.message;process.exitCode=1}
finally {
 for(const c of children)if(c.exitCode===null&&!c.signalCode)c.kill('SIGTERM');
 await sleep(500);
 for(const c of children)if(c.exitCode===null&&!c.signalCode)c.kill('SIGKILL');
 fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
 fs.rmSync(temp,{recursive:true,force:true});
 console.log(JSON.stringify({status:result.status,error:result.error,output}));
}
