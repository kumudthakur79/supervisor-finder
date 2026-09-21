import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker.js';

const sqlite = new DatabaseSync(':memory:');
const db = {
  exec(sql) { sqlite.exec(sql); return Promise.resolve(); },
  prepare(sql) {
    let values = [];
    return {
      bind(...params) { values = params; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: result.changes } }; }
    };
  }
};
const env = { DB: db, AUTH_RATE_SALT: 'test-only-rate-salt', ASSETS: { fetch: () => new Response('asset') } };
const origin = 'https://matcher.example';
async function request(path, method = 'GET', body, cookie, requestOrigin = origin) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers.Origin = requestOrigin;
  if (cookie) headers.Cookie = cookie;
  const response = await worker.fetch(new Request(origin + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
  const setCookies = response.headers.getSetCookie();
  return {
    status: response.status, json: await response.json(),
    cookie: setCookies.find(x => x.startsWith('__Host-sfl_session='))?.split(';')[0],
    previewCookie: setCookies.find(x => x.startsWith('__Host-sfl_preview='))?.split(';')[0],
    setCookies
  };
}
const credential = { username: 'researcher_one', password: 'valid passphrase for tests' };
const second = { username: 'researcher_two', password: 'different passphrase here' };

assert.equal((await request('/api/me')).status, 401);
assert.equal((await request('/api/register', 'POST', credential, null, 'https://attacker.example')).status, 403);
const one = await request('/api/register', 'POST', credential);
assert.equal(one.status, 201);
assert.match(one.cookie, /^__Host-sfl_session=[a-f0-9]{64}$/);
assert.match(one.previewCookie, /^__Host-sfl_preview=[a-f0-9]{64}$/);
assert.ok(one.setCookies.some(x => x.includes('SameSite=None; Partitioned')));
assert.equal((await request('/api/me', 'GET', undefined, one.previewCookie)).json.username, 'researcher_one');
assert.equal((await request('/api/register', 'POST', credential)).status, 409);
assert.equal((await request('/api/login', 'POST', { username: credential.username, password: 'wrong passphrase 123' })).status, 401);
const two = await request('/api/register', 'POST', second);
assert.equal(two.status, 201);
assert.equal((await request('/api/me', 'GET', undefined, one.cookie)).json.username, 'researcher_one');
assert.equal((await request('/api/me', 'GET', undefined, two.cookie)).json.username, 'researcher_two');

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(`<html><head><title>Dr. Ada Test | Example University</title></head>
  <body><h1>Dr. Ada Test</h1><p>My research focuses on artificial intelligence, machine learning,
  deep learning, cybersecurity, network security, and adversarial machine learning.
  I currently have funded PhD positions in my research lab.</p></body></html>`, {
  status: 200, headers: { 'Content-Type': 'text/html' }
});
const analyzed = await request('/api/analyze-profile', 'POST', { url: 'https://faculty.example.edu/ada' }, one.cookie);
assert.equal(analyzed.status, 200);
assert.equal(analyzed.json.suggestions.name, 'Dr. Ada Test');
assert.equal(analyzed.json.suggestions.university, 'Example University');
assert.equal(analyzed.json.suggestions.intersection, 4);
assert.equal(analyzed.json.suggestions.funding, 4);
assert.ok(analyzed.json.evidence.ai.includes('machine learning'));
assert.equal((await request('/api/analyze-profile', 'POST', { url: 'https://127.0.0.1/private' }, one.cookie)).status, 400);
assert.equal((await request('/api/analyze-profile', 'POST', { url: 'http://faculty.example.edu/ada' }, one.cookie)).status, 400);
globalThis.fetch = originalFetch;

const workspace1 = await request('/api/workspace', 'GET', undefined, one.cookie);
assert.deepEqual(workspace1.json.data.professors, []);
workspace1.json.data.professors.push({
  id: 'test-professor', name: 'Test Professor', university: 'Test University',
  areas: ['AI'], ai: 5, cyber: null, intersection: null, funding: null,
  notes: 'Private note', source: 'Lab website', shortlisted: true
});
assert.equal((await request('/api/workspace', 'PUT', { revision: 0, data: workspace1.json.data }, one.cookie)).status, 200);
assert.equal((await request('/api/workspace', 'GET', undefined, one.cookie)).json.data.professors.length, 1);
assert.equal((await request('/api/workspace', 'GET', undefined, two.cookie)).json.data.professors.length, 0);
assert.equal((await request('/api/workspace', 'PUT', { revision: 0, data: workspace1.json.data }, one.cookie)).status, 409);
assert.equal((await request('/api/workspace', 'PUT', { revision: 1, data: workspace1.json.data }, two.cookie, 'https://attacker.example')).status, 403);

assert.equal((await request('/api/logout', 'POST', {}, one.cookie)).status, 200);
assert.equal((await request('/api/workspace', 'GET', undefined, one.cookie)).status, 401);
const relogin = await request('/api/login', 'POST', credential);
assert.equal(relogin.status, 200);
assert.equal((await request('/api/workspace', 'GET', undefined, relogin.cookie)).json.data.professors[0].notes, 'Private note');
console.log('PASS: registration, login, session, logout, CSRF, account isolation, revision conflict, profile analysis');
