/**
 * Vibe Coding 仪表盘 - 纯 Node.js 内置模块实现（无需任何 npm 依赖）
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const PORT       = parseInt(process.env.PORT, 10) || 3333;
// 仅绑定本机回环地址。服务含 /api/browse（可列任意目录）且无鉴权，不可暴露到局域网
const HOST       = '127.0.0.1';
const CLIENT_DIR = path.join(__dirname, '../client');
const DATA_DIR   = path.join(__dirname, 'data');
const TASKS_FILE  = path.join(DATA_DIR, 'tasks.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const BOARDS_DIR  = path.join(DATA_DIR, 'boards');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// ======= 本地备份目录 =======
// 需求（任务）在任何一次创建 / 修改 / 删除时都会落盘备份，误删可恢复
const BACKUP_DIR    = path.join(DATA_DIR, 'backups');
const JOURNAL_DIR   = path.join(BACKUP_DIR, 'journal');    // 追加型事件日志（按天分文件）
const SNAPSHOT_DIR  = path.join(BACKUP_DIR, 'snapshots');  // 全量快照（可整体回滚）
const ARCHIVE_FILE  = path.join(BACKUP_DIR, 'task-archive.json'); // 全量档案（按 id 去重，永不删除）
const MAX_VERSIONS_PER_TASK = 20;  // 单条需求保留的历史版本上限
const MAX_SNAPSHOTS         = 60;  // 保留的全量快照数量上限

// ======= 工具函数 =======
function readJSON(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (e) { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 多项目数据初始化与迁移逻辑
function initDataStorage() {
  ensureDir(DATA_DIR);
  ensureDir(BOARDS_DIR);

  if (!fs.existsSync(PROJECTS_FILE)) {
    const oldConfig = readJSON(CONFIG_FILE, {});
    const oldTasks = readJSON(TASKS_FILE, { tasks: [] });

    const defaultProjId = 'proj_default';
    const defaultProjName = oldConfig.project_name || '默认项目';
    const defaultProjPath = oldConfig.project_path || '';

    const initialProjects = {
      active_project_id: defaultProjId,
      projects: [
        {
          id: defaultProjId,
          name: defaultProjName,
          path: defaultProjPath,
          color: '#58a6ff',
          icon: '⚡',
          created_at: new Date().toISOString()
        }
      ]
    };

    writeJSON(PROJECTS_FILE, initialProjects);
    writeJSON(path.join(BOARDS_DIR, `${defaultProjId}.json`), Array.isArray(oldTasks.tasks) ? oldTasks : { tasks: [] });
  }
}

function getProjectsData() {
  initDataStorage();
  const data = readJSON(PROJECTS_FILE, { active_project_id: null, projects: [] });
  if (!Array.isArray(data.projects)) data.projects = [];
  if (data.projects.length === 0) {
    const defaultId = 'proj_' + Date.now();
    data.projects.push({
      id: defaultId,
      name: '默认项目',
      path: '',
      color: '#58a6ff',
      icon: '⚡',
      created_at: new Date().toISOString()
    });
    data.active_project_id = defaultId;
    writeJSON(PROJECTS_FILE, data);
    writeJSON(path.join(BOARDS_DIR, `${defaultId}.json`), { tasks: [] });
  }
  if (!data.active_project_id || !data.projects.some(p => p.id === data.active_project_id)) {
    data.active_project_id = data.projects[0].id;
    writeJSON(PROJECTS_FILE, data);
  }
  return data;
}

function saveProjectsData(data) {
  writeJSON(PROJECTS_FILE, data);
}

function getActiveProject() {
  const pData = getProjectsData();
  const active = pData.projects.find(p => p.id === pData.active_project_id);
  return active || pData.projects[0];
}

function getBoardFile(projectId) {
  ensureDir(BOARDS_DIR);
  return path.join(BOARDS_DIR, `${projectId}.json`);
}

function readBoard(projectId) {
  const file = getBoardFile(projectId);
  return readJSON(file, { tasks: [] });
}

function writeBoard(projectId, data) {
  const file = getBoardFile(projectId);
  writeJSON(file, data);
}

function getProjectStats(projectId) {
  const data = readBoard(projectId);
  const allList = Array.isArray(data.tasks) ? data.tasks : [];
  const tasks = allList.filter(t => !t.deleted_at);
  const trash = allList.filter(t => !!t.deleted_at).length;
  const todo  = tasks.filter(t => t.status === 'todo').length;
  const doing = tasks.filter(t => t.status === 'doing').length;
  const done  = tasks.filter(t => t.status === 'done').length;
  const today = new Date().toDateString();
  const todayDone = tasks.filter(t => t.done_at && new Date(t.done_at).toDateString() === today).length;
  return { total: tasks.length, todo, doing, done, todayDone, trash };
}

function genId(prefix = 'task') {
  return `${prefix}_` + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
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

// 候选 git 可执行文件。某些启动环境（IDE 沙箱、精简 PATH、macOS 的 /usr/bin/git 垫片
// 无法二次 exec xcrun 时）直接 spawn 裸命令 'git' 会失败；失败若被静默吞掉，就会把
// 「git 用不了」误报成「该路径不是 Git 仓库」。这里显式解析一个可用的绝对路径并缓存。
const GIT_CANDIDATES = [
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
  '/Library/Developer/CommandLineTools/usr/bin/git',
  '/usr/bin/git',
  'git'
];

let gitBinCache;        // undefined = 未探测；null = 全部不可用；string = 可用路径
let gitProbeError = ''; // 最近一次探测失败的原因，用于诊断
let gitProbeAt = 0;     // 上次失败探测的时间戳
const GIT_REPROBE_MS = 30000;

function probeGit(bin) {
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return /^git version/.test(out) ? out : null;
  } catch (e) {
    gitProbeError = `${bin}: ${e.code || e.message}`;
    return null;
  }
}

function resolveGitBin() {
  if (typeof gitBinCache === 'string') return gitBinCache;         // 已成功，永久缓存
  // 失败结果只缓存 30s：避免一次瞬时失败把 git 永久判死
  if (gitBinCache === null && Date.now() - gitProbeAt < GIT_REPROBE_MS) return null;

  gitProbeError = '';
  for (const bin of GIT_CANDIDATES) {
    if (bin !== 'git' && !fs.existsSync(bin)) continue;
    if (probeGit(bin)) { gitBinCache = bin; return gitBinCache; }
  }
  gitBinCache = null;
  gitProbeAt = Date.now();
  return gitBinCache;
}

// 子进程环境：补一个稳妥的 PATH，避免宿主环境 PATH 缺失导致找不到 git
function gitEnv() {
  const env = { ...process.env };
  const fallback = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  env.PATH = env.PATH ? `${env.PATH}:${fallback}` : fallback;
  return env;
}

function runGit(args, cwd) {
  const bin = resolveGitBin();
  if (!bin) return null;
  try {
    // 注意：只能用 trimEnd()。git status --porcelain 的行格式是 `XY<空格>路径`，
    // 未暂存改动的首行以空格开头（如 " M client/js/app.js"），若用 trim() 会吃掉这个
    // 前导空格，导致首个文件名被截掉一个字符、且暂存/修改计数错位。
    return execFileSync(bin, args, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      env: gitEnv(),
      stdio: ['pipe', 'pipe', 'ignore']
    }).trimEnd();
  } catch (e) { return null; }
}

// git 是否可用；不可用时把真实原因带出来，便于前端/日志定位
function gitAvailability() {
  const bin = resolveGitBin();
  if (bin) return { available: true, bin };
  return {
    available: false,
    message: '无法执行 git 命令，Git 状态暂不可用',
    detail: `已尝试: ${GIT_CANDIDATES.join(' → ')}${gitProbeError ? `；最后错误: ${gitProbeError}` : ''}。请确认已安装 Git，且当前进程有权限调用它。`
  };
}

function gitStatus(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { error: 'project_path_not_set', message: '请在设置中配置 Git 项目路径' };
  }
  // 先区分「git 本身不可用」和「该路径不是仓库」，避免误导
  const avail = gitAvailability();
  if (!avail.available) {
    return { error: 'git_unavailable', message: avail.message, detail: avail.detail };
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

  // 关联分支与对应的工作树路径
  const branchWorktreeMap = {};
  worktrees.forEach(wt => {
    if (wt.branch) {
      branchWorktreeMap[wt.branch] = wt.path;
    }
  });

  branches.forEach(b => {
    const wtPath = branchWorktreeMap[b.name];
    if (wtPath) {
      b.worktree_path = wtPath;
      b.is_active_project = (wtPath === projectPath);
    }
  });

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
  const avail = gitAvailability();
  if (!avail.available) return { error: 'git_unavailable', message: avail.message, detail: avail.detail, files: [] };
  const statusOut = runGit(['status', '--porcelain'], projectPath) || '';
  const files = statusOut ? statusOut.split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim(), file: line.slice(3)
  })) : [];
  return { files };
}

function gitBranchCommits(projectPath, branch) {
  if (!projectPath || !fs.existsSync(projectPath)) return { branch: branch || 'HEAD', commits: [] };
  const avail = gitAvailability();
  if (!avail.available) return { error: 'git_unavailable', message: avail.message, detail: avail.detail, branch: branch || 'HEAD', commits: [] };
  const args = ['log', '-25', '--pretty=format:%H|%s|%an|%ar|%ai'];
  if (branch) args.push(branch);
  const logOut = runGit(args, projectPath);
  const commits = [];
  if (logOut) {
    logOut.split('\n').forEach(line => {
      const parts = line.split('|');
      if (parts.length >= 4) {
        commits.push({
          hash: parts[0].slice(0, 7),
          full_hash: parts[0],
          message: parts[1],
          author: parts[2],
          relative_time: parts[3],
          datetime: parts[4] || ''
        });
      }
    });
  }
  return { branch: branch || 'HEAD', commits };
}

// ======= 本地备份模块 =======
// 三层防护，确保任何一条需求都不会真正丢失：
//  1) task-archive.json —— 全量档案：按 task id 去重，永远保留每条需求的最新内容 + 历史版本，
//     需求被删除后仅标记 deleted_at，数据本体不删除，可一键恢复；
//  2) journal/YYYY-MM-DD.jsonl —— 追加型事件日志：逐条记录每次 created / updated / deleted，
//     只追加不覆盖，即使档案文件损坏也能从日志里重建；
//  3) snapshots/*.json —— 所有看板的完整快照，用于整体回滚（启动时自动、也支持手动触发）。
function ensureBackupDirs() {
  ensureDir(BACKUP_DIR);
  ensureDir(JOURNAL_DIR);
  ensureDir(SNAPSHOT_DIR);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function timeStamp(d = new Date()) {
  return `${dateStamp(d)}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

// 快照文件名专用：带毫秒。只精确到秒的话，同一秒内连续备份会互相覆盖。
function timeStampMs(d = new Date()) {
  return `${timeStamp(d)}${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function readArchive() {
  ensureBackupDirs();
  const data = readJSON(ARCHIVE_FILE, null);
  if (!data || !Array.isArray(data.tasks)) {
    return { version: 1, created_at: new Date().toISOString(), updated_at: null, tasks: [] };
  }
  return data;
}

function writeArchive(archive) {
  ensureBackupDirs();
  archive.updated_at = new Date().toISOString();
  // 原子写：先落临时文件再 rename，避免写到一半进程挂掉导致备份档案损坏
  const tmp = ARCHIVE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(archive, null, 2), 'utf-8');
  fs.renameSync(tmp, ARCHIVE_FILE);
}

function appendJournal(event) {
  try {
    ensureBackupDirs();
    const file = path.join(JOURNAL_DIR, `${dateStamp()}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf-8');
  } catch (e) {
    console.error('[backup] 写入事件日志失败:', e.message);
  }
}

/**
 * 把一条需求写入备份档案。
 * @param {object} task    需求对象（完整内容）
 * @param {object} project 所属项目（可为 null）
 * @param {string} action  created | updated | deleted | restored | backfill
 */
