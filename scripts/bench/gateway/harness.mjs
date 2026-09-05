// Isolated one-build full-gateway harness; production source never patched in place.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {validateSse, summary} from './validate.mjs';
import {loadSessionMessages, buildCheckpoints} from '../mux-fixtures.mjs';

const sourceRoot = path.resolve(import.meta.dirname, '../../..');
export const bunBin = process.env.BUN_BIN || path.join(os.homedir(), '.bun/bin/bun');
const children = [];
const BUILD_RELEVANT = /^(open-sse\/|src\/|package\.json$|jsconfig\.json$|next\.config\.mjs$|custom-server\.js$)/;

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffled(arr, rand) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const tmp = a[i]; a[i] = a[j]; a[j] = tmp; } return a; }
export function pct(arr, p) { if (!arr || !arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))]; }
export function median(arr) { return pct(arr, 50); }
export function stats3(arr) { if (!arr || !arr.length) return null; return { median: median(arr), min: Math.min(...arr), max: Math.max(...arr), p25: pct(arr, 25), p75: pct(arr, 75), values: arr }; }

function gitOut(args) { return execFileSync('git', args, {cwd: sourceRoot, encoding: 'utf8'}); }
function hashFile(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } }
function computeSigs() {
  const head = gitOut(['rev-parse', 'HEAD']).trim();
  const lines = gitOut(['status', '--porcelain']).split('\n').filter(Boolean);
  const untracked = gitOut(['ls-files', '--others', '--exclude-standard', '--', 'scripts/bench', 'open-sse/scheduling']).split('\n').filter(Boolean);
  const changed = lines.map(l => l.slice(3).trim()).concat(untracked);
  const srcSet = new Set(changed.filter(p => BUILD_RELEVANT.test(p)));
  const allSet = new Set(changed.concat(untracked));
  const h = crypto.createHash('sha256');
  for (const p of [...allSet].sort()) h.update(p + '=' + hashFile(path.join(sourceRoot, p)) + '\n');
  const hb = crypto.createHash('sha256').update(head + '\n');
  for (const p of [...srcSet].sort()) hb.update(p + '=' + hashFile(path.join(sourceRoot, p)) + '\n');
  const dirtyFiles = Object.fromEntries([...allSet].sort().map(p => [p, hashFile(path.join(sourceRoot, p))]));
  const deps = Object.fromEntries(['package-lock.json','bun.lock','node_modules/.package-lock.json'].map(p => [p, hashFile(path.join(sourceRoot,p))]));
  hb.update(JSON.stringify(deps)).update(hashFile(path.join(import.meta.dirname,'harness.mjs')));
  return {head, dirtyFiles, deps, dirtyPatchSha256: crypto.createHash('sha256').update(gitOut(['diff','HEAD','--binary'])).digest('hex'), sourceSig: h.digest('hex'), buildSig: hb.digest('hex'), node: {version:process.version, executable:process.execPath, sha256:hashFile(process.execPath)}, bunExecutableSha256:hashFile(bunBin)};
}

function copySource(root) {
  fs.mkdirSync(root, {recursive: true});
  const names = gitOut(['ls-files', '-z']).split('\0').filter(Boolean)
    .concat(gitOut(['ls-files', '--others', '--exclude-standard', '-z', '--', 'scripts/bench', 'open-sse/scheduling']).split('\0').filter(Boolean));
  for (const name of names) {
    if (name.split('/').some(p => p === '.env' || p.startsWith('.env.'))) continue;
    const from = path.join(sourceRoot, name);
    if (!fs.statSync(from, {throwIfNoEntry: false})?.isFile()) continue;
    const to = path.join(root, name);
    fs.mkdirSync(path.dirname(to), {recursive: true});
    fs.copyFileSync(from, to);
  }
  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(sourceRoot, 'node_modules'), nm, 'dir');
}

