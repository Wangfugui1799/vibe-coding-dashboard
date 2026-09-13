/* =============================================
   Vibe Coding 仪表盘 - 主逻辑 app.js
   ============================================= */

const API = 'http://localhost:3333/api';

// ======= 全局状态 =======
let allTasks = [];
let editingTaskId = null;
let gitRefreshTimer = null;
let gitRefreshInterval = 5000;
let currentConfig = {};

// ======= Prompt 模板库 =======
const PROMPT_TEMPLATES = [
  {
    icon: '✨',
    name: '实现新功能',
    content: `## 背景与目标
<!-- 说明为什么需要这个功能，解决什么用户问题 -->

## 具体要求
- [ ] 功能点一
- [ ] 功能点二
- [ ] 功能点三

## 技术约束
- 技术栈：
- 禁止引入新依赖：
- 必须兼容：

## UI/UX 要求
- 样式风格：与现有页面保持一致
- 响应式：需要兼容移动端

## 验收标准
- [ ] 功能正常运行，无报错
- [ ] 代码有适当注释
- [ ] 通过手动测试`
  },
  {
    icon: '🐛',
    name: '修复 Bug',
    content: `## Bug 描述
<!-- 描述问题的表现，越具体越好 -->

## 复现步骤
1. 步骤一
2. 步骤二
3. 观察到的错误现象

## 期望行为
<!-- 正确情况下应该是什么样的 -->

## 可能原因
<!-- 你的初步判断（可选） -->

## 技术约束
- 不要改变现有 API 接口
- 保持向后兼容

## 验收标准
- [ ] Bug 不再复现
- [ ] 没有引入新问题
- [ ] 相关边界情况已处理`
  },
  {
    icon: '🔧',
    name: '代码重构',
    content: `## 重构目标
<!-- 说明为什么要重构，当前代码的问题是什么 -->

## 重构范围
- 文件/模块：
- 涉及的函数/类：

## 重构方向
- [ ] 拆分过长的函数
- [ ] 提取公共逻辑
- [ ] 改善命名可读性
- [ ] 减少重复代码

## 技术约束
- **不能改变外部行为**，只改内部实现
- 保持所有现有功能正常工作
- 不引入新的依赖

## 验收标准
- [ ] 所有原有功能运行正常
- [ ] 代码更易读、易维护
- [ ] 无新增 Bug`
  },
  {
    icon: '🧪',
    name: '编写测试',
    content: `## 测试目标
<!-- 要为哪个模块/函数编写测试 -->

## 测试范围
- 单元测试：
- 集成测试：
- 边界情况：

## 测试框架
- 使用：（Jest / Vitest / Mocha 等）

## 需要覆盖的场景
- [ ] 正常输入，期望正确输出
- [ ] 边界值（空值、最大值、最小值）
- [ ] 错误输入，期望优雅处理
- [ ] 异步场景（如有）

## 验收标准
- [ ] 测试覆盖率 > 80%
- [ ] 所有测试通过
- [ ] 测试命名清晰，可读性强`
  }
];

// ======= 工具函数 =======
async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json();
}