function archiveTask(task, project, action) {
  if (!task || !task.id) return false;
  try {
    const now = new Date().toISOString();
    const archive = readArchive();
    let rec = archive.tasks.find(t => t.id === task.id);

    if (!rec) {
      rec = {
        id: task.id,
        project_id: project ? project.id : '',
        project_name: project ? project.name : '',
        first_created_at: task.created_at || now,
        first_backed_up_at: now,
        last_backed_up_at: now,
        last_action: action,
        deleted_at: null,
        version_count: 0,
        task: null,
        versions: []
      };
      archive.tasks.push(rec);
    }

    // 仅在内容真正变化时追加历史版本，避免拖拽卡片换列这类操作把版本表撑爆
    const lastSnap = rec.versions.length ? rec.versions[rec.versions.length - 1].snapshot : null;
    if (!lastSnap || JSON.stringify(lastSnap) !== JSON.stringify(task)) {
      rec.versions.push({ at: now, action, snapshot: task });
      if (rec.versions.length > MAX_VERSIONS_PER_TASK) {
        rec.versions = rec.versions.slice(-MAX_VERSIONS_PER_TASK);
      }
    }
    rec.version_count = rec.versions.length;

    rec.task = task;
    rec.last_backed_up_at = now;
    rec.last_action = action;
    if (project) { rec.project_id = project.id; rec.project_name = project.name; }
    // 只有「删除」才打上删除标记；恢复 / 修改会自动清除，档案里始终留着数据本体
    rec.deleted_at = action === 'deleted' ? now : null;

    writeArchive(archive);
    appendJournal({ at: now, action, project_id: rec.project_id, project_name: rec.project_name, task });
    return true;
  } catch (e) {
    console.error('[backup] 备份需求失败:', task.id, e.message);
    return false;
  }
}

