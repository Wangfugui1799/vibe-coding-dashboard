// Small personal dashboards: one versioned Redis document keeps boards and backups atomic.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const CAS = `
local current = redis.call('GET', KEYS[1])
if current then
  if cjson.decode(current).revision ~= ARGV[1] then return 0 end
elseif ARGV[1] ~= '' then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

function createStore(env = process.env, request = fetch) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  const key = env.DASHBOARD_REDIS_KEY || `vibe-dashboard:${env.VERCEL_ENV || 'development'}:v1`;
  if (!url || !token) throw new Error('请配置 UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN');
  if (new URL(url).protocol !== 'https:') throw new Error('Redis REST URL 必须使用 HTTPS');
  async function command(args) {
    const response = await request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('云端存储暂不可用，请稍后刷新确认数据');
    const data = await response.json();
    if (data.error) throw new Error('云端存储操作失败，请检查连接和容量');
    return data.result;
  }
  return {
    async load() {
      const raw = await command(['GET', key]);
      if (raw === null) return { revision: '', files: {} };
      const state = JSON.parse(raw);
      if (!state || typeof state.revision !== 'string' || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)) {
        throw new Error('云端数据格式异常，已停止写入');
      }
      return state;
    },
    async save(previous, files) {
      const next = JSON.stringify({ revision: randomUUID(), files });
      // Bound document transfer and fail before modifying durable data.
      if (Buffer.byteLength(next) > 3 * 1024 * 1024) {
        const error = new Error('云端数据超过 3 MB，请导出备份并扩展存储方案');
        error.status = 413;
        throw error;
      }
      if (await command(['EVAL', CAS, '1', key, previous.revision, next]) !== 1) {
        const error = new Error('其他窗口刚刚更新了数据，请刷新后重试，本次修改未保存');
        error.status = 409;
        throw error;
      }
    }
  };
}

function hydrate(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.resolve(dir, name);
    if (!target.startsWith(dir + path.sep) || typeof content !== 'string') throw new Error('云端数据路径异常');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function collect(dir, root = dir, files = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(file, root, files);
    else if (entry.isFile()) files[path.relative(root, file)] = fs.readFileSync(file, 'utf8');
    else throw new Error('不支持的云端数据文件');
  }
  return files;
}

module.exports = { createStore, hydrate, collect, CAS };
