// All modes share one build, fixed Node client/helpers, balanced seeded blocks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  else if(mode === 'prepare') for(const n of [1,4,8,16]) for(const p of ['on','off']) add(p+'/'+n,n,{TRAFFIC_PREPARE_YIELD:p},{probes:100});
  else if(mode === 'encoding') for(const n of [1,4,8]) for(const p of ['string','buffer']) add(p+'/'+n,n,{TRAFFIC_BODY_ENCODING:p},{probes:100});
  else if(mode === 'upload' || mode === 'backlog') for(const n of mode==='upload'?[1,2,4,8,16]:[8,16,25,50]) for(const p of ['off','fixed']) add(p+'/'+n,n,p==='off'?{TRAFFIC_PACER:'off'}:{},{probes:100});
  else if(mode === 'threshold') {
    // Identical deduplicated size grid for every policy (OFF + 128/256/512): 9 shared sizes (incl. exact 128/256/512 at-points) + each threshold boundary -1/+1.
    const sizes=[...new Set([...[64,128,192,256,384,512,768,1024,1741].map(k=>k*1024),...[128,256,512].flatMap(t=>[t*1024-1,t*1024,t*1024+1])])];
    for(const policy of ['OFF','128','256','512']) for(const bytes of sizes)
      add(policy+'/'+bytes,8,policy==='OFF'?{TRAFFIC_PACER:'off'}:{TRAFFIC_PACING_THRESHOLD:policy*1024+''},{bytes,probes:100});
  }
  else if(mode === 'mixed') for(const p of ['off','fixed','bytes:8:5:15']) add(p,5,{TRAFFIC_PACER:p},{mixed:true,probes:100});
  else if(mode === 'sustained') add('direct+CONNECT',8,{}, {sustained:true,heavyTls:true});
  else if(mode === 'matched-sustained') add('fixed-offer',8,{},{matched:true});
  else throw Error('unknown mode '+mode);
  return cells;
}
// Heavy batch timing from COMPLETED heavies only; errored heavies carry no trustworthy end time.
export function heavyBatchStats(samples) {
  const completed=samples.filter(s=>s.kind==='heavy'&&!s.error);
  if(!completed.length) return {heavyBatchWallMs:null,heavyFirstByteMs:[]};
  return {heavyBatchWallMs:Math.round(Math.max(...completed.map(s=>s.endOffsetMs))*100)/100,heavyFirstByteMs:completed.map(s=>s.firstByteMs)};
}
// Deterministic fixed-offer sustained schedule: identical across runtimes and reps.
// Offer times, roles, proxy flags, and checkpoint selection derive from the SCHEDULED offset
// only (never from completion), so both runtimes receive the same offered workload.
export function matchedSchedule() {
  const windowMs=75000, cadenceMs=40, maxOutstanding=64;
  const items=[];
  for(let i=0;i*cadenceMs<=windowMs;i++) {
    const offsetMs=i*cadenceMs, victim=i%9===0;
    items.push({index:i,offsetMs,projectIndex:i%4,role:victim?'victim':(i%2?'child':'parent'),proxy:!victim&&i%7===0,checkpoint:Math.min(3,Math.floor(offsetMs/18750))});
  }
  return {windowMs,cadenceMs,maxOutstanding,items};
}
// /proc/<pid>/status RSS parser; returns null when absent (refused, never zero-invented).
export function vmRssBytes(statusText) {
  const m=(statusText||'').match(/^VmRSS:\s+(\d+) kB$/m);
  return m?Number(m[1])*1024:null;
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
    const histories=(mode==='sustained'||mode==='matched-sustained')?H.historyFixtures():[];
    result.histories=histories.map(p=>({label:p.label,checkpoints:p.checkpoints.map(identity)}));
    const random=H.rng(seed);
    for(let rep=0;rep<repetitions;rep++) for(const cell of H.shuffled(cellsFor(mode),random)) for(const runtime of H.shuffled(runtimes,random)) {
      result.order.push({rep,cell:cell.name,runtime});
      const row={rep,cell:cell.name,runtime,samples:[],errors:0,verified:false}; result.rows.push(row);
      const baseEnv=candidateEnv({candidateSpacing,candidateThreshold});
      const g=await H.launchGateway(h,{runtime,extraEnv:{...baseEnv,...cell.env},trust:cert.trustEnv});
      if(cell.matched){const st=fs.readFileSync('/proc/'+g.child.pid+'/stat','utf8');row.gatewayPid=g.child.pid;row.gatewayStarttime=st.slice(st.lastIndexOf(')')+2).trim().split(/\s+/)[19];}
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
        if(cell.sustained) row.proxyWarm=await H.getFn(proxy.port,'/__stats');
        // Warm both paths at measured concurrency, then drain/reset outside measurement.
        await Promise.all(heavyBodies.map(body=>post(model(hn),body)));
        await post(model(vn),small);
        if(cell.sustained||cell.matched) await post(model('proxy'),messages);
        await sleep(1000);
        for(const [name,u] of Object.entries(ups)) await H.okFn(u.port,'/__reset',name.endsWith('t'));
        await H.okFn(proxy.port,'/__window');
        row.proxyStart=await H.getFn(proxy.port,'/__stats');
        row.resourcesStart={fd:H.fdInventory(g.child.pid),sockets:H.socketStates(g.child.pid)};
        await g.control('start'); t0=performance.now();
        if(cell.matched) {
          const sched=matchedSchedule();
          row.pairConfig={windowMs:sched.windowMs,cadenceMs:sched.cadenceMs,maxOutstanding:sched.maxOutstanding,offers:sched.items.length,victims:sched.items.filter(i=>i.role==='victim').length};
          let outstanding=0; row.backlogBreaches=[];
          const inflight=[];
          for(const it of sched.items) {
            await sleep(Math.max(0,t0+it.offsetMs-performance.now()));
            if(outstanding>=sched.maxOutstanding){row.backlogBreaches.push({index:it.index,offsetMs:it.offsetMs,outstanding});continue;}
            const project=histories[it.projectIndex%histories.length];
            const body=it.role==='victim'?small:project.checkpoints[it.checkpoint];
            const target=it.role==='victim'?vn:(it.proxy?'proxy':hn);
            outstanding++;
            inflight.push(request(target,body,it.role==='victim'?'victim':it.role,it.offsetMs,{index:it.index,project:project.label,checkpoint:it.checkpoint,proxy:it.proxy,scheduledOffsetMs:it.offsetMs}).finally(()=>{outstanding--;}));
          }
          await Promise.all(inflight);
          row.expectedIdentities={};for(const [name,bodies] of Object.entries(expected))row.expectedIdentities[name]=bodies.map(b=>{const id=identity(b);return id.bytes+':'+id.hash;}).sort();
        } else if(cell.sustained) {
          const deadline=t0+75000; let index=0;
          // Seven mixed-role workers: alternate parent-history (heavy) and child (small) requests across direct/proxy origins.
          const workers=Array.from({length:7},async()=>{while(performance.now()<deadline){
            const i=index++, project=histories[i%histories.length];
            const checkpoint=Math.min(3,Math.floor((performance.now()-t0)/18750));
            const parent=i%2===0, body=parent?project.checkpoints[checkpoint]:small, viaProxy=i%4>=2;
            await request(viaProxy?'proxy':hn,body,parent?'heavy':'small',performance.now()-t0,{role:parent?'parent':'child',project:project.label,checkpoint,proxy:viaProxy});
          }});
          const victim=async()=>{while(performance.now()<deadline){await request(vn,small,'victim',performance.now()-t0,{role:'victim',project:'victim-worker',proxy:false});await sleep(50);}};
          await Promise.all([...workers,victim()]);
        } else if(cell.repeated) {
          for(let i=0;i<100;i++) await Promise.all([...heavyBodies.map(body=>request(hn,body,'heavy',performance.now()-t0)),request(vn,small,'victim',performance.now()-t0)]);
        } else {
          const heavyTasks=heavyBodies.map((body,launchIndex)=>request(hn,body,'heavy',0,{launchIndex}));
          // Explicit ONE eight-heavy burst; retain all 100 independently scheduled probes.
          const probeTasks=[]; for(let i=0;i<(cell.probes||0);i++) probeTasks.push((async()=>{const at=i*5;await sleep(Math.max(0,t0+at-performance.now()));await request(vn,small,'victim',at);})());
          await Promise.all([...heavyTasks,...probeTasks]);
        }
        row.wallMs=performance.now()-t0; row.windowWallMs=row.wallMs;
        // Heavy batch end is distinct from the full probe window so batch throughput is not pinned to probe duration.
        if(!cell.sustained&&!cell.matched) Object.assign(row,heavyBatchStats(row.samples));
        row.telemetry=await g.control('stop');
        if(cell.sustained||cell.matched) {
          const stop=performance.now(); row.settle=[];
          for(const seconds of [0,3,10,30,60]) {await sleep(Math.max(0,stop+seconds*1000-performance.now()));const entry={seconds,actualMs:performance.now()-stop,fd:H.fdInventory(g.child.pid),sockets:H.socketStates(g.child.pid),proxy:await H.getFn(proxy.port,'/__stats')};
            if(cell.matched){const st=fs.readFileSync('/proc/'+g.child.pid+'/stat','utf8');const started=st.slice(st.lastIndexOf(')')+2).trim().split(/\s+/)[19];assert.equal(started,row.gatewayStarttime,'gateway PID reused during settle');entry.rssBytes=vmRssBytes(fs.readFileSync('/proc/'+g.child.pid+'/status','utf8'));assert(entry.rssBytes!=null,'VmRSS unavailable at settle '+seconds+'s');}
            row.settle.push(entry);}
        }
        verifyTelemetry(row.telemetry,Object.values(expected).flat(),{...baseEnv,...cell.env});
        row.verification={};
        for(const [name,u] of Object.entries(ups)) row.verification[name]=verifyRequests(await H.getFn(u.port,'/__stats',name.endsWith('t')),expected[name]);
        if(cell.sustained||cell.matched) {
          assert(row.telemetry.fdSamples.length>=2,'missing sustained FD samples');
          assert(row.samples.some(s=>s.kind==='victim'),'missing sustained victim probes');
          const proxyStop=await H.getFn(proxy.port,'/__stats');
          const warmOrWindow={successes:(row.proxyWarm?.successes||0)+proxyStop.successes,bytes:(row.proxyWarm?.tunneledBytes||0)+proxyStop.tunneledBytes,failures:(row.proxyWarm?.failures||0)+proxyStop.failures};
          const attempts=proxyStop.connects-(row.proxyStart.connects||0), successes=proxyStop.successes-(row.proxyStart.successes||0), failures=proxyStop.failures-(row.proxyStart.failures||0), bytes=proxyStop.tunneledBytes-(row.proxyStart.tunneledBytes||0);
          row.proxyWindow={attempts,successes,failures,bytes,active:proxyStop.tunnelsActive,peak:proxyStop.peak,warmOrWindow};
          assert(warmOrWindow.successes>0,'CONNECT never exercised'); assert(warmOrWindow.bytes>0,'CONNECT never carried bytes'); assert.equal(warmOrWindow.failures,0,'CONNECT failures');
          // Settled active tunnels stay an observation only; persistence behavior is unresolved.
        }
        if(!cell.sustained&&!cell.matched) assert.equal(row.samples.filter(s=>s.kind==='victim').length,100,'burst victim probes');
        if(cell.matched) {
          const sched=matchedSchedule();
          assert.equal(row.backlogBreaches.length,0,'backlog threshold breached (explicit fail, no silent drops): '+JSON.stringify(row.backlogBreaches.slice(0,3)));
          assert.equal(row.samples.length,sched.items.length,'silent drop: samples must equal scheduled offers');
          assert.equal(row.samples.filter(s=>s.kind==='victim').length,sched.items.filter(i=>i.role==='victim').length,'victim count must match schedule');
          assert(row.settle.every(sp=>sp.rssBytes!=null),'settle RSS required for matched rows');
        }
        assert.equal(row.errors,0,'request failures'); row.verified=true;
        const victims=row.samples.filter(s=>s.kind==='victim');
        row.victimAllMs=victims.map(s=>s.firstByteMs); row.victimLoadedMs=victims.filter(s=>s.heaviesInFlightAtDispatch>0).map(s=>s.firstByteMs);

      } catch(e) {row.error=String(e.message);row.verified=false;}
      finally {await H.killChild(g.child);}
    }
    if(mode==='matched-sustained') {
      // Cross-runtime offer identity: every runtime/rep must carry the same expected payload multiset.
      const byRuntime=new Map();
      for(const row of result.rows){const flat=Object.values(row.expectedIdentities||{}).flat();if(!byRuntime.has(row.runtime))byRuntime.set(row.runtime,new Set());byRuntime.get(row.runtime).add(flat.slice().sort().join('|'));}
      const entries=[...byRuntime.entries()];
      for(const [runtime,variants] of entries) assert.equal(variants.size,1,'schedule drift across reps for '+runtime);
      const reference=[...entries[0][1]][0];
      for(const [runtime] of entries.slice(1)) assert([...byRuntime.get(runtime)][0]===reference,'cross-runtime expected payload multiset mismatch: '+runtime);
      result.matchedCheck={multisetEntries:Object.fromEntries(entries.map(([r,v])=>[r,[...v][0].slice(0,80)+'…'])),runtimes:entries.map(([r])=>r)};
    }
    requireClean(result.rows); result.status='measured';
  } catch(e) {result.error=String(e.message);process.exitCode=1;}
  await H.finish(result,process.env.BENCH_OUTPUT || '/tmp/gateway-'+mode+'.json');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await run();
