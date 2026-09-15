const { createHash } = require('crypto');

function parseRepository(value) {
  let repo = String(value || '').trim();
  repo = repo.replace(/^https:\/\/github\.com\//i, '').replace(/^git@github\.com:/i, '');
  repo = repo.replace(/\/$/, '').replace(/\.git$/, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repo) || ['.', '..'].includes(repo.split('/')[1])) {
    throw Object.assign(new Error('请在设置中填写 GitHub 仓库：owner/repo 或 https://github.com/owner/repo'), { status: 400 });
  }
  return repo;
}

function createGitHubClient({ env = process.env, request = fetch, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  const token = env.GITHUB_TOKEN || '';
  const ttl = token ? 60000 : 600000;
  const scope = createHash('sha256').update(token).digest('hex');

  async function get(endpoint) {
    const key = scope + endpoint;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Vibe-Coding-Dashboard', 'X-GitHub-Api-Version': '2022-11-28' };
      if (token) headers.Authorization = `Bearer ${token}`;
      let response;
      try {
        response = await request(`https://api.github.com${endpoint}`, { headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
      } catch {
        throw Object.assign(new Error('无法连接 GitHub，请稍后重试；仓库改名后请更新配置地址。'), { status: 502 });
      }
      if (!response.ok) {
        let message = 'GitHub 暂时无法提供数据，请稍后重试。';
        let status = 502;
        if (response.status === 404) { status = 404; message = '仓库或分支不存在，或没有访问权限。私有仓库请配置只读 GITHUB_TOKEN。'; }
        if (response.status === 401) { status = 401; message = 'GitHub Token 无效或已过期，请在 Vercel 更新 GITHUB_TOKEN。'; }
        if (response.status === 403 || response.status === 429) {
          status = 429;
          message = 'GitHub 访问受限或额度用尽，请稍后重试，或配置有仓库读取权限的 GITHUB_TOKEN。';
        }
        if (response.status === 409) { status = 409; message = '该仓库尚无提交，请先向 GitHub 推送代码。'; }
        throw Object.assign(new Error(message), { status });
      }
      const value = { data: await response.json(), hasMore: /rel="next"/.test(response.headers.get('link') || ''), fetchedAt: new Date(now()).toISOString() };
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expires: now() + ttl });
      return value;
    })();
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); }
  }

  async function status(repository, selectedBranch = '') {
    const repo = parseRepository(repository);
    const root = '/repos/' + repo.split('/').map(encodeURIComponent).join('/');
    const info = await get(root);
    const branch = selectedBranch || info.data.default_branch;
    if (!branch || branch.length > 255) throw Object.assign(new Error('无效的 GitHub 分支名称'), { status: 400 });
    const [branches, tags, history] = await Promise.all([
      get(`${root}/branches?per_page=100`),
      get(`${root}/tags?per_page=100`),
      get(`${root}/commits?sha=${encodeURIComponent(branch)}&per_page=30`)
    ]);
    const commits = history.data.map(c => ({
      hash: c.sha.slice(0, 7), full_hash: c.sha,
      message: c.commit.message.split('\n')[0],
      author: c.commit.author?.name || c.author?.login || '未知作者',
      datetime: c.commit.author?.date || '',
      url: `https://github.com/${repo}/commit/${encodeURIComponent(c.sha)}`
    }));
    const latest = commits[0] ? await get(`${root}/commits/${encodeURIComponent(commits[0].full_hash)}?per_page=100`) : null;
    return {
      mode: 'github', repository: repo, url: `https://github.com/${repo}`,
      branch, default_branch: info.data.default_branch,
      branches: branches.data.map(b => ({ name: b.name, hash: b.commit.sha.slice(0, 7), protected: b.protected })),
      branches_truncated: branches.hasMore,
      tags: tags.data.map(t => ({ name: t.name, hash: t.commit.sha.slice(0, 7) })), tags_truncated: tags.hasMore,
      commits, commits_truncated: history.hasMore,
      files: (latest?.data.files || []).map(f => ({ file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
      files_truncated: latest?.hasMore || false,
      fetched_at: history.fetchedAt, cache_seconds: ttl / 1000,
      authenticated: Boolean(token)
    };
  }
  return { status };
}

module.exports = { createGitHubClient, parseRepository };