export async function prepare() {
  const sigs = computeSigs();
  const persistent = process.env.BENCH_ROOT ? path.resolve(process.env.BENCH_ROOT) : null;
  if (persistent && (persistent === sourceRoot || persistent.startsWith(sourceRoot + path.sep) || sourceRoot.startsWith(persistent + path.sep))) throw Error('BENCH_ROOT must be outside source checkout');
  if (persistent && fs.existsSync(persistent) && fs.readdirSync(persistent).length && !fs.existsSync(path.join(persistent,'.bench-build.json'))) throw Error('nonempty BENCH_ROOT lacks benchmark marker');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '9r-http-bench-'));
  const dataDir = path.join(temp, 'data'); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, '.gateway-benchmark'), '1');
  const artifactDir = path.join(temp, 'artifacts'); fs.mkdirSync(artifactDir, {mode: 0o700});
  let root = persistent || path.join(temp, 'source');
  let buildId = null;
  let marker = null;
  if (persistent) {
    const mp = path.join(root, '.bench-build.json');
    if (fs.existsSync(mp)) { try { marker = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch {} }
  }
  const needBuild = !marker || marker.buildSig !== sigs.buildSig;
  const needCopy = needBuild || !marker || marker.sourceSig !== sigs.sourceSig;
  if (needCopy) {
    copySource(root);
    const scheduler = path.join(root, 'open-sse/scheduling/trafficScheduler.js');
    let source = fs.readFileSync(scheduler, 'utf8');
    const start = source.indexOf('// ---- benchmark instrumentation');
    const end = source.indexOf('// Pre-serialization');
    if (start >= 0 && end > start) source = source.slice(0,start) + source.slice(end);
    source = source.replace('  if (LAG_PATH) ensureLagSampler();\n', '');
    source = source.replace('recordAdmission({', 'globalThis.__gatewayBenchAdmission?.({');
    fs.writeFileSync(scheduler, source);
    if (!source.includes('__gatewayBenchAdmission')) {
      source = source.replace('    nextAdmissionAt = scheduledAt + spacing;', '    nextAdmissionAt = scheduledAt + spacing;\n    globalThis.__gatewayBenchAdmission?.({t:now,actualBytes,waitMs:Math.max(0,scheduledAt-now),spacing});');
      fs.writeFileSync(scheduler,source);
    }
    const base = path.join(root,'open-sse/executors/base.js');
    let bodySource = fs.readFileSync(base,'utf8');
    if(!bodySource.includes('TRAFFIC_BODY_ENCODING')) bodySource=bodySource.replace('body: bodyStr,','body: process.env.TRAFFIC_BODY_ENCODING === "buffer" ? Buffer.from(bodyStr,"utf8") : bodyStr,');
    fs.writeFileSync(base,bodySource);
    sigs.controlledBaseSha256=hashFile(base);
    sigs.controlledSchedulerSha256 = hashFile(scheduler);
  } else { sigs.controlledSchedulerSha256 = marker.controlledSchedulerSha256; sigs.controlledBaseSha256 = marker.controlledBaseSha256; }
  if (needBuild) fs.rmSync(path.join(root, '.next'), {recursive: true, force: true});
  if (['.env', '.env.local', '.env.production', '.env.production.local'].some(n => fs.existsSync(path.join(root, n))))
    throw Error('isolation preflight: env file present in benchmark source root');
  const env = {PATH: process.env.PATH, HOME: temp, DATA_DIR: dataDir, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', JWT_SECRET: 'benchmark-local-only', API_KEY_SECRET: 'benchmark-local-only', MACHINE_ID_SALT: 'benchmark-local-only'};
  function launch(exe, args, extra = {}) {
    const child = spawn(exe, args, {cwd: root, env: {...env, ...extra}, stdio: ['ignore', 'pipe', 'pipe']});
    children.push(child);
    child.stderr.on('data', d => { child.errorTail = ((child.errorTail || '') + d).slice(-3000); });
    return child;
  }
  async function command(exe, args, extra = {}) {
    const c = launch(exe, args, extra); c.stdout.on('data', () => {});
    const [code] = await once(c, 'exit');
    if (code !== 0) throw Error('command failed: ' + path.basename(exe) + ' ' + (args[0] || '') + ' exit ' + code + ' ' + c.errorTail);
    return c;
  }
  if (needBuild) {
    await command(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {NEXT_DIST_DIR: '.next'});
  }
  buildId = fs.readFileSync(path.join(root, '.next', 'BUILD_ID'), 'utf8').trim();
  if (persistent) fs.writeFileSync(path.join(root, '.bench-build.json'), JSON.stringify({...sigs, buildId, temp: null}, null, 2));
  return {root, temp, dataDir, artifactDir, env, buildId, sigs, launch, command, keepRoot: !!persistent};
}

export async function freePort() {
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const p = s.address().port; await new Promise(r => s.close(r));
  if ([20127, 20128].includes(p)) return freePort();
  return p;
}

export async function serverProcess(h, script, extra = {}) {
  const c = h.launch(process.execPath, [path.join(import.meta.dirname, script)], extra);
  let text = ''; const deadline = Date.now() + 10000;
  c.stdout.on('data', d => { text = (text + d).slice(-2000); });
  while (!/PORT (\d+)/.test(text)) { if (c.exitCode !== null || Date.now() > deadline) throw Error('server startup failed: ' + script + ' ' + c.errorTail); await sleep(20); }
  return {child: c, port: +text.match(/PORT (\d+)/)[1]};
}
export const upstreamServer = (h, extra) => serverProcess(h, 'upstream.mjs', extra);
export const proxyServer = (h) => serverProcess(h, 'proxy.mjs', {});

export async function makeCert(h) {
  const dir = path.join(h.temp, 'cert'); fs.mkdirSync(dir);
  const certP = path.join(dir, 'cert.pem'), keyP = path.join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyP, '-out', certP, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  return {certP, keyP, trustEnv: {NODE_EXTRA_CA_CERTS: certP, NODE_TLS_REJECT_UNAUTHORIZED: '0'}};
}

export async function seedOnce(h, config) {
  const cp = path.join(h.temp, 'seed.json'); const kp = path.join(h.temp, 'keys.json');
  fs.writeFileSync(cp, JSON.stringify(config));
  await h.command(process.execPath, ['--no-warnings', '--loader', path.join(h.root, 'scripts/benchmark-loader.mjs'), path.join(h.root, 'scripts/bench/gateway/seed.mjs'), cp, kp]);
  return JSON.parse(fs.readFileSync(kp, 'utf8')).key;
}

export async function bunInfo(h) {
  try { return JSON.parse(execFileSync(bunBin, ['-e', 'console.log(JSON.stringify({version:Bun.version,revision:Bun.revision,executable:process.execPath}))'], {env: h.env, encoding: 'utf8'})); } catch (e) { return {error: String(e.message)}; }
}

export function getFn(port, p, tls) {
  const mod = tls ? https : http; const extra = tls ? {rejectUnauthorized: false} : {};
  return new Promise((resolve, reject) => { mod.get({host: '127.0.0.1', port, path: p, ...extra}, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject); });
}
export function okFn(port, p, tls) {
  const mod = tls ? https : http; const extra = tls ? {rejectUnauthorized: false} : {};
  return new Promise((resolve, reject) => { mod.get({host: '127.0.0.1', port, path: p, ...extra}, res => { res.resume(); res.on('end', resolve); }).on('error', reject); });
}

export function postFn(port, key, h) {
  return (model, messages) => {
    const body = JSON.stringify({model, stream: true, messages: messages || [{role: 'user', content: 'benchmark sentinel'}]});
    const t = performance.now();
    return new Promise((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: {authorization: 'Bearer ' + key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}}, res => {
        const headersMs = performance.now() - t;
        let text = ''; let first = null;
        res.on('data', c => { first ??= performance.now() - t; text += c; if (text.length > 65536) req.destroy(Error('response bound exceeded')); });
        res.on('error', reject);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw Error('HTTP ' + res.statusCode + ' ' + text.slice(0, 300));
            validateSse(text);
            const events = text.split('\n').filter(l=>l.startsWith('data:')&&!l.includes('[DONE]')).map(l=>JSON.parse(l.slice(5)));
            if (events.map(e=>e.choices?.[0]?.delta?.content || '').join('') !== 'x'.repeat(512)) throw Error('SSE content mismatch');
            resolve({headersMs, firstByteMs: first, totalMs: performance.now() - t, clientBodyBytes: Buffer.byteLength(body), doneVisible: text.includes('[DONE]')});
          } catch (e) {
            try {
              const artifact = path.join(h.artifactDir, 'sse-validation-failure.txt');
              fs.writeFileSync(artifact, text.slice(0, 65536), {mode: 0o600});
              const lines = text.split('\n').filter(l => l.startsWith('data:'));
              e.message += ' | sseArtifact=' + artifact + ' | ordering=' + JSON.stringify({dataLines: lines.length, last: lines.slice(-3), donePosition: lines.indexOf('data: [DONE]')});
            } catch {}
            reject(e);
          }
        });
      });
      req.setTimeout(15000, () => req.destroy(Error('request timeout')));
      req.on('error', reject); req.end(body);
    });
  };
}