function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast show ${type}`;
  setTimeout(() => { toast.className = 'toast'; }, 2800);
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function priorityLabel(p) {
  return { high: '🔴 高', medium: '🟡 中', low: '🟢 低' }[p] || '🟡 中';
}

// ======= Tab 切换 =======
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      if (tab === 'git') startGitRefresh();
      if (tab === 'settings') loadSettings();
      if (tab === 'editor') populateEditorTaskSelect();
    });
  });
}

// ======= Kanban 看板 =======
async function loadTasks() {
  try {
    const data = await api('/tasks');
    allTasks = data.tasks;
    renderKanban();
    updateBadges();
  } catch (e) {
    showToast('加载任务失败，请检查服务是否启动', 'error');
  }
}

function filterTasks(tasks) {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const priority = document.getElementById('filterPriority').value;
  return tasks.filter(t => {
    const matchSearch = !search || t.title.toLowerCase().includes(search) ||
      (t.prompt || '').toLowerCase().includes(search) ||
      (t.tags || []).some(tag => tag.toLowerCase().includes(search));
    const matchPriority = !priority || t.priority === priority;
    return matchSearch && matchPriority;
  });
}

function renderKanban() {
  const filtered = filterTasks(allTasks);
  const cols = { todo: [], doing: [], done: [] };
  filtered.forEach(t => { if (cols[t.status]) cols[t.status].push(t); });

  ['todo', 'doing', 'done'].forEach(status => {
    const container = document.getElementById(`cards-${status}`);
    const count = document.getElementById(`count-${status}`);
    count.textContent = cols[status].length;

    if (cols[status].length === 0) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">${status === 'todo' ? '📝' : status === 'doing' ? '🔄' : '🎉'}</div>
        <div>${status === 'done' ? '暂无已完成的需求' : '拖拽卡片到此处'}</div>
      </div>`;
    } else {
      container.innerHTML = cols[status].map(t => renderCard(t)).join('');
      // 绑定卡片事件
      container.querySelectorAll('.task-card').forEach(card => {
        const id = card.dataset.id;
        card.addEventListener('click', (e) => {
          if (e.target.closest('.card-action-btn')) return;
          openTaskModal(id);
        });

        // 快捷操作按钮
        card.querySelector('.btn-edit')?.addEventListener('click', (e) => {
          e.stopPropagation();
          openTaskModal(id);
        });
        card.querySelector('.btn-copy')?.addEventListener('click', (e) => {
          e.stopPropagation();
          copyPrompt(id);
        });
        card.querySelector('.btn-delete')?.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteTask(id);
        });
        card.querySelector('.btn-move-next')?.addEventListener('click', (e) => {
          e.stopPropagation();
          moveNext(id);
        });

        // 拖拽
        card.setAttribute('draggable', true);
        card.addEventListener('dragstart', () => {
          card.classList.add('dragging');
          localStorage.setItem('draggingId', id);
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('dragging');
        });
      });
    }
  });

  // 拖拽放置区
  document.querySelectorAll('.kanban-col').forEach(col => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = localStorage.getItem('draggingId');
      const newStatus = col.dataset.status;
      if (!id || !newStatus) return;
      await updateTaskStatus(id, newStatus);
    });
  });
}

