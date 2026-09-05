// Loaded only into the isolated benchmark gateway via --import.
import http from 'node:http';
import fs from 'node:fs';
const cap = 100000;
let state = null, timer, fdSampler = null;
const push = (array, value) => { if (array.length < cap) array.push(value); else state.dropped++; };
globalThis.__gatewayBenchAdmission = event => { if (state) push(state.admissions, {...event, offsetMs: performance.now() - state.start}); };
function sample() {
  const now = performance.now();
  push(state.lagMs, Math.max(0, now - state.expected));
  const memory = process.memoryUsage();
  for (const k of Object.keys(memory)) state.memPeak[k] = Math.max(state.memPeak[k] || 0, memory[k]);
  state.memLast = memory;
  // Reset every tick: timer clamp and one stall never accumulate lag debt.
  state.expected = performance.now() + 10;
  timer = setTimeout(sample, 10);
}
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== process.env.BENCH_CONTROL_TOKEN) { res.writeHead(403); res.end(); return; }
  if (req.url === '/start' && !state) {
    const start = performance.now();
    state = {start, expected: start + 10, admissions: [], lagMs: [], dropped: 0, fdSamples: [], fdPeak: 0, memPeak: process.memoryUsage(), cpuStart: process.cpuUsage()};
    timer = setTimeout(sample, 10);
    const fdTick = () => {
      try { const total=fs.readdirSync('/proc/'+process.pid+'/fd').length;
        push(state.fdSamples,{offsetMs:performance.now()-state.start,total}); state.fdPeak=Math.max(state.fdPeak,total);
      } catch(e) { state.fdError=String(e.message); }
    };
    fdTick(); fdSampler=setInterval(fdTick,1000);
    res.end('{}');
  } else if (req.url === '/stop' && state) {
    clearTimeout(timer); if (fdSampler) { clearInterval(fdSampler); fdSampler = null; }
    const result = {...state, elapsedMs: performance.now() - state.start, cpu: process.cpuUsage(state.cpuStart), memLast: process.memoryUsage()};
    state = null; res.end(JSON.stringify(result));
  } else { res.writeHead(409); res.end('{}'); }
});
server.listen(Number(process.env.BENCH_CONTROL_PORT), '127.0.0.1');