export async function launchGateway(h, {runtime = 'bun', extraEnv = {}, trust = null, statsFile = null, lagFile = null}) {
  const port = await freePort();
  const env = {PORT: String(port), NEXT_DIST_DIR: '.next', ...extraEnv, ...(trust || {})};
  if (statsFile) { env.TRAFFIC_STATS_FILE = statsFile; fs.rmSync(statsFile, {force: true}); }
  if (lagFile) { env.BENCH_LAG_FILE = lagFile; fs.rmSync(lagFile, {force: true}); }
  const exe = runtime === 'bun' ? bunBin : process.execPath;
  const controlPort = await freePort();
  const token = crypto.randomUUID();
  env.BENCH_CONTROL_PORT = String(controlPort); env.BENCH_CONTROL_TOKEN = token;
  delete env.TRAFFIC_STATS_FILE; delete env.BENCH_LAG_FILE;
  const child = h.launch(exe, ['--import', path.join(h.root, 'scripts/bench/gateway/telemetry.mjs'), path.join(h.root, 'custom-server.js'), '--port', String(port), '--hostname', '127.0.0.1'], env);
  child.stdout.on('data', () => {});
  const control = action => new Promise((resolve,reject) => {
    http.get({host:'127.0.0.1',port:controlPort,path:'/'+action,headers:{authorization:token}}, res => {
      let text=''; res.on('data',d=>text+=d); res.on('end',()=>{ try { if(res.statusCode!==200) throw Error('telemetry '+res.statusCode); resolve(JSON.parse(text)); } catch(e){reject(e);} });
    }).on('error',reject);
  });
  return {child, port, control};
}

