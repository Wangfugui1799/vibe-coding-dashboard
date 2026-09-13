const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('crypto');

const router = express.Router();
const DATA_PATH = path.join(__dirname, '../data/tasks.json');

// 生成简单 ID
function genId() {
  return 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

// 读取数据
function readTasks() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return { tasks: [] };
  }
}

// 写入数据
function writeTasks(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// GET /api/tasks - 获取所有任务
router.get('/', (req, res) => {
  const data = readTasks();
  const { status, priority } = req.query;
  let tasks = data.tasks;
  if (status) tasks = tasks.filter(t => t.status === status);
  if (priority) tasks = tasks.filter(t => t.priority === priority);
  res.json({ tasks });
});

// GET /api/tasks/:id - 获取单个任务
router.get('/:id', (req, res) => {
  const data = readTasks();
  const task = data.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// POST /api/tasks - 创建任务
router.post('/', (req, res) => {
  const data = readTasks();
  const now = new Date().toISOString();
  const task = {
    id: genId(),
    title: req.body.title || '未命名需求',
    status: req.body.status || 'todo',
    priority: req.body.priority || 'medium',
    prompt: req.body.prompt || '',
    created_at: now,
    started_at: req.body.status === 'doing' ? now : null,
    done_at: req.body.status === 'done' ? now : null,
    linked_commits: req.body.linked_commits || [],
    tags: req.body.tags || [],
    milestone_id: req.body.milestone_id || ''
  };
  data.tasks.unshift(task);
  writeTasks(data);
  res.status(201).json(task);
});

// PATCH /api/tasks/:id - 更新任务
router.patch('/:id', (req, res) => {
  const data = readTasks();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });

  const task = data.tasks[idx];
  const now = new Date().toISOString();

  // 状态变更时自动记录时间
  if (req.body.status && req.body.status !== task.status) {
    if (req.body.status === 'doing' && !task.started_at) {
      req.body.started_at = now;
    }
    if (req.body.status === 'done') {
      req.body.done_at = now;
      if (!task.started_at) req.body.started_at = now;
    }
  }

  data.tasks[idx] = { ...task, ...req.body };
  writeTasks(data);
  res.json(data.tasks[idx]);
});

// DELETE /api/tasks/:id - 删除任务
router.delete('/:id', (req, res) => {
  const data = readTasks();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  const deleted = data.tasks.splice(idx, 1)[0];
  writeTasks(data);
  res.json(deleted);
});

// POST /api/tasks/:id/link-commit - 关联 commit
router.post('/:id/link-commit', (req, res) => {
  const data = readTasks();
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  const { commit_hash } = req.body;
  if (!data.tasks[idx].linked_commits.includes(commit_hash)) {
    data.tasks[idx].linked_commits.push(commit_hash);
  }
  writeTasks(data);
  res.json(data.tasks[idx]);
});

// GET /api/tasks/stats/summary - 统计摘要
router.get('/stats/summary', (req, res) => {
  const data = readTasks();
  const tasks = data.tasks;
  const todo = tasks.filter(t => t.status === 'todo').length;
  const doing = tasks.filter(t => t.status === 'doing').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const total = tasks.length;

  // 今日完成
  const today = new Date().toDateString();
  const todayDone = tasks.filter(t => {
    if (!t.done_at) return false;
    return new Date(t.done_at).toDateString() === today;
  }).length;

  res.json({ total, todo, doing, done, todayDone });
});

module.exports = router;
