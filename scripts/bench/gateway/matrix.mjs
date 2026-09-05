// All modes share one build, fixed Node client/helpers, balanced seeded blocks.
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import * as H from './harness.mjs';
import {small, identity, verifyRequests, requireClean, verifyTelemetry} from './contracts.mjs';
export const MIXED_BYTES=[2*1048576,300*1024,2*1048576,700*1024,Math.round(1.3*1048576)];
export function candidateEnv({candidateSpacing,candidateThreshold}) {
  const env={};
  for(const [key,value] of [['TRAFFIC_PACING_SPACING_MS',candidateSpacing],['TRAFFIC_PACING_THRESHOLD',candidateThreshold]]) {
    if(value==null) continue;
    assert(value!==''&&Number.isFinite(Number(value))&&Number(value)>=0,'invalid candidate '+key); env[key]=String(value);
  }
  return env;
}
export function cellsFor(mode) {
  const cells = [];
  const add = (name, n, env = {}, extra = {}) => cells.push({name,n,env,heavyTls:true,victimTls:true,...extra});
  if (mode === 'spacing' || mode === 'protection') for(const p of ['OFF',10,15,20]) add(String(p),8,p==='OFF'?{TRAFFIC_PACER:'off'}:{TRAFFIC_PACING_SPACING_MS:String(p)},{probes:100,repeated:mode==='protection'});
  else if(mode === 'tls') for(const heavyTls of [false,true]) for(const victimTls of [false,true]) add(heavyTls+'/'+victimTls,8,{}, {heavyTls,victimTls,probes:100});
  else if(mode === 'prepare') for(const n of [1,4,8,16]) for(const p of ['on','off']) add(p+'/'+n,n,{TRAFFIC_PREPARE_YIELD:p});
  else if(mode === 'encoding') for(const n of [1,4,8]) for(const p of ['string','buffer']) add(p+'/'+n,n,{TRAFFIC_BODY_ENCODING:p});
  else if(mode === 'upload' || mode === 'backlog') for(const n of mode==='upload'?[1,2,4,8,16]:[8,16,25,50]) for(const p of ['off','fixed']) add(p+'/'+n,n,p==='off'?{TRAFFIC_PACER:'off'}:{});
  else if(mode === 'threshold') for(const threshold of [128,256,512].map(n=>n*1024)) for(const bytes of [threshold-1,threshold,threshold+1,65536,786432,1048576,Math.round(1.7*1048576)]) add(threshold+'/'+bytes,8,{TRAFFIC_PACING_THRESHOLD:String(threshold)},{bytes});
  else if(mode === 'mixed') for(const p of ['off','fixed','bytes:8:5:15']) add(p,5,{TRAFFIC_PACER:p},{mixed:true});
  else if(mode === 'sustained') add('direct+CONNECT',8,{}, {sustained:true,heavyTls:true});
  else throw Error('unknown mode '+mode);
  return cells;
}
export function sizedMessages(bytes) {
  const messages = [{role:'user',content:''}];
  const overhead=identity(messages).bytes;
  assert(bytes>=overhead); messages[0].content='x'.repeat(bytes-overhead);
  assert.equal(identity(messages).bytes,bytes); return messages;
}
export async function run(mode=process.env.MODE || 'spacing') {
  const candidateSpacing=process.env.CANDIDATE_SPACING_MS || process.env.TRAFFIC_PACING_SPACING_MS || null;
  const candidateThreshold=process.env.CANDIDATE_THRESHOLD_BYTES || process.env.TRAFFIC_PACING_THRESHOLD || null;
  const repetitions=Number(process.env.RUNS || 5), seed=Number(process.env.SEED || 42);
  assert(Number.isInteger(repetitions)&&repetitions>=5,'minimum five balanced repetitions');
  const runtimes=(process.env.RUNTIMES || 'bun').split(',');
  assert(runtimes.every(r=>['bun','node'].includes(r)));
  const result={schema:2,mode,repetitions,seed,runtimes,status:'incomplete',scope:'FULL GATEWAY',rows:[],order:[]};
  try {
    const h=await H.prepare(); result.provenance={...h.sigs,buildId:h.buildId,bun:await H.bunInfo(h)};
    const cert=await H.makeCert(h), proxy=await H.proxyServer(h);
    const ups={};
    for(const name of ['hp','ht','vp','vt']) ups[name]=await H.upstreamServer(h,name.endsWith('t')?{UPSTREAM_TLS:'1',UPSTREAM_KEY:cert.keyP,UPSTREAM_CERT:cert.certP}:{});
    const upstreams=Object.fromEntries(Object.entries(ups).map(([name,u])=>['bench-'+name,(name.endsWith('t')?'https':'http')+'://127.0.0.1:'+u.port+'/v1']));
    upstreams['bench-proxy']=upstreams['bench-ht'];
    const key=await H.seedOnce(h,{upstreams,proxy:'http://127.0.0.1:'+proxy.port,proxiedPrefixes:['bench-proxy']});
    const heavy=H.heavyFixture(); result.fixture=identity(heavy);
    const histories=mode==='sustained'?H.historyFixtures():[];
    result.histories=histories.map(p=>({label:p.label,checkpoints:p.checkpoints.map(identity)}));
    const random=H.rng(seed);
    for(let rep=0;rep<repetitions;rep++) for(const cell of H.shuffled(cellsFor(mode),random)) for(const runtime of H.shuffled(runtimes,random)) {
      result.order.push({rep,cell:cell.name,runtime});
      const row={rep,cell:cell.name,runtime,samples:[],errors:0,verified:false}; result.rows.push(row);
      const baseEnv=candidateEnv({candidateSpacing,candidateThreshold});
      const g=await H.launchGateway(h,{runtime,extraEnv:{...baseEnv,...cell.env},trust:cert.trustEnv});
      row.candidateEnv=baseEnv;
      const post=H.postFn(g.port,key,h);
      const hn=cell.heavyTls?'ht':'hp',vn=cell.victimTls?'vt':'vp';
      const model=n=>'bench-'+n+'/benchmark-model';
      const messages=cell.bytes?sizedMessages(cell.bytes):heavy;
      const heavyBodies=Array.from({length:cell.n},(_,i)=>cell.mixed?sizedMessages(MIXED_BYTES[i]):messages);
      const expected={hp:[],ht:[],vp:[],vt:[]};
      let active=0,t0;
      const request=async (name,body,kind,scheduledOffsetMs=0, labels={}) => {
        const offsetMs=performance.now()-t0, exposure=active;
        const s={...labels,kind,scheduledOffsetMs,offsetMs,schedulingDelayMs:offsetMs-scheduledOffsetMs,heaviesInFlightAtDispatch:exposure};
        expected[name==='proxy'?'ht':name].push(body);
        if(kind==='heavy')active++;
        try {Object.assign(s,await post(model(name),body));} catch(e){s.error=String(e.message);row.errors++;}
        finally {if(kind==='heavy')active--;s.endOffsetMs=performance.now()-t0;s.heaviesInFlightAtCompletion=active;row.samples.push(s);}
      };
      try {
        await H.waitReady(post,g.child,model(vn));
        // Warm both paths at measured concurrency, then drain/reset outside measurement.
        await Promise.all(heavyBodies.map(body=>post(model(hn),body)));
        await post(model(vn),small);
        if(cell.sustained) await post(model('proxy'),messages);
        await sleep(1000);
        for(const [name,u] of Object.entries(ups)) await H.okFn(u.port,'/__reset',name.endsWith('t'));
        await H.okFn(proxy.port,'/__window');
        row.proxyStart=await H.getFn(proxy.port,'/__stats');
        row.resourcesStart={fd:H.fdInventory(g.child.pid),sockets:H.socketStates(g.child.pid)};
        await g.control('start'); t0=performance.now();
        if(cell.sustained) {
          const deadline=t0+75000; let index=0;
          await Promise.all(Array.from({length:8},async()=>{while(performance.now()<deadline){
            const i=index++, project=histories[i%histories.length];
            const checkpoint=Math.min(3,Math.floor((performance.now()-t0)/18750));
            const body=i%5?small:project.checkpoints[checkpoint];
            await request(i%2?'proxy':hn,body,i%5?'small':'heavy',performance.now()-t0,{project:project.label,checkpoint});
          }}));
        } else if(cell.repeated) {
          for(let i=0;i<100;i++) await Promise.all([...heavyBodies.map(body=>request(hn,body,'heavy',performance.now()-t0)),request(vn,small,'victim',performance.now()-t0)]);
        } else {
          const tasks=heavyBodies.map((body,launchIndex)=>request(hn,body,'heavy',0,{launchIndex}));
          // Explicit ONE eight-heavy burst; retain all 100 independently scheduled probes.
          for(let i=0;i<(cell.probes||0);i++) tasks.push((async()=>{const at=i*5;await sleep(Math.max(0,t0+at-performance.now()));await request(vn,small,'victim',at);})());
          await Promise.all(tasks);
        }
        row.wallMs=performance.now()-t0; row.telemetry=await g.control('stop');
        if(cell.sustained) {
          const stop=performance.now(); row.settle=[];
          for(const seconds of [0,3,10,30,60]) {await sleep(Math.max(0,stop+seconds*1000-performance.now()));row.settle.push({seconds,actualMs:performance.now()-stop,fd:H.fdInventory(g.child.pid),sockets:H.socketStates(g.child.pid),proxy:await H.getFn(proxy.port,'/__stats')});}
        }
        verifyTelemetry(row.telemetry,Object.values(expected).flat(),{...baseEnv,...cell.env});
        if(cell.sustained) assert(row.telemetry.fdSamples.length>=2,'missing sustained FD samples');
        row.verification={};
        for(const [name,u] of Object.entries(ups)) row.verification[name]=verifyRequests(await H.getFn(u.port,'/__stats',name.endsWith('t')),expected[name]);
        if(cell.probes) assert.equal(row.samples.filter(s=>s.kind==='victim').length,100);
        assert.equal(row.errors,0,'request failures'); row.verified=true;
        const victims=row.samples.filter(s=>s.kind==='victim');
        row.victimAllMs=victims.map(s=>s.firstByteMs); row.victimLoadedMs=victims.filter(s=>s.heaviesInFlightAtDispatch>0).map(s=>s.firstByteMs);

      } catch(e) {row.error=String(e.message);row.verified=false;}
      finally {await H.killChild(g.child);}
    }
    requireClean(result.rows); result.status='measured';
  } catch(e) {result.error=String(e.message);process.exitCode=1;}
  await H.finish(result,process.env.BENCH_OUTPUT || '/tmp/gateway-'+mode+'.json');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await run();