function renderCard(task) {
  const tags = (task.tags || []).map(t => `<span class="card-tag">${t}</span>`).join('');
  const nextBtn = task.status === 'todo'
    ? `<button class="card-action-btn btn-move-next" title="开始">▶</button>`
    : task.status === 'doing'
    ? `<button class="card-action-btn btn-move-next" title="完成">✔</button>`
    : '';

  const commits = task.linked_commits?.length
    ? `<div class="card-commit">📎 ${task.linked_commits.slice(-1)[0]}</div>`
    : '';

  const timeInfo = task.status === 'done' && task.done_at
    ? `✅ ${formatTime(task.done_at)}`
    : task.status === 'doing' && task.started_at
    ? `▶ ${formatTime(task.started_at)}`
    : `📅 ${formatTime(task.created_at)}`;

  return `
    <div class="task-card priority-${task.priority}" data-id="${task.id}">
      <div class="card-priority-bar"></div>
      <div class="card-title">${escHtml(task.title)}</div>
      ${tags ? `<div class="card-tags">${tags}</div>` : ''}
      ${commits}
      <div class="card-meta">
        <span>${timeInfo}</span>
        <div class="card-actions">
          ${nextBtn}
          <button class="card-action-btn btn-copy" title="复制 Prompt">📋</button>
          <button class="card-action-btn btn-edit" title="编辑">✏️</button>
          <button class="card-action-btn btn-delete" title="删除">🗑</button>
        </div>
      </div>
    </div>`;
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateBadges() {
  const todo  = allTasks.filter(t => t.status === 'todo').length;
  const doing = allTasks.filter(t => t.status === 'doing').length;
  const done  = allTasks.filter(t => t.status === 'done').length;
  document.getElementById('badgeTodo').textContent  = `${todo} 待做`;
  document.getElementById('badgeDoing').textContent = `${doing} 进行中`;
  document.getElementById('badgeDone').textContent  = `${done} 完成`;
}

async function updateTaskStatus(id, status) {
  try {
    const updated = await api(`/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
    const idx = allTasks.findIndex(t => t.id === id);
    if (idx !== -1) allTasks[idx] = updated;
    renderKanban();
    updateBadges();
    const labels = { todo: '移回待做', doing: '开始进行', done: '标记完成 ✅' };
    showToast(labels[status] || '已更新', 'success');
  } catch (e) {
    showToast('更新失败', 'error');
  }
}

async function moveNext(id) {
  const task = allTasks.find(t => t.id === id);
  if (!task) return;
  const next = { todo: 'doing', doing: 'done' }[task.status];
  if (next) await updateTaskStatus(id, next);
}

async function deleteTask(id) {
  const task = allTasks.find(t => t.id === id);
  if (!task) return;
  if (!confirm(`确认删除需求「${task.title}」？`)) return;
  try {
    await api(`/tasks/${id}`, { method: 'DELETE' });
    allTasks = allTasks.filter(t => t.id !== id);
    renderKanban();
    updateBadges();
    showToast('需求已删除', 'success');
  } catch (e) {
    showToast('删除失败', 'error');
  }
}

function copyPrompt(id) {
  const task = allTasks.find(t => t.id === id);
  if (!task || !task.prompt) {
    showToast('该需求没有 Prompt 内容', 'error');
    return;
  }
  const text = `# ${task.title}\n\n${task.prompt}`;
  navigator.clipboard.writeText(text).then(() => {
    showToast('📋 Prompt 已复制到剪贴板！', 'success');
  }).catch(() => {
    showToast('复制失败，请手动复制', 'error');
  });
}

// ======= 任务 Modal =======
function openTaskModal(id = null) {
  editingTaskId = id;
  const modal = document.getElementById('taskModal');
  const title = document.getElementById('modalTitle');

  if (id) {
    const task = allTasks.find(t => t.id === id);
    if (!task) return;
    title.textContent = '编辑需求';
    document.getElementById('modalTaskTitle').value = task.title;
    document.getElementById('modalTaskStatus').value = task.status;
    document.getElementById('modalTaskPriority').value = task.priority;
    document.getElementById('modalTaskTags').value = (task.tags || []).join(', ');
    document.getElementById('modalTaskPrompt').value = task.prompt || '';
  } else {
    title.textContent = '新建需求';
    document.getElementById('modalTaskTitle').value = '';
    document.getElementById('modalTaskStatus').value = 'todo';
    document.getElementById('modalTaskPriority').value = 'medium';
    document.getElementById('modalTaskTags').value = '';
    document.getElementById('modalTaskPrompt').value = '';
  }

  modal.classList.add('open');
  document.getElementById('modalTaskTitle').focus();
}

function closeModal() {
  document.getElementById('taskModal').classList.remove('open');
  editingTaskId = null;
}

async function saveTask() {
  const title = document.getElementById('modalTaskTitle').value.trim();
  if (!title) {
    showToast('请填写需求标题', 'error');
    return;
  }

  const body = {
    title,
    status: document.getElementById('modalTaskStatus').value,
    priority: document.getElementById('modalTaskPriority').value,
    tags: document.getElementById('modalTaskTags').value.split(',').map(t => t.trim()).filter(Boolean),
    prompt: document.getElementById('modalTaskPrompt').value
  };

  try {
    if (editingTaskId) {
      const updated = await api(`/tasks/${editingTaskId}`, {
        method: 'PATCH', body: JSON.stringify(body)
      });
      const idx = allTasks.findIndex(t => t.id === editingTaskId);
      if (idx !== -1) allTasks[idx] = updated;
      showToast('需求已更新 ✅', 'success');
    } else {
      const created = await api('/tasks', { method: 'POST', body: JSON.stringify(body) });
      allTasks.unshift(created);
      showToast('需求已创建 ✅', 'success');
    }
    closeModal();
    renderKanban();
    updateBadges();
  } catch (e) {
    showToast('保存失败', 'error');
  }
}

function initModal() {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalSave').addEventListener('click', saveTask);
  document.getElementById('taskModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('taskModal')) closeModal();
  });

  // 在编辑器中打开
  document.getElementById('modalOpenEditor').addEventListener('click', () => {
    const title = document.getElementById('modalTaskTitle').value;
    const prompt = document.getElementById('modalTaskPrompt').value;
    const priority = document.getElementById('modalTaskPriority').value;
    document.getElementById('editorTitle').value = title;
    document.getElementById('promptEditor').value = prompt;
    document.getElementById('editorPriority').value = priority;
    updatePreview();
    closeModal();
    // 切换到编辑器 tab
    document.querySelector('[data-tab="editor"]').click();
    if (editingTaskId) {
      document.getElementById('editorTaskLink').value = editingTaskId;
    }
  });

  // 新建按钮
  document.getElementById('btnNewTask').addEventListener('click', () => openTaskModal());

  // 列底部添加按钮
  document.querySelectorAll('.col-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openTaskModal();
      document.getElementById('modalTaskStatus').value = btn.dataset.status;
    });
  });

  // 搜索/过滤
  document.getElementById('searchInput').addEventListener('input', () => renderKanban());
  document.getElementById('filterPriority').addEventListener('change', () => renderKanban());
}

