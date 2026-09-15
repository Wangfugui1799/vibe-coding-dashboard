const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { createDashboard } = require('../server');
const { createHandler } = require('../api');
const { createStore, hydrate } = require('../server/cloud-store');

const env = {
  DASHBOARD_PASSWORD: 'test-only-password-12345',
  UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'test-only-token'
};
const authorization = `Basic ${Buffer.from(`admin:${env.DASHBOARD_PASSWORD}`).toString('base64')}`;

async function invoke(handler, url, method = 'GET', body, headers = {}, parsed = true) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  Object.assign(req, { url, method, headers: { host: 'dashboard.test', authorization, ...headers } });
  if (parsed && body !== undefined) req.body = body;
  let content = '';
  const res = new Writable({ write(chunk, encoding, done) { content += chunk.toString(); done(); } });
  res.headers = {};
  res.statusCode = 200;
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.writeHead = (status, extra = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
  };
  const finished = new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); });
  await handler(req, res);
  await finished;
  let data;
  try { data = JSON.parse(content); } catch { data = content; }
  return { status: res.statusCode, headers: res.headers, data };
}

function redisMock() {
  const records = new Map();
  let failed = false;
  return {
    records,
    fail() { failed = true; },
    async fetch(url, options) {
      if (failed) throw new Error('simulated storage outage');
      const [command, ...args] = JSON.parse(options.body);
      let result;
      if (command === 'GET') result = records.get(args[0]) || null;
      else if (command === 'EVAL') {
        const [, , key, expected, next] = args;
        const current = records.get(key);
        if ((current ? JSON.parse(current).revision : '') !== expected) result = 0;
        else { records.set(key, next); result = 1; }
      } else throw new Error('unexpected Redis command');
      return { ok: true, json: async () => ({ result }) };
    }
  };
}

test('local disk persistence, raw JSON request, isolation and Git health', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-test-'));
  try {
    const first = createDashboard({ dataDir: dir });
    first.initDataStorage();
    const created = await invoke(first.handleRequest, '/api/tasks', 'POST', { title: 'local task' }, {}, false);
    assert.equal(created.status, 201);
    const second = createDashboard({ dataDir: dir });
    const tasks = await invoke(second.handleRequest, '/api/tasks');
    assert.equal(tasks.data.tasks[0].title, 'local task');
    assert.equal(second.readArchive().tasks.length, 1);
    assert.equal((await invoke(second.handleRequest, '/api/health')).data.status, 'ok');
    assert.throws(() => second.readBoard('../../escape'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cloud authentication, static files, setup failures and local-only routes', async () => {
  const handler = createHandler({ env });
  assert.equal((await invoke(handler, '/', 'GET', undefined, { authorization: '' })).status, 401);
  assert.equal((await invoke(createHandler({ env: {} }), '/')).status, 503);
  const home = await invoke(handler, '/');
  assert.equal(home.status, 200);
  assert.match(home.data, /Vibe Coding/);
  assert.match((await invoke(handler, '/js/app.js')).data, /cloudMode/);
  assert.equal((await invoke(handler, '/api/browse')).status, 501);
  assert.equal((await invoke(handler, '/api/health')).data.git.provider, 'github');
  assert.equal((await invoke(handler, '/api/tasks', 'POST', {}, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await invoke(createHandler({ env: { DASHBOARD_PASSWORD: env.DASHBOARD_PASSWORD } }), '/api/tasks')).status, 503);
});

test('cloud CRUD, cold request persistence, archive restore and export', async () => {
  const redis = redisMock();
  const factory = settings => createStore(settings, redis.fetch);
  const handler = createHandler({ env, storeFactory: factory });
  const projects = await invoke(handler, '/api/projects');
  assert.equal(projects.status, 200);
  assert.equal(projects.data.projects[0].path, '');
  const created = await invoke(handler, '/api/tasks', 'POST', { title: 'cloud task', prompt: 'hello' });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const cold = createHandler({ env, storeFactory: factory });
  assert.equal((await invoke(cold, '/api/tasks')).data.tasks[0].id, id);
  assert.equal((await invoke(cold, `/api/tasks/${id}`, 'PATCH', { status: 'done' })).data.status, 'done');
  assert.equal((await invoke(cold, `/api/tasks/${id}/trash`, 'POST', {})).status, 200);
  assert.equal((await invoke(cold, '/api/tasks')).data.tasks.length, 0);
  assert.equal((await invoke(cold, '/api/backups/restore', 'POST', { task_id: id })).status, 200);
  assert.equal((await invoke(cold, '/api/tasks')).data.tasks.length, 1);
  assert.equal((await invoke(cold, '/api/backups/snapshot', 'POST', {})).status, 201);
  const exported = await invoke(cold, '/api/backups/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.data.archive.tasks.length, 1);
  assert.ok(exported.headers['content-disposition']);
  assert.equal(exported.headers['access-control-allow-origin'], undefined);
  const stored = [...redis.records.values()][0];
  assert.ok(!stored.includes('/Users/apple'));
  redis.fail();
  assert.equal((await invoke(cold, '/api/tasks', 'POST', { title: 'must fail' })).status, 503);
  assert.equal([...redis.records.values()][0], stored);
});

test('atomic version check rejects stale writes and partitions deployment environments', async () => {
  const redis = redisMock();
  const store = createStore({ ...env, VERCEL_ENV: 'production' }, redis.fetch);
  const a = await store.load();
  const b = await store.load();
  await store.save(a, { 'tasks.json': 'one' });
  await assert.rejects(store.save(b, { 'tasks.json': 'two' }), error => error.status === 409);
  assert.equal((await store.load()).files['tasks.json'], 'one');
  const preview = createStore({ ...env, VERCEL_ENV: 'preview' }, redis.fetch);
  assert.deepEqual((await preview.load()).files, {});
  await assert.rejects(store.save(await store.load(), { huge: 'x'.repeat(3 * 1024 * 1024) }), error => error.status === 413);
});

test('cloud does not send success before persistence and rejects escaping snapshot paths', async () => {
  const handler = createHandler({ env, storeFactory: () => ({
    load: async () => ({ revision: '', files: {} }),
    save: async () => { throw Object.assign(new Error('conflict'), { status: 409 }); }
  }) });
  const response = await invoke(handler, '/api/tasks', 'POST', { title: 'not committed' });
  assert.equal(response.status, 409);
  assert.equal(response.data.id, undefined);
  assert.throws(() => hydrate('/tmp/isolated-test', { '../escape': 'bad' }));
});

test('cloud Git routes use active project repository and keep credentials server-side', async () => {
  const redis = redisMock();
  const handler = createHandler({ env, storeFactory: settings => createStore(settings, redis.fetch),
    githubClient: { status: async (repository, branch) => ({ repository, branch }) }
  });
  assert.equal((await invoke(handler, '/api/git/status')).data.repository, 'Wangfugui1799/vibe-coding-dashboard');
  await invoke(handler, '/api/projects', 'POST', { name: 'Other repo', path: 'octocat/Hello-World' });
  assert.deepEqual((await invoke(handler, '/api/git/status?branch=feature%2Ftest')).data, { repository: 'octocat/Hello-World', branch: 'feature/test' });
  assert.equal((await invoke(handler, '/api/git/status', 'POST', {})).status, 405);
  assert.equal((await invoke(handler, '/api/git/unknown')).status, 404);
});