export async function waitReady(post, child, model) {
  let lastError = null;
  for (let i = 0; i < 150; i++) {
    try { await post(model); return true; } catch (e) { lastError = e.message; }
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  throw Error('gateway startup failed: ' + lastError + ' ' + (child.errorTail || ''));
}

export async function killChild(c) {
  if (c.exitCode !== null) return;
  c.kill('SIGTERM');
  const timer = setTimeout(() => c.kill('SIGKILL'), 5000);
  await once(c, 'exit').finally(() => clearTimeout(timer));
}

export function socketStates(pid) {
  try {
    const out = execFileSync('ss', ['-tanp'], {encoding: 'utf8', timeout: 5000});
    const states = {};
    let total = 0;
    for (const line of out.split('\n').slice(1)) {
      if (!line.includes('pid=' + pid + ',')) continue;
      const m = line.match(/^(ESTAB|CLOSE-WAIT|TIME-WAIT|LISTEN|SYN-SENT|FIN-WAIT-?\d|LAST-ACK)\s/);
      const k = m ? m[1] : 'other';
      states[k] = (states[k] || 0) + 1; total++;
    }
    return {total, states};
  } catch (e) { return {error: String(e.message)}; }
}

export function fdInventory(pid) {
  try {
    const out = {total: 0, socket: 0, file: 0, pipe: 0, other: 0, socketsByPeer: {}};
    for (const fd of fs.readdirSync('/proc/' + pid + '/fd')) {
      let target = '';
      try { target = fs.readlinkSync('/proc/' + pid + '/fd/' + fd) || ''; } catch {}
      out.total++;
      if (target.startsWith('socket:')) { out.socket++; const inode = (target.match(/socket:\[(\d+)\]/) || [])[1] || ''; if (inode) out.socketsByPeer['inode:' + inode] = 0; }
      else if (target.startsWith('/')) out.file++;
      else if (target.startsWith('pipe:')) out.pipe++;
      else out.other++;
    }
    return out;
  } catch (e) { return {error: String(e.message)}; }
}

let heavyCache = null;
export function heavyFixture() {
  if (!heavyCache) {
    const [body] = buildCheckpoints(loadSessionMessages(path.join(os.homedir(), '.mux/sessions/e8cf0d0b8f/chat.jsonl')), [300000]);
    heavyCache = body.messages;
  }
  return heavyCache;
}

export async function finish(result, output) {
  result.finishedAt = new Date().toISOString();
  for (const c of children) if (c.exitCode === null && !c.signalCode) c.kill('SIGTERM');
  await sleep(500);
  for (const c of children) if (c.exitCode === null && !c.signalCode) c.kill('SIGKILL');
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({status: result.status, error: result.error || null, output, rows: (result.rows || []).length}));
}