// ======= Git 状态 =======
async function refreshGitStatus() {
  try {
    const data = await api('/git/status');

    if (data.error) {
      // 未配置路径时显示引导
      const panel = document.querySelector('.git-layout');
      panel.innerHTML = `
        <div class="git-no-config">
          <div class="big-icon">🌿</div>
          <div style="font-size:16px;color:var(--text-secondary);font-weight:600;">尚未配置 Git 项目路径</div>
          <div>${data.message || '请在设置中填写你的项目路径'}</div>
          <button class="btn btn-primary" onclick="document.querySelector('[data-tab=settings]').click()">
            ⚙️ 前往设置
          </button>
        </div>`;
      return;
    }

    // 分支
    document.getElementById('gitBranch').textContent = data.branch || '—';

    // 最新 commit
    if (data.commit) {
      document.getElementById('gitLastCommit').innerHTML = `
        <div class="commit-hash">${data.commit.hash}</div>
        <div class="commit-msg">${escHtml(data.commit.message)}</div>
        <div class="commit-meta">${escHtml(data.commit.author)} · ${data.commit.time}</div>`;
    }

    // 变更统计
    document.getElementById('gitStaged').textContent    = data.changes?.staged    ?? '—';
    document.getElementById('gitModified').textContent  = data.changes?.modified  ?? '—';
    document.getElementById('gitUntracked').textContent = data.changes?.untracked ?? '—';

    // 同步状态
    const ahead  = data.sync?.ahead  ?? 0;
    const behind = data.sync?.behind ?? 0;
    document.getElementById('gitAhead').textContent  = `↑ ${ahead} ahead`;
    document.getElementById('gitBehind').textContent = `↓ ${behind} behind`;

    // 更新时间
    const now = new Date();
    document.getElementById('gitUpdateTime').textContent =
      `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')} 更新`;

    // 变更文件列表
    renderGitFiles();

    // 提交历史
    renderTimeline(data.commits || []);

    // 分支列表
    renderBranches(data.branches || []);

    // 工作树
    renderWorktrees(data.worktrees || []);

    // Stash
    renderStashes(data.stashes || []);

    // Tags
    renderTags(data.tags || []);

  } catch (e) {
    document.getElementById('gitBranch').textContent = '连接失败';
  }
}

async function renderGitFiles() {
  try {
    const data = await api('/git/diff');
    const list = document.getElementById('gitFileList');
    if (!data.files || data.files.length === 0) {
      list.innerHTML = `<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:12px">工作区干净 ✨</div>`;
      return;
    }
    list.innerHTML = data.files.map(f => {
      const sc = f.status.replace(' ', '') || '?';
      const cls = `file-status-${sc[0] || '?'}`;
      return `<div class="git-file-item">
        <span class="file-status ${cls}">${sc}</span>
        <span class="file-name">${escHtml(f.file)}</span>
      </div>`;
    }).join('');
  } catch (e) {}
}

