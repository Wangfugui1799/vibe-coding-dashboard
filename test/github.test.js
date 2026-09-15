const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubClient, parseRepository } = require('../server/github');

test('repository normalization only permits GitHub repository names', () => {
  assert.equal(parseRepository('https://github.com/owner/repo.git/'), 'owner/repo');
  assert.equal(parseRepository('git@github.com:owner/repo.git'), 'owner/repo');
  for (const value of ['', 'https://evil.test/a/b', '../a', 'owner/..', 'owner/repo/issues', 'owner/repo?token=x', '/Users/me/repo']) {
    assert.throws(() => parseRepository(value));
  }
});

test('GitHub view maps remote data, encodes slash branches, caches requests, and exposes pagination', async () => {
  let time = 0;
  const calls = [];
  const client = createGitHubClient({ env: { GITHUB_TOKEN: 'private-test-token' }, now: () => time, request: async (url, options) => {
    calls.push(url);
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.headers.Authorization, 'Bearer private-test-token');
    let data;
    let link = '';
    if (url.endsWith('/owner/repo')) data = { default_branch: 'main' };
    else if (url.includes('/branches?')) { data = [{ name: 'main', commit: { sha: 'abcdef0123' } }]; link = '<next>; rel="next"'; }
    else if (url.includes('/tags?')) data = [{ name: 'v1', commit: { sha: 'abcdef0123' } }];
    else if (url.includes('/commits?')) data = [{ sha: 'abcdef0123', commit: { message: '<script>remote title</script>\nbody', author: { name: 'Alice', date: '2026-01-01T00:00:00Z' } } }];
    else data = { files: [{ filename: 'app.js', status: 'modified', additions: 2, deletions: 1 }] };
    return new Response(JSON.stringify(data), { headers: { link } });
  } });
  const result = await client.status('owner/repo', 'feature/my branch');
  assert.ok(calls.some(url => url.includes('sha=feature%2Fmy%20branch')));
  assert.equal(result.files[0].file, 'app.js');
  assert.equal(result.commits[0].url, 'https://github.com/owner/repo/commit/abcdef0123');
  assert.equal(result.branches_truncated, true);
  assert.equal(result.cache_seconds, 60);
  assert.ok(!JSON.stringify(result).includes('private-test-token'));
  const count = calls.length;
  await Promise.all([client.status('owner/repo', 'feature/my branch'), client.status('owner/repo', 'feature/my branch')]);
  assert.equal(calls.length, count);
  time = 61000;
  await client.status('owner/repo', 'feature/my branch');
  assert.equal(calls.length, count * 2);
});

test('GitHub failure states are actionable and never pretend local state is clean', async () => {
  for (const [status, expected] of [[404, 404], [401, 401], [403, 429], [429, 429], [409, 409], [500, 502]]) {
    const client = createGitHubClient({ env: {}, request: async () => new Response('{}', { status }) });
    await assert.rejects(client.status('owner/repo'), error => error.status === expected && !error.message.includes('Bearer'));
  }
  const client = createGitHubClient({ env: {}, request: async () => { throw new Error('network error'); } });
  await assert.rejects(client.status('owner/repo'), error => error.status === 502);
});
