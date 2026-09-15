const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, timingSafeEqual } = require('crypto');
const { createDashboard } = require('../server/index');
const { createStore, hydrate, collect } = require('../server/cloud-store');

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function authorized(req, env) {
  const expected = `${env.DASHBOARD_USERNAME || 'admin'}:${env.DASHBOARD_PASSWORD}`;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const supplied = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(supplied), hash(expected));
}

// Buffer API responses until the durable commit succeeds. Failed saves never return success.
function bufferResponse() {
  return {
    status: 200, headers: {}, body: '', headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers = {}) {
      this.status = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      this.headersSent = true;
    },
    end(body = '') { this.body = body; }
  };
}

function createHandler({ env = process.env, storeFactory = createStore } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD.length < 16) {
      return reply(res, 503, { error: '请在 Vercel 配置至少 16 位的 DASHBOARD_PASSWORD，然后重新部署。' });
    }
    if (!authorized(req, env)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Vibe Dashboard", charset="UTF-8"');
      return reply(res, 401, { error: '请登录，默认用户名为 admin' });
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      if (req.headers['sec-fetch-site'] === 'cross-site' ||
          (origin && new URL(origin).host !== req.headers.host)) {
        return reply(res, 403, { error: '不允许跨站修改数据' });
      }
    }
    if (pathname.startsWith('/api/git/') || pathname === '/api/browse') {
      return reply(res, 501, { error: 'local_only', message: '本机 Git 和目录浏览请在本地版使用。' });
    }
    if (pathname === '/api/health') {
      return reply(res, 200, { status: 'ok', mode: 'cloud', git: { available: false } });
    }
    // Only serve the client directory, never repository data or configuration files.
    if (!pathname.startsWith('/api/')) {
      return createDashboard().handleRequest(req, res);
    }
    let dir;
    try {
      const store = storeFactory(env);
      const previous = await store.load();
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cloud-'));
      hydrate(dir, previous.files);
      const dashboard = createDashboard({ dataDir: dir });
      dashboard.initDataStorage();
      if (!previous.revision) dashboard.initBackup();
      const buffered = bufferResponse();
      await dashboard.handleRequest(req, buffered);
      if (buffered.status < 400) {
        const files = collect(dir);
        const changed = Object.keys(files).length !== Object.keys(previous.files).length ||
          Object.entries(files).some(([name, value]) => previous.files[name] !== value);
        if (changed) await store.save(previous, files);
      }
      // Local CORS policy does not apply to authenticated cloud requests.
      for (const [name, value] of Object.entries(buffered.headers)) {
        if (!name.startsWith('access-control-')) res.setHeader(name, value);
      }
      res.writeHead(buffered.status);
      res.end(buffered.body);
    } catch (error) {
      console.error('Cloud request failed:', error.message);
      reply(res, error.status || 503, { error: error.message || '云端操作失败' });
    } finally {
      // Only the uniquely created request directory is removed; local data is never used.
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
