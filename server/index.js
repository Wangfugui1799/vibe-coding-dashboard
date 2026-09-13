/**
 * Vibe Coding 仪表盘 - 纯 Node.js 内置模块实现（无需任何 npm 依赖）
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const PORT       = 3333;
// 仅绑定本机回环地址。服务含 /api/browse（可列任意目录）且无鉴权，不可暴露到局域网
const HOST       = '127.0.0.1';
const CLIENT_DIR = path.join(__dirname, '../client');
const DATA_DIR   = path.join(__dirname, 'data');
const TASKS_FILE  = path.join(DATA_DIR, 'tasks.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ======= 工具函数 =======
function readJSON(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (e) { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function genId() {
  return 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 400) {
  json(res, { error: msg }, status);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// MIME 类型
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ======= 静态文件服务 =======
function serveStatic(req, res, urlPath) {
  // 先归一化 URL 路径（消解 ..），再拼接，避免 /../client2/x 之类的绕过
  const normalized = path.posix.normalize(urlPath);
  let filePath = path.resolve(CLIENT_DIR, '.' + normalized);
  // 归一化后仍须严格位于 CLIENT_DIR 之内
  const rel = path.relative(CLIENT_DIR, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { err(res, 'Forbidden', 403); return; }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback
    filePath = path.join(CLIENT_DIR, 'index.html');
  }
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  cors(res);
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

// ======= Git 命令（使用 execFileSync 避免 shell 解析 | 等特殊字符，静默捕获 stderr）=======
function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
  } catch (e) { return null; }
}

function gitStatus(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { error: 'project_path_not_set', message: '请在设置中配置 Git 项目路径' };
  }
  const isGit = runGit(['rev-parse', '--git-dir'], projectPath);
  if (!isGit) return { error: 'not_a_git_repo', message: '该路径不是 Git 仓库' };

  const branch = runGit(['branch', '--show-current'], projectPath) || 'HEAD detached';

  let commit = null;
  const lastCommit = runGit(['log', '-1', '--pretty=format:%H|%s|%an|%ar'], projectPath);
  if (lastCommit) {
    const [hash, message, author, time] = lastCommit.split('|');
    commit = { hash: hash?.slice(0,7), full_hash: hash, message, author, time };
  }

  const statusOut = runGit(['status', '--porcelain'], projectPath) || '';
  const lines = statusOut ? statusOut.split('\n').filter(Boolean) : [];
  const staged    = lines.filter(l => l[0] && l[0] !== ' ' && l[0] !== '?').length;
  const modified  = lines.filter(l => l[1] === 'M' || l[1] === 'D').length;
  const untracked = lines.filter(l => l.startsWith('??')).length;

  let ahead = 0, behind = 0;
  const hasUpstream = runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], projectPath);
  if (hasUpstream) {
    const remoteStatus = runGit(['rev-list', '--count', '--left-right', '@{upstream}...HEAD'], projectPath);
    if (remoteStatus) {
      const parts = remoteStatus.split('\t');
      behind = parseInt(parts[0]) || 0;
      ahead  = parseInt(parts[1]) || 0;
    }
  }

  // 提交历史
  const logOut = runGit(['log', '-10', '--pretty=format:%H|%s|%an|%ar|%ai'], projectPath);
  const commits = [];
  if (logOut) {
    logOut.split('\n').forEach(line => {
      const parts = line.split('|');
      if (parts.length >= 4) {
        commits.push({
          hash: parts[0].slice(0,7),
          full_hash: parts[0],
          message: parts[1],
          author: parts[2],
          relative_time: parts[3],
          datetime: parts[4] || ''
        });
      }
    });
  }

  // ---- 分支列表（本地 + 远程）----
  const branches = [];
  const branchOut = runGit(['branch', '-a', '-v', '--no-abbrev'], projectPath);
  if (branchOut) {
    branchOut.split('\n').forEach(line => {
      if (!line.trim()) return;
      const isCurrent = line.startsWith('*');
      const cleaned = line.replace(/^\*?\s+/, '');
      // 格式: branchname  hash commit_msg   或   remotes/origin/name  hash msg
      const match = cleaned.match(/^(\S+)\s+([a-f0-9]+)\s+(.*)/);
      if (match) {
        const name = match[1];
        const isRemote = name.startsWith('remotes/');
        // 跳过 HEAD -> xxx 符号引用
        if (name.includes('HEAD ->') || name === 'remotes/origin/HEAD') return;
        branches.push({
          name: isRemote ? name.replace('remotes/', '') : name,
          hash: match[2].slice(0, 7),
          message: match[3].trim(),
          is_current: isCurrent,
          is_remote: isRemote
        });
      }
    });
  }

  // ---- 工作树 (worktree) ----
  const rawWorktrees = [];
  const wtOut = runGit(['worktree', 'list', '--porcelain'], projectPath);
  if (wtOut) {
    let wt = {};
    wtOut.split('\n').forEach(line => {
      if (line.startsWith('worktree ')) {
        if (wt.path) rawWorktrees.push(wt);
        wt = { path: line.slice(9) };
      } else if (line.startsWith('HEAD ')) {
        wt.head = line.slice(5, 12);
        wt.full_head = line.slice(5);
      } else if (line.startsWith('branch ')) {
        wt.branch = line.slice(7).replace('refs/heads/', '');
      } else if (line === 'bare') {
        wt.bare = true;
      } else if (line === 'detached') {
        wt.detached = true;
      } else if (line === 'locked') {
        wt.locked = true;
      } else if (line === 'prunable') {
        wt.prunable = true;
      } else if (line === '') {
        if (wt.path) rawWorktrees.push(wt);
        wt = {};
      }
    });
    if (wt.path) rawWorktrees.push(wt);
  }

  const worktrees = rawWorktrees.map((wt, index) => {
    const isMain = index === 0 || wt.path === projectPath;
    let commit = null;
    let changes = null;

    if (fs.existsSync(wt.path)) {
      const wtLog = runGit(['log', '-1', '--pretty=format:%H|%s|%an|%ar'], wt.path);
      if (wtLog) {
        const [h, s, a, t] = wtLog.split('|');
        commit = { hash: h?.slice(0, 7), full_hash: h, message: s, author: a, time: t };
      }

      const wtStatus = runGit(['status', '--porcelain'], wt.path);
      if (wtStatus !== null) {
        const lines = wtStatus ? wtStatus.split('\n').filter(Boolean) : [];
        changes = {
          clean: lines.length === 0,
          total: lines.length
        };
      }
    }

    return {
      ...wt,
      is_main: isMain,
      commit,
      changes
    };
  });

  // ---- Stash 列表 ----
  const stashes = [];
  const stashOut = runGit(['stash', 'list', '--pretty=format:%gd|%s|%ar'], projectPath);
  if (stashOut) {
    stashOut.split('\n').forEach(line => {
      const parts = line.split('|');
      if (parts.length >= 2) {
        stashes.push({
          ref: parts[0],
          message: parts[1],
          time: parts[2] || ''
        });
      }
    });
  }

  // ---- 最近 Tag ----
  const tags = [];
  const tagOut = runGit(['tag', '-l', '--sort=-creatordate', '--format=%(refname:short)|%(objectname:short)|%(creatordate:relative)'], projectPath);
  if (tagOut) {
    tagOut.split('\n').slice(0, 10).forEach(line => {
      const parts = line.split('|');
      if (parts.length >= 2 && parts[0]) {
        tags.push({ name: parts[0], hash: parts[1], time: parts[2] || '' });
      }
    });
  }

  return {
    branch, commit,
    changes: { staged, modified, untracked, total: lines.length },
    sync: { ahead, behind },
    commits, branches, worktrees, stashes, tags,
    project_path: projectPath,
    checked_at: new Date().toISOString()
  };
}

function gitDiff(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return { files: [] };
  const statusOut = runGit(['status', '--porcelain'], projectPath) || '';
  const files = statusOut ? statusOut.split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim(), file: line.slice(3)
  })) : [];
  return { files };
}

// ======= 路由处理 =======
async function handleRequest(req, res) {
  const url   = new URL(req.url, `http://localhost:${PORT}`);
  const path_ = url.pathname;
  const method = req.method.toUpperCase();

  // OPTIONS 预检
  if (method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ---- /api/health ----
  if (path_ === '/api/health') {
    return json(res, { status: 'ok', time: new Date().toISOString() });
  }

  // ---- /api/config ----
  if (path_ === '/api/config') {
    if (method === 'GET') {
      return json(res, readJSON(CONFIG_FILE, { project_name: '', project_path: '', git_refresh_interval: 5000, milestones: [] }));
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const config = readJSON(CONFIG_FILE, {});
      const updated = { ...config, ...body };
      writeJSON(CONFIG_FILE, updated);
      return json(res, updated);
    }
  }

  // ---- /api/tasks/stats/summary ----
  if (path_ === '/api/tasks/stats/summary') {
    const data  = readJSON(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];
    const todo  = tasks.filter(t => t.status === 'todo').length;
    const doing = tasks.filter(t => t.status === 'doing').length;
    const done  = tasks.filter(t => t.status === 'done').length;
    const today = new Date().toDateString();
    const todayDone = tasks.filter(t => t.done_at && new Date(t.done_at).toDateString() === today).length;
    return json(res, { total: tasks.length, todo, doing, done, todayDone });
  }

  // ---- /api/tasks ----
  if (path_ === '/api/tasks') {
    const data = readJSON(TASKS_FILE, { tasks: [] });
    if (method === 'GET') {
      let tasks = data.tasks || [];
      const status   = url.searchParams.get('status');
      const priority = url.searchParams.get('priority');
      if (status)   tasks = tasks.filter(t => t.status === status);
      if (priority) tasks = tasks.filter(t => t.priority === priority);
      return json(res, { tasks });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const now  = new Date().toISOString();
      const task = {
        id: genId(),
        title:    body.title || '未命名需求',
        status:   body.status || 'todo',
        priority: body.priority || 'medium',
        prompt:   body.prompt || '',
        created_at: now,
        started_at: (body.status === 'doing' || body.status === 'done') ? now : (body.started_at || null),
        done_at:    body.status === 'done'  ? now : null,
        linked_commits: body.linked_commits || [],
        tags:           body.tags || [],
        milestone_id:   body.milestone_id || ''
      };
      if (!Array.isArray(data.tasks)) data.tasks = [];
      data.tasks.unshift(task);
      writeJSON(TASKS_FILE, data);
      return json(res, task, 201);
    }
  }

  // ---- /api/tasks/:id ----
  const taskMatch = path_.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const id   = taskMatch[1];
    const data = readJSON(TASKS_FILE, { tasks: [] });
    if (!Array.isArray(data.tasks)) data.tasks = [];
    const idx  = data.tasks.findIndex(t => t.id === id);

    if (method === 'GET') {
      if (idx === -1) return err(res, 'Task not found', 404);
      return json(res, data.tasks[idx]);
    }
    if (method === 'PATCH') {
      if (idx === -1) return err(res, 'Task not found', 404);
      const body = await readBody(req);
      const task = data.tasks[idx];
      const now  = new Date().toISOString();
      if (body.status && body.status !== task.status) {
        if (body.status === 'doing') {
          if (!task.started_at) body.started_at = now;
          body.done_at = null;            // 从已完成退回，清空完成时间
        }
        if (body.status === 'done') {
          body.done_at = now;
          if (!task.started_at) body.started_at = now;
        }
        if (body.status === 'todo') {
          body.started_at = null;         // 退回待做，开始与完成时间一并清空
          body.done_at = null;
        }
      }
      data.tasks[idx] = { ...task, ...body };
      writeJSON(TASKS_FILE, data);
      return json(res, data.tasks[idx]);
    }
    if (method === 'DELETE') {
      if (idx === -1) return err(res, 'Task not found', 404);
      const deleted = data.tasks.splice(idx, 1)[0];
      writeJSON(TASKS_FILE, data);
      return json(res, deleted);
    }
  }

  // ---- /api/git/status ----
  if (path_ === '/api/git/status') {
    const config      = readJSON(CONFIG_FILE, {});
    const projectPath = url.searchParams.get('path') || config.project_path || '';
    return json(res, gitStatus(projectPath));
  }

  // ---- /api/git/diff ----
  if (path_ === '/api/git/diff') {
    const config      = readJSON(CONFIG_FILE, {});
    const projectPath = url.searchParams.get('path') || config.project_path || '';
    return json(res, gitDiff(projectPath));
  }

  // ---- /api/browse - 文件夹浏览器 ----
  if (path_ === '/api/browse') {
    const targetDir = url.searchParams.get('path') || require('os').homedir();
    try {
      if (!fs.existsSync(targetDir)) return json(res, { error: '路径不存在', path: targetDir, items: [] });
      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) return json(res, { error: '不是文件夹', path: targetDir, items: [] });

      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        // 跳过隐藏文件（.开头），但保留 .git 检测
        if (entry.name.startsWith('.') && entry.name !== '.git') continue;
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(targetDir, entry.name);
        const isGitRepo = entry.name === '.git' ? false : fs.existsSync(path.join(fullPath, '.git'));
        items.push({
          name: entry.name,
          path: fullPath,
          is_git: isGitRepo
        });
      }
      // .git 存在于当前目录 → 当前目录本身是 git 仓库
      const selfIsGit = fs.existsSync(path.join(targetDir, '.git'));
      items.sort((a, b) => {
        // Git 仓库排最前
        if (a.is_git !== b.is_git) return a.is_git ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const parent = path.dirname(targetDir);
      return json(res, {
        path: targetDir,
        parent: parent !== targetDir ? parent : null,
        is_git: selfIsGit,
        items
      });
    } catch (e) {
      return json(res, { error: e.message, path: targetDir, items: [] });
    }
  }

  // ---- 静态文件 ----
  if (!path_.startsWith('/api/')) {
    return serveStatic(req, res, path_);
  }

  err(res, 'Not Found', 404);
}

// ======= 启动服务 =======
const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    console.error('Server error:', e);
    if (!res.headersSent) err(res, 'Internal Server Error', 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║   ⚡ Vibe Coding 仪表盘 已启动！      ║');
  console.log(`║   👉 http://localhost:${PORT}           ║`);
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
  console.log(`仅本机可访问（${HOST}:${PORT}）`);
  console.log('按 Ctrl+C 停止服务');
});