function renderTimeline(commits) {
  const el = document.getElementById('gitTimeline');
  if (!commits.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><div>暂无提交记录</div></div>`;
    return;
  }
  el.innerHTML = commits.map(c => `
    <div class="timeline-item">
      <div class="timeline-dot">${c.hash.slice(0,3)}</div>
      <div class="timeline-content">
        <div class="timeline-msg">${escHtml(c.message)}</div>
        <div class="timeline-meta">
          <span class="timeline-hash">${c.hash}</span>
          <span>${escHtml(c.author)}</span>
          <span>${c.relative_time}</span>
        </div>
      </div>
    </div>`).join('');
}

function startGitRefresh() {
  if (gitRefreshTimer) clearInterval(gitRefreshTimer);
  refreshGitStatus();
  gitRefreshTimer = setInterval(refreshGitStatus, gitRefreshInterval);
}

function initGit() {
  document.getElementById('gitRefreshBtn').addEventListener('click', refreshGitStatus);
}

// ======= Prompt 编辑器 =======
function initEditor() {
  // 模板渲染
  const templateList = document.getElementById('templateList');
  PROMPT_TEMPLATES.forEach(tpl => {
    const el = document.createElement('div');
    el.className = 'template-item';
    el.innerHTML = `<span>${tpl.icon}</span><span>${tpl.name}</span>`;
    el.addEventListener('click', () => {
      document.getElementById('promptEditor').value = tpl.content;
      updatePreview();
      showToast(`已载入「${tpl.name}」模板`, 'info');
    });
    templateList.appendChild(el);
  });

  // 实时预览
  document.getElementById('promptEditor').addEventListener('input', updatePreview);

  // 复制按钮
  document.getElementById('btnCopyPrompt').addEventListener('click', () => {
    const title = document.getElementById('editorTitle').value.trim();
    const content = document.getElementById('promptEditor').value;
    if (!content.trim()) {
      showToast('Prompt 内容为空', 'error');
      return;
    }
    const text = title ? `# ${title}\n\n${content}` : content;
    navigator.clipboard.writeText(text).then(() => {
      showToast('📋 Prompt 已复制！粘贴给 AI 开始 Vibe Coding 吧', 'success');
    }).catch(() => showToast('复制失败', 'error'));
  });

  // 清空
  document.getElementById('btnClearEditor').addEventListener('click', () => {
    if (confirm('确认清空编辑器内容？')) {
      document.getElementById('promptEditor').value = '';
      document.getElementById('editorTitle').value = '';
      document.getElementById('editorTaskLink').value = '';
      updatePreview();
    }
  });

  // 保存到需求
  document.getElementById('btnSaveToTask').addEventListener('click', async () => {
    const taskId = document.getElementById('editorTaskLink').value;
    const prompt = document.getElementById('promptEditor').value;
    const title = document.getElementById('editorTitle').value.trim();
    const priority = document.getElementById('editorPriority').value;

    if (!taskId) {
      // 新建需求
      if (!title) {
        showToast('请先填写需求标题', 'error');
        return;
      }
      try {
        const created = await api('/tasks', {
          method: 'POST',
          body: JSON.stringify({ title, prompt, priority, status: 'todo' })
        });
        allTasks.unshift(created);
        document.getElementById('editorTaskLink').value = created.id;
        populateEditorTaskSelect();
        document.getElementById('editorTaskLink').value = created.id;
        showToast(`已创建新需求「${title}」✅`, 'success');
      } catch (e) {
        showToast('创建失败', 'error');
      }
    } else {
      // 更新现有需求
      try {
        const body = { prompt };
        if (title) body.title = title;
        const updated = await api(`/tasks/${taskId}`, {
          method: 'PATCH', body: JSON.stringify(body)
        });
        const idx = allTasks.findIndex(t => t.id === taskId);
        if (idx !== -1) allTasks[idx] = updated;
        showToast('Prompt 已保存到需求 ✅', 'success');
      } catch (e) {
        showToast('保存失败', 'error');
      }
    }
  });

  updatePreview();
}

function updatePreview() {
  const md = document.getElementById('promptEditor').value;
  const preview = document.getElementById('promptPreview');
  if (typeof marked !== 'undefined') {
    preview.innerHTML = marked.parse(md || '*在左侧开始编写 Prompt...*');
  } else {
    preview.textContent = md;
  }
}

function populateEditorTaskSelect() {
  const sel = document.getElementById('editorTaskLink');
  const current = sel.value;
  sel.innerHTML = '<option value="">— 新建需求 —</option>' +
    allTasks.map(t => `<option value="${t.id}">${
      { todo:'📝', doing:'🔄', done:'✅' }[t.status] || ''
    } ${escHtml(t.title)}</option>`).join('');
  if (current) sel.value = current;
}

