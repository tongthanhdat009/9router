import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canon} from './scenarios.mjs';
export const small = [{role: 'user', content: 'benchmark sentinel'}];
export function identity(messages = small) {
  const body = {model: 'benchmark-model', stream: true, messages};
  return {bytes: Buffer.byteLength(JSON.stringify(body)), hash: createHash('sha256').update(canon(body)).digest('hex')};
}
export function verifyRequests(stats, messages) {
  const expected = {};
  for (const m of messages) { const i = identity(m); const key = i.bytes + ':' + i.hash; expected[key] = (expected[key] || 0) + 1; }
  assert.equal(stats.requests, messages.length, 'upstream request count');
  assert.equal(stats.aborted, 0, 'upstream aborts');
  assert.equal(stats.dropped || 0, 0, 'upstream evidence overflow');
  assert.equal(stats.bytesReceived, messages.reduce((n, m) => n + identity(m).bytes, 0), 'upstream bytes');
  assert.deepEqual(stats.identities, expected, 'all-request byte/hash multiset');
  return {verified: true, requests: stats.requests, bytes: stats.bytesReceived, identities: stats.identities};
}
export function requireClean(rows) {
  assert(rows.length > 0, 'no rows');
  assert(rows.every(r => !r.error && !r.errors && r.verified === true), 'failed or unverified rows');
}