function findProjectById(projectId) {
  try {
    const pData = getProjectsData();
    return pData.projects.find(p => p.id === projectId) || null;
  } catch (e) { return null; }
}

function createSnapshot(reason = 'manual') {
  ensureBackupDirs();
  const pData = getProjectsData();
  const boards = {};
  let taskCount = 0;
  pData.projects.forEach(p => {
    const board = readBoard(p.id);
    boards[p.id] = board;
    taskCount += Array.isArray(board.tasks) ? board.tasks.length : 0;
  });

  const snap = {
    created_at: new Date().toISOString(),
    reason,
    active_project_id: pData.active_project_id,
    projects: pData.projects,
    boards
  };
  // 文件名带毫秒，并在极端情况下（同毫秒）追加序号兜底，确保每份快照都独立留存
  const base = timeStampMs();
  let name = `${base}_${reason}.json`;
  let file = path.join(SNAPSHOT_DIR, name);
  let seq = 1;
  while (fs.existsSync(file)) {
    name = `${base}_${reason}_${seq++}.json`;
    file = path.join(SNAPSHOT_DIR, name);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf-8');
  fs.renameSync(tmp, file);

  appendJournal({ at: snap.created_at, action: 'snapshot', reason, file: name });
  pruneSnapshots();

  return { name, file, created_at: snap.created_at, reason, project_count: pData.projects.length, task_count: taskCount };
}

function pruneSnapshots() {
  try {
    const files = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json')).sort();
    if (files.length <= MAX_SNAPSHOTS) return;
    files.slice(0, files.length - MAX_SNAPSHOTS).forEach(f => {
      try { fs.unlinkSync(path.join(SNAPSHOT_DIR, f)); } catch (e) {}
    });
  } catch (e) {}
}

function readJournal(date) {
  ensureBackupDirs();
  const target = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : dateStamp();
  const file = path.join(JOURNAL_DIR, `${target}.jsonl`);
  if (!fs.existsSync(file)) return { date: target, events: [] };
  const events = fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch (e) { return null; } })
    .filter(Boolean);
  return { date: target, events };
}

function getBackupSummary() {
  ensureBackupDirs();
  const archive = readArchive();
  const tasks = archive.tasks || [];

  let journalFiles = [];
  try { journalFiles = fs.readdirSync(JOURNAL_DIR).filter(f => f.endsWith('.jsonl')).sort().reverse(); } catch (e) {}
  const journalBytes = journalFiles.reduce((n, f) => {
    try { return n + fs.statSync(path.join(JOURNAL_DIR, f)).size; } catch (e) { return n; }
  }, 0);

  let snapshotFiles = [];
  try { snapshotFiles = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json')).sort().reverse(); } catch (e) {}

  let archiveBytes = 0;
  try { archiveBytes = fs.statSync(ARCHIVE_FILE).size; } catch (e) {}

  let latestSnapshotTime = null;
  if (snapshotFiles.length) {
    try {
      latestSnapshotTime = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, snapshotFiles[0]), 'utf-8')).created_at || null;
    } catch (e) {}
  }

  return {
    enabled: true,
    backup_dir: BACKUP_DIR,
    archive_file: ARCHIVE_FILE,
    total_archived: tasks.length,
    alive_count: tasks.filter(t => !t.deleted_at).length,
    deleted_count: tasks.filter(t => !!t.deleted_at).length,
    archive_bytes: archiveBytes,
    updated_at: archive.updated_at || null,
    journal: { count: journalFiles.length, bytes: journalBytes, latest: journalFiles[0] || null },
    snapshots: { count: snapshotFiles.length, latest: snapshotFiles[0] || null, latest_time: latestSnapshotTime }
  };
}

