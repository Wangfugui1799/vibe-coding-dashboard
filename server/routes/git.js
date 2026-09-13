const express = require('express');
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const router = express.Router();
const CONFIG_PATH = path.join(__dirname, '../data/config.json');

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    return { project_path: '' };
  }
}

function runGit(cmd, cwd) {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch (e) {
    return null;
  }
}

// GET /api/git/status - 获取 Git 状态
router.get('/status', (req, res) => {
  const config = getConfig();
  const projectPath = req.query.path || config.project_path;

  if (!projectPath || !fs.existsSync(projectPath)) {
    return res.json({
      error: 'project_path_not_set',
      message: '请在设置中配置 Git 项目路径'
    });
  }

  // 检查是否是 git 仓库
  const isGit = runGit('rev-parse --git-dir', projectPath);
  if (!isGit) {
    return res.json({
      error: 'not_a_git_repo',
      message: '该路径不是 Git 仓库'
    });
  }

  // 当前分支
  const branch = runGit('branch --show-current', projectPath) || 'HEAD detached';

  // 最新 commit
  const lastCommit = runGit('log -1 --pretty=format:"%H|%s|%an|%ar"', projectPath);
  let commit = null;
  if (lastCommit) {
    const [hash, message, author, time] = lastCommit.split('|');
    commit = { hash: hash?.slice(0, 7), full_hash: hash, message, author, time };
  }

  // 工作区状态
  const statusOutput = runGit('status --porcelain', projectPath) || '';
  const lines = statusOutput ? statusOutput.split('\n').filter(Boolean) : [];
  const staged = lines.filter(l => !'? '.includes(l[0])).length;
  const modified = lines.filter(l => l[1] === 'M' || l[1] === 'D').length;
  const untracked = lines.filter(l => l.startsWith('??')).length;

  // 远程同步状态
  const remoteStatus = runGit('rev-list --count --left-right @{upstream}...HEAD', projectPath);
  let ahead = 0, behind = 0;
  if (remoteStatus) {
    const parts = remoteStatus.split('\t');
    behind = parseInt(parts[0]) || 0;
    ahead = parseInt(parts[1]) || 0;
  }

  // 最近提交历史（10条）
  const logOutput = runGit('log -10 --pretty=format:"%H|%s|%an|%ar|%ai"', projectPath);
  const commits = [];
  if (logOutput) {
    logOutput.split('\n').forEach(line => {
      const parts = line.split('|');
      if (parts.length >= 5) {
        commits.push({
          hash: parts[0].slice(0, 7),
          full_hash: parts[0],
          message: parts[1],
          author: parts[2],
          relative_time: parts[3],
          datetime: parts[4]
        });
      }
    });
  }

  res.json({
    branch,
    commit,
    changes: { staged, modified, untracked, total: lines.length },
    sync: { ahead, behind },
    commits,
    project_path: projectPath,
    checked_at: new Date().toISOString()
  });
});

// GET /api/git/log - 获取提交历史（更多）
router.get('/log', (req, res) => {
  const config = getConfig();
  const projectPath = req.query.path || config.project_path;
  const limit = parseInt(req.query.limit) || 20;

  if (!projectPath || !fs.existsSync(projectPath)) {
    return res.json({ commits: [] });
  }

  const logOutput = runGit(`log -${limit} --pretty=format:"%H|%s|%an|%ar|%ai"`, projectPath);
  const commits = [];
  if (logOutput) {
    logOutput.split('\n').forEach(line => {
      const parts = line.split('|');
      if (parts.length >= 5) {
        commits.push({
          hash: parts[0].slice(0, 7),
          full_hash: parts[0],
          message: parts[1],
          author: parts[2],
          relative_time: parts[3],
          datetime: parts[4]
        });
      }
    });
  }
  res.json({ commits });
});

// GET /api/git/diff - 获取文件变更详情
router.get('/diff', (req, res) => {
  const config = getConfig();
  const projectPath = req.query.path || config.project_path;
  if (!projectPath || !fs.existsSync(projectPath)) {
    return res.json({ files: [] });
  }
  const statusOutput = runGit('status --porcelain', projectPath) || '';
  const files = statusOutput ? statusOutput.split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim(),
    file: line.slice(3)
  })) : [];
  res.json({ files });
});

module.exports = router;
