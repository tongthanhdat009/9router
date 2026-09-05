// Loaded only into the isolated benchmark gateway via --import.
import http from 'node:http';
const cap = 100000;
let state = null, timer;
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
    state = {start, expected: start + 10, admissions: [], lagMs: [], dropped: 0, memPeak: process.memoryUsage(), cpuStart: process.cpuUsage()};
    timer = setTimeout(sample, 10); res.end('{}');
  } else if (req.url === '/stop' && state) {
    clearTimeout(timer);
    const result = {...state, elapsedMs: performance.now() - state.start, cpu: process.cpuUsage(state.cpuStart), memLast: process.memoryUsage()};
    state = null; res.end(JSON.stringify(result));
  } else { res.writeHead(409); res.end('{}'); }
});
server.listen(Number(process.env.BENCH_CONTROL_PORT), '127.0.0.1');