function restoreTaskFromArchive(taskId, projectId) {
  const archive = readArchive();
  const rec = archive.tasks.find(t => t.id === taskId);
  if (!rec || !rec.task) return { error: 'archive_not_found', message: '备份档案中未找到该需求' };

  const pData = getProjectsData();

  // 依次尝试：显式指定的项目 → 需求原来的项目 → 当前激活项目 → 列表第一个项目。
  // 原来的项目可能已经被删除，若不做兜底，这类需求将永远无法恢复。
  const candidates = [projectId, rec.project_id, pData.active_project_id, pData.projects[0] && pData.projects[0].id];
  let targetId = null;
  for (const c of candidates) {
    if (c && pData.projects.some(p => p.id === c)) { targetId = c; break; }
  }
  if (!targetId) return { error: 'project_not_found', message: '当前没有任何可用项目，无法恢复' };

  const proj = pData.projects.find(p => p.id === targetId);
  const fellBack = !!(rec.project_id && rec.project_id !== targetId);

  const board = readBoard(targetId);
  if (!Array.isArray(board.tasks)) board.tasks = [];

  const exist = board.tasks.find(t => t.id === taskId);
  if (exist) {
    // 已存在、但躺在垃圾箱里 → 直接把它从垃圾箱救回，而不是报「已存在」让用户困惑
    if (exist.deleted_at) {
      exist.deleted_at = null;
      if (exist.status_before_delete) {
        exist.status = exist.status_before_delete;
        delete exist.status_before_delete;
      }
      writeBoard(targetId, board);
      archiveTask(exist, proj, 'restored');
      return {
        task: exist, project_id: targetId, project_name: proj.name,
        fell_back: fellBack, original_project_name: rec.project_name || '',
        revived_from_trash: true
      };
    }
    return { error: 'already_exists', message: '该需求已存在于目标看板中', task: exist };
  }

  // 从档案救回。必须清掉删除相关标记：档案里存的是移入垃圾箱那一刻的快照，
  // 带着 deleted_at，若原样写回看板会被过滤逻辑挡掉、直接落进垃圾箱。
  const restored = { ...rec.task };
  delete restored.deleted_at;
  delete restored.status_before_delete;
  board.tasks.unshift(restored);
  writeBoard(targetId, board);
  archiveTask(restored, proj, 'restored');

  return {
    task: restored,
    project_id: targetId,
    project_name: proj.name,
    // 原项目已不存在、被兜底到别的项目时告知前端，方便提示用户
    fell_back: fellBack,
    original_project_name: rec.project_name || ''
  };
}

function maybeStartupSnapshot() {
  try {
    ensureBackupDirs();
    const today = dateStamp();
    const exists = fs.readdirSync(SNAPSHOT_DIR).some(f => f.startsWith(today));
    if (!exists) createSnapshot('startup');
  } catch (e) {
    console.error('[backup] 启动快照失败:', e.message);
  }
}

/**
 * 从事件日志重放，重建全量档案。
 * 用途：task-archive.json 被误删 / 写坏（手工编辑出错、磁盘异常等）时的灾备恢复。
 * 日志是只追加的，完整记录了每次变更的整条需求快照，因此可以据此还原。
 * 注意：日志按天分文件、文件名即日期，按文件名升序重放即可保证时序正确。
 */
function rebuildArchiveFromJournal() {
  ensureBackupDirs();
  const files = fs.readdirSync(JOURNAL_DIR).filter(f => f.endsWith('.jsonl')).sort();

  const rebuilt = { version: 1, created_at: new Date().toISOString(), updated_at: null, rebuilt_from: 'journal', tasks: [] };
  let applied = 0;

  files.forEach(f => {
    let lines = [];
    try { lines = fs.readFileSync(path.join(JOURNAL_DIR, f), 'utf-8').split('\n').filter(Boolean); }
    catch (e) { return; }

    lines.forEach(line => {
      let ev; try { ev = JSON.parse(line); } catch (e) { return; }
      // snapshot 之类不含任务本体的事件跳过
      if (!ev || !ev.task || !ev.task.id) return;

      const action = ev.action || 'updated';
      let rec = rebuilt.tasks.find(t => t.id === ev.task.id);
      if (!rec) {
        rec = {
          id: ev.task.id,
          project_id: ev.project_id || '',
          project_name: ev.project_name || '',
          first_created_at: ev.task.created_at || ev.at,
          first_backed_up_at: ev.at,
          last_backed_up_at: ev.at,
          last_action: action,
          deleted_at: null,
          version_count: 0,
          task: null,
          versions: []
        };
        rebuilt.tasks.push(rec);
      }

      const lastSnap = rec.versions.length ? rec.versions[rec.versions.length - 1].snapshot : null;
      if (!lastSnap || JSON.stringify(lastSnap) !== JSON.stringify(ev.task)) {
        rec.versions.push({ at: ev.at, action, snapshot: ev.task });
        if (rec.versions.length > MAX_VERSIONS_PER_TASK) rec.versions = rec.versions.slice(-MAX_VERSIONS_PER_TASK);
      }
      rec.version_count = rec.versions.length;
      rec.task = ev.task;
      rec.last_backed_up_at = ev.at;
      rec.last_action = action;
      if (ev.project_id)   rec.project_id = ev.project_id;
      if (ev.project_name) rec.project_name = ev.project_name;
      rec.deleted_at = action === 'deleted' ? ev.at : null;
      applied++;
    });
  });

  return { rebuilt, applied, files: files.length };
}

function applyRebuildFromJournal() {
  const { rebuilt, applied, files } = rebuildArchiveFromJournal();
  if (applied === 0) {
    return { error: 'journal_empty', message: '事件日志中没有可用记录，未做任何改动' };
  }

  // 先备份当前档案（可能已损坏），再覆盖，避免把仅存的线索也弄丢
  let savedAs = null;
  try {
    if (fs.existsSync(ARCHIVE_FILE) && fs.statSync(ARCHIVE_FILE).size > 0) {
      savedAs = path.join(BACKUP_DIR, `task-archive.before-rebuild-${timeStamp()}.json`);
      fs.copyFileSync(ARCHIVE_FILE, savedAs);
    }
  } catch (e) {
    console.error('[backup] 重建前备份旧档案失败:', e.message);
  }

  writeArchive(rebuilt);
  appendJournal({ at: new Date().toISOString(), action: 'rebuild', files, restored_tasks: rebuilt.tasks.length });

  return {
    success: true,
    rebuilt_tasks: rebuilt.tasks.length,
    events_applied: applied,
    journal_files: files,
    previous_archive_saved_as: savedAs ? path.basename(savedAs) : null
  };
}