// ======= 设置 =======
async function loadSettings() {
  try {
    const config = await api('/config');
    currentConfig = config;
    document.getElementById('settingProjectName').value = config.project_name || '';
    document.getElementById('settingProjectPath').value = config.project_path || '';
    document.getElementById('settingRefreshInterval').value =
      Math.round((config.git_refresh_interval || 5000) / 1000);
    document.getElementById('projectName').textContent = config.project_name || '仪表盘';

    // 加载统计
    loadStats();
  } catch (e) {}
}

async function loadStats() {
  try {
    const stats = await api('/tasks/stats/summary');
    document.getElementById('statTodayDone').textContent = stats.todayDone;
    document.getElementById('statTotal').textContent = stats.total;
    const rate = stats.total ? Math.round(stats.done / stats.total * 100) : 0;
    document.getElementById('statRate').textContent = `${rate}%`;

    // 进度环
    updateProgressRing(stats.todo, stats.doing, stats.done);
  } catch (e) {}
}

function updateProgressRing(todo, doing, done) {
  const total = todo + doing + done;
  if (total === 0) return;

  const CIRC = 314; // 2 * Math.PI * 50

  const doneRatio  = done / total;
  const doingRatio = doing / total;
  const todoRatio  = todo / total;

  const doneDash  = doneRatio * CIRC;
  const doingDash = doingRatio * CIRC;
  const todoDash  = todoRatio * CIRC;

  // done 段从 0 开始
  const ringDone = document.getElementById('ringDone');
  ringDone.style.strokeDasharray  = `${doneDash} ${CIRC}`;
  ringDone.style.strokeDashoffset = '0';
  ringDone.setAttribute('transform', 'rotate(-90 60 60)');

  // doing 段紧跟 done
  const ringDoing = document.getElementById('ringDoing');
  ringDoing.style.strokeDasharray  = `${doingDash} ${CIRC}`;
  ringDoing.style.strokeDashoffset = `${-doneDash}`;
  ringDoing.setAttribute('transform', 'rotate(-90 60 60)');

  // todo 段
  const ringTodo = document.getElementById('ringTodo');
  ringTodo.style.strokeDasharray  = `${todoDash} ${CIRC}`;
  ringTodo.style.strokeDashoffset = `${-(doneDash + doingDash)}`;
  ringTodo.setAttribute('transform', 'rotate(-90 60 60)');

  const pct = total ? Math.round(done / total * 100) : 0;
  document.getElementById('ringPct').textContent = `${pct}%`;
}

function initSettings() {
  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    const projectName = document.getElementById('settingProjectName').value.trim();
    const projectPath = document.getElementById('settingProjectPath').value.trim();
    const intervalSec = parseInt(document.getElementById('settingRefreshInterval').value) || 5;

    try {
      const updated = await api('/config', {
        method: 'PATCH',
        body: JSON.stringify({
          project_name: projectName,
          project_path: projectPath,
          git_refresh_interval: intervalSec * 1000
        })
      });
      currentConfig = updated;
      gitRefreshInterval = intervalSec * 1000;
      document.getElementById('projectName').textContent = projectName || '仪表盘';
      document.getElementById('settingMsg').textContent = '✅ 设置已保存！';
      setTimeout(() => { document.getElementById('settingMsg').textContent = ''; }, 2000);
      showToast('设置已保存', 'success');
    } catch (e) {
      showToast('保存失败', 'error');
    }
  });
}

// ======= 文件夹浏览器 =======
let browsePath = '';  // 当前浏览路径
let browseIsGit = false;

function openBrowser(startPath) {
  browsePath = startPath || '';
  document.getElementById('browseModal').classList.add('open');
  loadBrowseDir(browsePath || '');
}

function closeBrowser() {
  document.getElementById('browseModal').classList.remove('open');
}