function initBackup() {
  ensureBackupDirs();
  // 首次启用备份时，把看板里已有的需求全量回填进档案，避免「启用前」的需求没有备份
  try {
    const archive = readArchive();
    if (!archive.tasks.length) {
      const pData = getProjectsData();
      let n = 0;
      pData.projects.forEach(p => {
        const board = readBoard(p.id);
        (Array.isArray(board.tasks) ? board.tasks : []).forEach(t => { if (archiveTask(t, p, 'backfill')) n++; });
      });
      if (n > 0) console.log(`[backup] 已把 ${n} 条已有需求回填进备份档案`);
    }
  } catch (e) {
    console.error('[backup] 回填档案失败:', e.message);
  }
  maybeStartupSnapshot();
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
    const git = gitAvailability();
    return json(res, {
      status: 'ok',
      time: new Date().toISOString(),
      git: { available: git.available, bin: git.bin || null }
    });
  }

  // ---- /api/projects ----
  if (path_ === '/api/projects') {
    const pData = getProjectsData();
    if (method === 'GET') {
      const projectsWithStats = pData.projects.map(p => ({
        ...p,
        stats: getProjectStats(p.id)
      }));
      return json(res, {
        active_project_id: pData.active_project_id,
        projects: projectsWithStats
      });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return err(res, '项目名称不能为空', 400);

      const newId = genId('proj');
      const now = new Date().toISOString();
      const newProj = {
        id: newId,
        name: name,
        path: (body.path || '').trim(),
        color: body.color || '#58a6ff',
        icon: body.icon || '📁',
        created_at: now
      };

      pData.projects.push(newProj);
      if (body.set_active !== false) {
        pData.active_project_id = newId;
      }
      saveProjectsData(pData);
      writeBoard(newId, { tasks: [] });

      // 同步更新 config.json
      if (pData.active_project_id === newId) {
        const config = readJSON(CONFIG_FILE, {});
        writeJSON(CONFIG_FILE, { ...config, project_name: newProj.name, project_path: newProj.path });
      }

      return json(res, { ...newProj, stats: { total: 0, todo: 0, doing: 0, done: 0, todayDone: 0 } }, 201);
    }
  }

  // ---- /api/projects/active ----
  if (path_ === '/api/projects/active' && method === 'POST') {
    const body = await readBody(req);
    const targetId = body.project_id;
    const pData = getProjectsData();
    const targetProj = pData.projects.find(p => p.id === targetId);
    if (!targetProj) return err(res, '指定项目不存在', 404);

    pData.active_project_id = targetId;
    saveProjectsData(pData);

    // 同步更新 config.json
    const config = readJSON(CONFIG_FILE, {});
    writeJSON(CONFIG_FILE, { ...config, project_name: targetProj.name, project_path: targetProj.path });

    return json(res, {
      success: true,
      active_project_id: targetId,
      project: {
        ...targetProj,
        stats: getProjectStats(targetProj.id)
      }
    });
  }

  // ---- /api/projects/:id ----
  const projectMatch = path_.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const id = projectMatch[1];
    const pData = getProjectsData();
    const idx = pData.projects.findIndex(p => p.id === id);

    if (method === 'GET') {
      if (idx === -1) return err(res, 'Project not found', 404);
      return json(res, {
        ...pData.projects[idx],
        stats: getProjectStats(id),
        is_active: pData.active_project_id === id
      });
    }

    if (method === 'PATCH') {
      if (idx === -1) return err(res, 'Project not found', 404);
      const body = await readBody(req);
      const proj = pData.projects[idx];
      const updated = {
        ...proj,
        name: body.name !== undefined ? (body.name || '').trim() : proj.name,
        path: body.path !== undefined ? (body.path || '').trim() : proj.path,
        color: body.color !== undefined ? body.color : proj.color,
        icon: body.icon !== undefined ? body.icon : proj.icon
      };
      pData.projects[idx] = updated;
      saveProjectsData(pData);

      // 若修改的是激活项目，同步更新 config.json
      if (pData.active_project_id === id) {
        const config = readJSON(CONFIG_FILE, {});
        writeJSON(CONFIG_FILE, { ...config, project_name: updated.name, project_path: updated.path });
      }

      return json(res, { ...updated, stats: getProjectStats(id) });
    }

    if (method === 'DELETE') {
      if (idx === -1) return err(res, 'Project not found', 404);
      const deleted = pData.projects.splice(idx, 1)[0];

      // 若删除的是当前激活项目，自动切换到剩余的第一个
      if (pData.active_project_id === id) {
        if (pData.projects.length > 0) {
          pData.active_project_id = pData.projects[0].id;
        } else {
          // 重新补一个默认项目
          const defaultId = 'proj_' + Date.now();
          const defaultProj = {
            id: defaultId,
            name: '默认项目',
            path: '',
            color: '#58a6ff',
            icon: '⚡',
            created_at: new Date().toISOString()
          };
          pData.projects.push(defaultProj);
          pData.active_project_id = defaultId;
          writeBoard(defaultId, { tasks: [] });
        }
      }

      saveProjectsData(pData);

      // 删除项目前，先把该项目下所有需求备份进档案（标记为已删除），避免整块看板数据丢失
      try {
        const doomedBoard = readBoard(id);
        (Array.isArray(doomedBoard.tasks) ? doomedBoard.tasks : []).forEach(t => archiveTask(t, deleted, 'deleted'));
      } catch (e) { console.error('[backup] 备份被删项目需求失败:', e.message); }

      // 清理对应的看板数据文件
      const boardFile = getBoardFile(id);
      try { if (fs.existsSync(boardFile)) fs.unlinkSync(boardFile); } catch (e) {}

      // 同步当前激活项目的 config
      const activeProj = getActiveProject();
      const config = readJSON(CONFIG_FILE, {});
      writeJSON(CONFIG_FILE, { ...config, project_name: activeProj.name, project_path: activeProj.path });

      return json(res, {
        deleted,
        active_project_id: pData.active_project_id,
        active_project: activeProj
      });
    }
  }

  // ---- /api/config ----
  if (path_ === '/api/config') {
    const activeProj = getActiveProject();
    const config = readJSON(CONFIG_FILE, { git_refresh_interval: 5000, milestones: [] });
    if (method === 'GET') {
      return json(res, {
        ...config,
        project_name: activeProj.name,
        project_path: activeProj.path,
        project_id: activeProj.id
      });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const updated = { ...config, ...body };
      writeJSON(CONFIG_FILE, updated);

      // 同步更新当前激活项目
      if (body.project_name !== undefined || body.project_path !== undefined) {
        const pData = getProjectsData();
        const cur = pData.projects.find(p => p.id === pData.active_project_id);
        if (cur) {
          if (body.project_name !== undefined) cur.name = body.project_name.trim();
          if (body.project_path !== undefined) cur.path = body.project_path.trim();
          saveProjectsData(pData);
        }
      }

      // 重新读取激活项目，确保响应是最新值
      const freshProj = getActiveProject();
      return json(res, {
        ...updated,
        project_name: freshProj.name,
        project_path: freshProj.path,
        project_id: freshProj.id
      });

    }
  }

  // ---- /api/tasks/stats/summary ----
  if (path_ === '/api/tasks/stats/summary') {
    const targetProjId = url.searchParams.get('project_id') || getActiveProject().id;
    return json(res, getProjectStats(targetProjId));
  }

  // ---- /api/tasks/trash (GET 列表, DELETE/POST 清空) ----
  if (path_ === '/api/tasks/trash') {
    const targetProjId = url.searchParams.get('project_id') || getActiveProject().id;
    const data = readBoard(targetProjId);
    const allList = Array.isArray(data.tasks) ? data.tasks : [];

    if (method === 'GET') {
      const trashTasks = allList
        .filter(t => !!t.deleted_at)
        .sort((a, b) => new Date(b.deleted_at || 0) - new Date(a.deleted_at || 0));
      return json(res, { tasks: trashTasks, count: trashTasks.length, project_id: targetProjId });
    }

    if (method === 'DELETE' || method === 'POST') {
      const purged = allList.filter(t => !!t.deleted_at);
      const remaining = allList.filter(t => !t.deleted_at);
      const deletedCount = allList.length - remaining.length;
      data.tasks = remaining;
      writeBoard(targetProjId, data);
      // 记录一次清空事件。需求本体仍留在备份档案里（清空前已归档），
      // 这里只是留个可追溯的痕迹，便于日后查「某条需求去哪了」。
      if (purged.length) {
        appendJournal({
          at: new Date().toISOString(),
          action: 'trash_purged',
          project_id: targetProjId,
          project_name: (findProjectById(targetProjId) || {}).name || '',
          count: purged.length,
          task_ids: purged.map(t => t.id)
        });
      }
      return json(res, { success: true, deleted_count: deletedCount, project_id: targetProjId });
    }
  }

  // ---- /api/tasks ----
  if (path_ === '/api/tasks') {
    const targetProjId = url.searchParams.get('project_id') || getActiveProject().id;
    const data = readBoard(targetProjId);
    if (method === 'GET') {
      let allList = Array.isArray(data.tasks) ? data.tasks : [];
      let tasks = allList.filter(t => !t.deleted_at);
      const status   = url.searchParams.get('status');
      const priority = url.searchParams.get('priority');
      if (status)   tasks = tasks.filter(t => t.status === status);
      if (priority) tasks = tasks.filter(t => t.priority === priority);
      const trashCount = allList.filter(t => !!t.deleted_at).length;
      return json(res, { tasks, trash_count: trashCount, project_id: targetProjId });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const now  = new Date().toISOString();
      const task = {
        id: genId('task'),
        title:    body.title || '未命名需求',
        status:   body.status || 'todo',
        priority: body.priority || 'medium',
        prompt:   body.prompt || '',
        created_at: now,
        started_at: (body.status === 'doing' || body.status === 'done') ? now : (body.started_at || null),
        done_at:    body.status === 'done'  ? now : null,
        linked_commits: body.linked_commits || [],
        tags:           body.tags || [],
        milestone_id:   body.milestone_id || '',
        deleted_at:     null
      };
      if (!Array.isArray(data.tasks)) data.tasks = [];
      data.tasks.unshift(task);
      writeBoard(targetProjId, data);
      // 落盘备份：新建的需求立刻进入备份档案 + 事件日志
      archiveTask(task, findProjectById(targetProjId), 'created');
      return json(res, task, 201);
    }
  }

  // ---- /api/tasks/:id/trash (移入垃圾箱) ----
  const taskTrashMatch = path_.match(/^\/api\/tasks\/([^/]+)\/trash$/);
  if (taskTrashMatch && method === 'POST') {
    const id = taskTrashMatch[1];
    let targetProjId = url.searchParams.get('project_id') || getActiveProject().id;
    let data = readBoard(targetProjId);
    let idx = Array.isArray(data.tasks) ? data.tasks.findIndex(t => t.id === id) : -1;
    if (idx === -1 && !url.searchParams.get('project_id')) {
      const pData = getProjectsData();
      for (const p of pData.projects) {
        const board = readBoard(p.id);
        const fIdx = Array.isArray(board.tasks) ? board.tasks.findIndex(t => t.id === id) : -1;
        if (fIdx !== -1) {
          targetProjId = p.id;
          data = board;
          idx = fIdx;
          break;
        }
      }
    }
    if (idx === -1) return err(res, 'Task not found', 404);
    const task = data.tasks[idx];
    task.deleted_at = new Date().toISOString();
    task.status_before_delete = task.status;
    writeBoard(targetProjId, data);
    // 落盘备份：移入垃圾箱等同于「删除」，必须同步进备份档案，
    // 否则「清空垃圾箱」之后这条需求就彻底没救了
    archiveTask(task, findProjectById(targetProjId), 'deleted');
    const trashCount = data.tasks.filter(t => !!t.deleted_at).length;
    return json(res, { ...task, trash_count: trashCount });
  }

  // ---- /api/tasks/:id/restore (从垃圾箱还原) ----
  const taskRestoreMatch = path_.match(/^\/api\/tasks\/([^/]+)\/restore$/);
  if (taskRestoreMatch && method === 'POST') {
    const id = taskRestoreMatch[1];
    let targetProjId = url.searchParams.get('project_id') || getActiveProject().id;
    let data = readBoard(targetProjId);
    let idx = Array.isArray(data.tasks) ? data.tasks.findIndex(t => t.id === id) : -1;
    if (idx === -1 && !url.searchParams.get('project_id')) {
      const pData = getProjectsData();
      for (const p of pData.projects) {
        const board = readBoard(p.id);
        const fIdx = Array.isArray(board.tasks) ? board.tasks.findIndex(t => t.id === id) : -1;
        if (fIdx !== -1) {
          targetProjId = p.id;
          data = board;
          idx = fIdx;
          break;
        }
      }
    }
    if (idx === -1) return err(res, 'Task not found', 404);
    const task = data.tasks[idx];
    task.deleted_at = null;
    if (task.status_before_delete) {
      task.status = task.status_before_delete;
      delete task.status_before_delete;
    }
    writeBoard(targetProjId, data);
    // 落盘备份：从垃圾箱还原后，档案里的 deleted_at 标记也要一并清掉
    archiveTask(task, findProjectById(targetProjId), 'restored');
    const trashCount = data.tasks.filter(t => !!t.deleted_at).length;
    return json(res, { ...task, trash_count: trashCount });
  }

  // ---- /api/tasks/:id ----
  const taskMatch = path_.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const id = taskMatch[1];
    let targetProjId = url.searchParams.get('project_id') || getActiveProject().id;
    let data = readBoard(targetProjId);
    let idx = Array.isArray(data.tasks) ? data.tasks.findIndex(t => t.id === id) : -1;

    // 若当前项目中未找到，且用户未显式传 project_id，遍历搜索所有项目的看板
    if (idx === -1 && !url.searchParams.get('project_id')) {
      const pData = getProjectsData();
      for (const p of pData.projects) {
        const board = readBoard(p.id);
        const fIdx = Array.isArray(board.tasks) ? board.tasks.findIndex(t => t.id === id) : -1;
        if (fIdx !== -1) {
          targetProjId = p.id;
          data = board;
          idx = fIdx;
          break;
        }
      }
    }

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
      writeBoard(targetProjId, data);
      // 落盘备份：记录本次修改后的完整内容（内容有变化时追加一个历史版本）
      archiveTask(data.tasks[idx], findProjectById(targetProjId), 'updated');
      return json(res, data.tasks[idx]);
    }
    if (method === 'DELETE') {
      if (idx === -1) return err(res, 'Task not found', 404);
      const deleted = data.tasks.splice(idx, 1)[0];
      writeBoard(targetProjId, data);
      // 落盘备份：删除的需求保留在档案里并标记 deleted_at，可随时恢复
      archiveTask(deleted, findProjectById(targetProjId), 'deleted');
      return json(res, deleted);
    }
  }

  // ---- /api/git/status ----
  if (path_ === '/api/git/status') {
    const activeProj  = getActiveProject();
    const config      = readJSON(CONFIG_FILE, {});
    const projectPath = url.searchParams.get('path') || activeProj.path || config.project_path || '';
    return json(res, gitStatus(projectPath));
  }

  // ---- /api/git/diff ----
  if (path_ === '/api/git/diff') {
    const activeProj  = getActiveProject();
    const config      = readJSON(CONFIG_FILE, {});
    const projectPath = url.searchParams.get('path') || activeProj.path || config.project_path || '';
    return json(res, gitDiff(projectPath));
  }

  // ---- /api/git/commits (支持按分支获取提交历史) ----
  if (path_ === '/api/git/commits') {
    const activeProj  = getActiveProject();
    const config      = readJSON(CONFIG_FILE, {});
    const projectPath = url.searchParams.get('path') || activeProj.path || config.project_path || '';
    const branch      = url.searchParams.get('branch') || '';
    return json(res, gitBranchCommits(projectPath, branch));
  }

  // ---- /api/browse - 文件夹浏览器 ----
  if (path_ === '/api/browse') {
    let reqPath = (url.searchParams.get('path') || '').trim();
    let targetDir = reqPath;

    // 若未指定路径，优先使用当前活跃项目的路径，其次使用当前工作区 process.cwd()
    if (!targetDir) {
      const activeProj = getActiveProject();
      if (activeProj && activeProj.path && fs.existsSync(activeProj.path)) {
        targetDir = activeProj.path;
      } else {
        targetDir = process.cwd();
      }
    }

    try {
      if (!fs.existsSync(targetDir)) {
        const fallback = process.cwd();
        return json(res, {
          error: `路径不存在: ${targetDir}`,
          path: fs.existsSync(fallback) ? fallback : targetDir,
          items: []
        });
      }

      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        return json(res, { error: '不是文件夹', path: targetDir, items: [] });
      }

      let entries = [];
      try {
        entries = fs.readdirSync(targetDir, { withFileTypes: true });
      } catch (readErr) {
        return json(res, {
          error: `无法读取该目录 (${readErr.message})，可能缺少访问权限`,
          path: targetDir,
          is_git: fs.existsSync(path.join(targetDir, '.git')),
          parent: path.dirname(targetDir) !== targetDir ? path.dirname(targetDir) : null,
          items: []
        });
      }

      const items = [];
      for (const entry of entries) {
        try {
          if (entry.name.startsWith('.') && entry.name !== '.git') continue;
          if (!entry.isDirectory()) continue;
          const fullPath = path.join(targetDir, entry.name);
          const isGitRepo = entry.name === '.git' ? false : fs.existsSync(path.join(fullPath, '.git'));
          items.push({
            name: entry.name,
            path: fullPath,
            is_git: isGitRepo
          });
        } catch (itemErr) {
          // 忽略单个权限受限子项
        }
      }

      // .git 存在于当前目录 → 当前目录本身是 git 仓库
      const selfIsGit = fs.existsSync(path.join(targetDir, '.git'));
      items.sort((a, b) => {
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

  // ---- /api/backups - 备份概览 ----
  if (path_ === '/api/backups' && method === 'GET') {
    return json(res, getBackupSummary());
  }

  // ---- /api/backups/archive - 备份档案列表 ----
  if (path_ === '/api/backups/archive' && method === 'GET') {
    const archive = readArchive();
    const q         = (url.searchParams.get('q') || '').trim().toLowerCase();
    const projectId = url.searchParams.get('project_id') || '';
    const onlyDeleted = url.searchParams.get('deleted') === '1';

    // 按「最近一次备份时间」倒序：用户翻档案时最关心刚动过的那几条，
    // 而不是最早被收录的那几条（档案数组本身是按首次收录顺序追加的）。
    let list = (archive.tasks || []).slice().sort((x, y) =>
      String(y.last_backed_up_at || '').localeCompare(String(x.last_backed_up_at || ''))
    );
    if (projectId)   list = list.filter(t => t.project_id === projectId);
    if (onlyDeleted) list = list.filter(t => !!t.deleted_at);
    if (q) {
      list = list.filter(t => {
        const tk = t.task || {};
        return (tk.title || '').toLowerCase().includes(q) ||
               (tk.prompt || '').toLowerCase().includes(q) ||
               (tk.tags || []).some(x => String(x).toLowerCase().includes(q));
      });
    }

    const items = list.map(t => {
      const tk = t.task || {};
      return {
        id: t.id,
        title: tk.title || '(无标题)',
        status: tk.status || 'todo',
        priority: tk.priority || 'medium',
        tags: tk.tags || [],
        prompt: tk.prompt || '',
        project_id: t.project_id || '',
        project_name: t.project_name || '',
        first_created_at: t.first_created_at || '',
        last_backed_up_at: t.last_backed_up_at || '',
        last_action: t.last_action || '',
        deleted_at: t.deleted_at || null,
        version_count: t.version_count || (Array.isArray(t.versions) ? t.versions.length : 0)
      };
    });
    return json(res, { total: items.length, items });
  }

  // ---- /api/backups/journal - 事件日志（按天） ----
  if (path_ === '/api/backups/journal' && method === 'GET') {
    return json(res, readJournal(url.searchParams.get('date')));
  }

  // ---- /api/backups/snapshot - 手动全量快照 ----
  if (path_ === '/api/backups/snapshot' && method === 'POST') {
    const snap = createSnapshot('manual');
    return json(res, { success: true, ...snap }, 201);
  }

  // ---- /api/backups/restore - 从备份档案恢复需求 ----
  if (path_ === '/api/backups/restore' && method === 'POST') {
    const body = await readBody(req);
    if (!body.task_id) return err(res, '缺少 task_id', 400);
    const result = restoreTaskFromArchive(body.task_id, body.project_id);
    if (result.error) {
      return err(res, result.message || result.error, result.error === 'already_exists' ? 409 : 404);
    }
    return json(res, { success: true, ...result });
  }

  // ---- /api/backups/rebuild - 从事件日志重建档案（灾备） ----
  if (path_ === '/api/backups/rebuild') {
    if (method === 'GET') {
      // 预览：只统计能重放出什么，不落盘
      const { rebuilt, applied, files } = rebuildArchiveFromJournal();
      return json(res, {
        preview: true,
        journal_files: files,
        events_applied: applied,
        would_rebuild_tasks: rebuilt.tasks.length,
        would_rebuild_deleted: rebuilt.tasks.filter(t => !!t.deleted_at).length
      });
    }
    if (method === 'POST') {
      const result = applyRebuildFromJournal();
      if (result.error) return err(res, result.message || result.error, 400);
      return json(res, result);
    }
  }

  // ---- /api/backups/export - 导出全部备份（档案 + 当前看板） ----
  if (path_ === '/api/backups/export' && method === 'GET') {
    const archive = readArchive();
    const pData   = getProjectsData();
    const boards  = {};
    pData.projects.forEach(p => { boards[p.id] = readBoard(p.id); });

    const payload = {
      exported_at: new Date().toISOString(),
      generator: 'vibe-coding-dashboard',
      archive,
      projects: pData.projects,
      boards
    };
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="vibe-backup-${timeStamp()}.json"`
    });
    return res.end(JSON.stringify(payload, null, 2));
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

if (require.main === module) {
  // 启动前初始化本地备份：回填历史需求 + 生成当天全量快照
  initBackup();

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════╗');
    console.log('║   ⚡ Vibe Coding 仪表盘 已启动！      ║');
    console.log(`║   👉 http://localhost:${PORT}           ║`);
    console.log('╚═══════════════════════════════════════╝');
    console.log('');
    console.log(`仅本机可访问（${HOST}:${PORT}）`);
    console.log(`🗄️  需求备份目录：${BACKUP_DIR}`);
    console.log('按 Ctrl+C 停止服务');
  });
}

module.exports = {
  server, handleRequest, getProjectsData, getActiveProject, readBoard, writeBoard, initDataStorage,
  // 备份模块
  initBackup, archiveTask, createSnapshot, readArchive, getBackupSummary, restoreTaskFromArchive,
  BACKUP_DIR, ARCHIVE_FILE
};