async function loadBrowseDir(dirPath) {
  const list = document.getElementById('browseList');
  list.innerHTML = '<div class="browse-loading">加载中...</div>';

  try {
    const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
    const data = await api(`/browse${params}`);

    if (data.error) {
      list.innerHTML = `<div class="browse-empty"><div>❌ ${data.error}</div></div>`;
      return;
    }

    browsePath = data.path;
    browseIsGit = data.is_git;

    // 更新面包屑
    renderBreadcrumb(data.path);

    // 更新底部信息 & 选择按钮
    document.getElementById('browseCurrentInfo').textContent = data.path;
    const selectBtn = document.getElementById('browseSelect');
    if (data.is_git) {
      selectBtn.disabled = false;
      selectBtn.textContent = '✅ 选择此 Git 仓库';
    } else {
      selectBtn.disabled = false;
      selectBtn.textContent = '✅ 选择此文件夹';
    }

    // 渲染文件夹列表
    let html = '';

    // 返回上级
    if (data.parent) {
      html += `<div class="browse-item" data-path="${escHtml(data.parent)}">
        <span class="folder-icon">⬆️</span>
        <span class="folder-name">.. 返回上级</span>
      </div>`;
    }

    if (data.items.length === 0 && !data.parent) {
      html = '<div class="browse-empty"><div style="font-size:24px">📭</div><div>该目录下没有子文件夹</div></div>';
    } else if (data.items.length === 0) {
      html += '<div class="browse-empty"><div>没有子文件夹</div></div>';
    } else {
      // 过滤掉 .git 目录本身（不应该进入）
      for (const item of data.items) {
        if (item.name === '.git') continue;
        const gitCls = item.is_git ? ' is-git-repo' : '';
        const gitBadge = item.is_git ? '<span class="git-badge">Git 仓库</span>' : '';
        const icon = item.is_git ? '📦' : '📁';
        html += `<div class="browse-item${gitCls}" data-path="${escHtml(item.path)}">
          <span class="folder-icon">${icon}</span>
          <span class="folder-name">${escHtml(item.name)}</span>
          ${gitBadge}
        </div>`;
      }
    }

    list.innerHTML = html;

    // 绑定点击事件（进入子目录）
    list.querySelectorAll('.browse-item').forEach(el => {
      el.addEventListener('click', () => {
        loadBrowseDir(el.dataset.path);
      });
    });

  } catch (e) {
    list.innerHTML = `<div class="browse-empty"><div>❌ 加载失败</div><div style="font-size:12px">${e.message}</div></div>`;
  }
}

function renderBreadcrumb(fullPath) {
  const bc = document.getElementById('browseBreadcrumb');
  const parts = fullPath.split('/').filter(Boolean);
  let html = '';

  // 根目录 /
  html += `<span class="breadcrumb-item" data-path="/">/</span>`;

  parts.forEach((part, i) => {
    html += `<span class="breadcrumb-sep">/</span>`;
    const path = '/' + parts.slice(0, i + 1).join('/');
    if (i === parts.length - 1) {
      html += `<span class="breadcrumb-item breadcrumb-current">${escHtml(part)}</span>`;
    } else {
      html += `<span class="breadcrumb-item" data-path="${escHtml(path)}">${escHtml(part)}</span>`;
    }
  });

  if (browseIsGit) {
    html += `<span style="margin-left:8px" class="git-badge">Git 仓库 ✓</span>`;
  }

  bc.innerHTML = html;

  // 面包屑点击事件
  bc.querySelectorAll('.breadcrumb-item:not(.breadcrumb-current)').forEach(el => {
    el.addEventListener('click', () => loadBrowseDir(el.dataset.path));
  });
}

function initBrowser() {
  // 打开浏览器
  document.getElementById('btnBrowseFolder').addEventListener('click', () => {
    const current = document.getElementById('settingProjectPath').value.trim();
    openBrowser(current);
  });

  // 关闭
  document.getElementById('browseClose').addEventListener('click', closeBrowser);
  document.getElementById('browseCancel').addEventListener('click', closeBrowser);
  document.getElementById('browseModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('browseModal')) closeBrowser();
  });

  // 选择按钮
  document.getElementById('browseSelect').addEventListener('click', () => {
    document.getElementById('settingProjectPath').value = browsePath;
    closeBrowser();
    showToast(`已选择路径：${browsePath}`, 'success');
  });
}

// ======= 初始化 =======
async function init() {
  initTabs();
  initModal();
  initGit();
  initEditor();
  initSettings();
  initBrowser();

  await loadTasks();
  await loadSettings();
}

document.addEventListener('DOMContentLoaded', init);
