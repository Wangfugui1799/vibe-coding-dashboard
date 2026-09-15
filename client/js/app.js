/* =============================================
   Vibe Coding 仪表盘 - 主逻辑 app.js
   ============================================= */

const API = '/api';
let cloudMode = false;

// ======= 全局状态 =======
let allTasks = [];
let allProjects = [];
let activeProjectId = '';
let editingTaskId = null;
let gitRefreshTimer = null;
let gitRefreshInterval = 5000;
let currentConfig = {};
let selectedProjectColor = '#58a6ff';

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
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = data.message || data.error || `请求失败: ${res.status}`;
    if (cloudMode) showToast(message, 'error');
    throw new Error(message);
  }
  return res.json();
}

let toastTimer = null;

function showToast(msg, type = 'info', actionText = null, actionCallback = null) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);

  toast.innerHTML = '';
  const textSpan = document.createElement('span');
  textSpan.textContent = msg;
  toast.appendChild(textSpan);

  if (actionText && typeof actionCallback === 'function') {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast-action-btn';
    actionBtn.textContent = actionText;
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toast.className = 'toast';
      if (toastTimer) clearTimeout(toastTimer);
      actionCallback();
    });
    toast.appendChild(actionBtn);
  }

  toast.className = `toast show ${type}`;
  const duration = actionText ? 5000 : 2800;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, duration);
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
      window.location.hash = tab;
      if (tab === 'git') startGitRefresh();
      if (tab === 'settings') loadSettings();
      if (tab === 'editor') populateEditorTaskSelect();
    });
  });

  const hashTab = (window.location.hash.slice(1) || '').toLowerCase();
  const targetBtn = document.querySelector(`.tab-btn[data-tab="${hashTab}"]`);
  if (targetBtn) {
    targetBtn.click();
  }
}

// ======= Kanban 看板 =======
async function loadTasks() {
  try {
    const data = await api('/tasks');
    allTasks = data.tasks;
    renderKanban();
    updateBadges();
    if (typeof data.trash_count === 'number') {
      updateTrashBadge(data.trash_count);
    } else {
      updateTrashBadge();
    }
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

function renderMarkdownSafely(md) {
  if (!md || !md.trim()) return '';
  if (typeof marked !== 'undefined') {
    try {
      if (typeof marked.setOptions === 'function') {
        marked.setOptions({ breaks: true, gfm: true });
      }
      return marked.parse(md);
    } catch (err) {
      console.warn('marked 解析异常:', err);
    }
  }
  return `<pre style="white-space:pre-wrap;font-family:inherit;">${escHtml(md)}</pre>`;
}

function renderKanban() {
  const filtered = filterTasks(allTasks);
  const cols = { todo: [], doing: [], done: [] };
  filtered.forEach(t => { if (cols[t.status]) cols[t.status].push(t); });

  const kanbanBoard = document.querySelector('.kanban-board');
  const viewMode = localStorage.getItem('kanban_view_mode') || 'doc';
  if (kanbanBoard) {
    if (viewMode === 'compact') {
      kanbanBoard.classList.add('view-compact');
    } else {
      kanbanBoard.classList.remove('view-compact');
    }
  }

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

      // 智能高度检测：短文档直接完整展现，无需折叠与蒙层
      container.querySelectorAll('.card-doc-box').forEach(docBox => {
        const content = docBox.querySelector('.card-doc-content');
        const footer = docBox.querySelector('.card-doc-footer');
        const fade = docBox.querySelector('.card-doc-fade');
        if (content && footer && fade) {
          if (content.scrollHeight <= 150) {
            footer.style.display = 'none';
            fade.style.display = 'none';
            docBox.classList.add('is-expanded');
          }
        }
      });

      // 绑定卡片事件
      container.querySelectorAll('.task-card').forEach(card => {
        const id = card.dataset.id;
        card.addEventListener('click', (e) => {
          // 点击按钮、链接、复选框时不触发卡片模态弹窗
          if (
            e.target.closest('.card-action-btn') ||
            e.target.closest('.card-doc-copy-btn') ||
            e.target.closest('.card-doc-toggle-btn') ||
            e.target.closest('a') ||
            e.target.closest('input')
          ) return;
          openTaskModal(id);
        });

        // 展开 / 折叠单张卡片文档
        card.querySelector('.card-doc-toggle-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          const docBox = card.querySelector('.card-doc-box');
          if (!docBox) return;
          const isExpanded = docBox.classList.toggle('is-expanded');
          const btn = e.currentTarget;
          btn.textContent = isExpanded ? '收起 ▴' : '展开全部 ▾';
        });

        // 复制文档与 Prompt
        card.querySelector('.card-doc-copy-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          copyPrompt(id);
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
  const tags = (task.tags || []).map(t => `<span class="card-tag">${escHtml(t)}</span>`).join('');
  const nextBtn = task.status === 'todo'
    ? `<button class="card-action-btn btn-move-next" title="开始">▶</button>`
    : task.status === 'doing'
    ? `<button class="card-action-btn btn-move-next" title="完成">✔</button>`
    : '';

  const commits = task.linked_commits?.length
    ? `<div class="card-commit">📎 ${escHtml(task.linked_commits.slice(-1)[0])}</div>`
    : '';

  const timeInfo = task.status === 'done' && task.done_at
    ? `✅ ${formatTime(task.done_at)}`
    : task.status === 'doing' && task.started_at
    ? `▶ ${formatTime(task.started_at)}`
    : `📅 ${formatTime(task.created_at)}`;

  // 需求文档直读预览
  let docPreviewHtml = '';
  if (task.prompt && task.prompt.trim()) {
    const parsedHtml = renderMarkdownSafely(task.prompt);
    docPreviewHtml = `
      <div class="card-doc-box" data-task-id="${task.id}">
        <div class="card-doc-header">
          <span class="card-doc-tag">📄 需求文档</span>
          <button class="card-doc-copy-btn" title="一键复制文档 Prompt">📋 复制</button>
        </div>
        <div class="card-doc-body">
          <div class="card-doc-content">${parsedHtml}</div>
          <div class="card-doc-fade"></div>
        </div>
        <div class="card-doc-footer">
          <button class="card-doc-toggle-btn" title="展开或收起全部内容">展开全部 ▾</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="task-card priority-${task.priority}" data-id="${task.id}">
      <div class="card-priority-bar"></div>
      <div class="card-title">${escHtml(task.title)}</div>
      ${docPreviewHtml}
      ${tags ? `<div class="card-tags">${tags}</div>` : ''}
      ${commits}
      <div class="card-meta">
        <span>${timeInfo}</span>
        <div class="card-actions">
          ${nextBtn}
          <button class="card-action-btn btn-copy" title="复制 Prompt">📋</button>
          <button class="card-action-btn btn-edit" title="编辑">✏️</button>
          <button class="card-action-btn btn-delete" title="移入垃圾箱">🗑</button>
        </div>
      </div>
    </div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  try {
    const res = await api(`/tasks/${id}/trash`, { method: 'POST' });
    allTasks = allTasks.filter(t => t.id !== id);
    renderKanban();
    updateBadges();
    updateTrashBadge(res.trash_count);

    showToast(`已将需求「${task.title}」移入垃圾箱 🗑`, 'info', '↩ 撤回', async () => {
      await restoreTask(id);
    });
    // 移入垃圾箱同样会写入备份档案，设置页可见时同步刷新概览
    refreshBackupSummaryIfVisible();
  } catch (e) {
    showToast('移入垃圾箱失败', 'error');
  }
}

async function restoreTask(id) {
  try {
    const res = await api(`/tasks/${id}/restore`, { method: 'POST' });
    if (!allTasks.some(t => t.id === id)) {
      allTasks.unshift(res);
    }
    renderKanban();
    updateBadges();
    updateTrashBadge(res.trash_count);
    showToast(`需求「${res.title}」已还原 ✅`, 'success');
    if (document.getElementById('trashModal')?.classList.contains('open')) {
      await loadTrashTasks();
    }
  } catch (e) {
    showToast('还原需求失败', 'error');
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
  const btnMoveTrash = document.getElementById('modalMoveTrash');

  if (id) {
    const task = allTasks.find(t => t.id === id);
    if (!task) return;
    title.textContent = '编辑需求';
    document.getElementById('modalTaskTitle').value = task.title;
    document.getElementById('modalTaskStatus').value = task.status;
    document.getElementById('modalTaskPriority').value = task.priority;
    document.getElementById('modalTaskTags').value = (task.tags || []).join(', ');
    document.getElementById('modalTaskPrompt').value = task.prompt || '';
    if (btnMoveTrash) btnMoveTrash.style.display = 'inline-flex';
  } else {
    title.textContent = '新建需求';
    document.getElementById('modalTaskTitle').value = '';
    document.getElementById('modalTaskStatus').value = 'todo';
    document.getElementById('modalTaskPriority').value = 'medium';
    document.getElementById('modalTaskTags').value = '';
    document.getElementById('modalTaskPrompt').value = '';
    if (btnMoveTrash) btnMoveTrash.style.display = 'none';
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
    refreshBackupSummaryIfVisible();
  } catch (e) {
    showToast('保存失败', 'error');
  }
}

function initModal() {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalSave').addEventListener('click', saveTask);
  document.getElementById('modalMoveTrash')?.addEventListener('click', async () => {
    if (!editingTaskId) return;
    const targetId = editingTaskId;
    closeModal();
    await deleteTask(targetId);
  });
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
    const noConfigPanel = document.getElementById('gitNoConfigPanel');

    if (data.error) {
      // 未配置路径时，用覆盖层提示，不破坏 git-layout DOM
      if (noConfigPanel) {
        const msgEl = document.getElementById('gitNoConfigMsg');
        const detailEl = document.getElementById('gitNoConfigDetail');
        const errText = {
          not_a_git_repo:    '该路径不是 Git 仓库',
          git_unavailable:   '无法调用 git 命令',
          project_path_not_set: '尚未配置 Git 项目路径'
        }[data.error] || 'Git 状态暂不可用';
        if (msgEl) msgEl.textContent = errText;
        if (detailEl) detailEl.textContent = data.detail || data.message || '请在设置中填写你的项目路径';
        noConfigPanel.style.display = 'flex';
      }
      return;
    }

    // 成功获取数据：隐藏覆盖层，恢复正常显示
    if (noConfigPanel) noConfigPanel.style.display = 'none';

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

    // 记录活动分支
    currentActiveBranch = data.branch || 'main';

    // 变更文件列表
    renderGitFiles();

    // 提交历史 (若用户手动选了分支则保持，否则展示活动分支)
    const badge = document.getElementById('timelineBranchBadge');
    const resetBtn = document.getElementById('btnResetTimelineBranch');

    if (!currentViewingBranch || currentViewingBranch === currentActiveBranch) {
      currentViewingBranch = currentActiveBranch;
      renderTimeline(data.commits || []);
      if (badge) badge.textContent = `🌿 ${currentActiveBranch}`;
      if (resetBtn) resetBtn.style.display = 'none';
    } else {
      // 保持当前用户选择的分支
      if (badge) badge.textContent = `🌿 ${currentViewingBranch}`;
      if (resetBtn) resetBtn.style.display = 'inline-block';
    }

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
    if (data.error) {
      list.innerHTML = `<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:12px">${escHtml(data.message || 'Git 状态暂不可用')}</div>`;
      return;
    }
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

// ======= 分支查看与项目路径快速切换 =======
let currentActiveBranch = '';
let currentViewingBranch = '';

// 切换当前查看的项目目录 (基于配置更新或项目切换)
async function switchProjectDirectory(newPath) {
  if (!newPath) return;
  // 检查是否已有项目对应此路径
  const matched = allProjects.find(p => p.path === newPath);
  if (matched && matched.id !== activeProjectId) {
    return switchProject(matched.id);
  }
  try {
    showToast(`正在切换项目路径到: ${newPath}...`, 'info');
    await api('/config', {
      method: 'PATCH',
      body: JSON.stringify({ project_path: newPath })
    });
    showToast('项目已成功切换！🎉', 'success');
    currentViewingBranch = ''; // 重置为新项目的默认分支
    await loadProjects();
    await loadTasks();
    await loadSettings();
    await refreshGitStatus();
  } catch (e) {
    showToast('切换项目失败: ' + (e.message || e), 'error');
  }
}

// 切换查看指定分支的历史时间线
async function viewBranchTimeline(branchName) {
  if (!branchName) return;
  currentViewingBranch = branchName;

  // 更新分支列表高亮状态
  document.querySelectorAll('.branch-item').forEach(el => {
    if (el.dataset.branch === branchName) {
      el.classList.add('active-branch-view');
    } else {
      el.classList.remove('active-branch-view');
    }
  });

  // 更新时间线头部指示器与重置按钮
  const badge = document.getElementById('timelineBranchBadge');
  const resetBtn = document.getElementById('btnResetTimelineBranch');
  if (badge) badge.textContent = `🌿 ${branchName}`;
  if (resetBtn) {
    resetBtn.style.display = (branchName === currentActiveBranch) ? 'none' : 'inline-block';
  }

  // 异步加载该分支提交历史
  try {
    const res = await api(`/git/commits?branch=${encodeURIComponent(branchName)}`);
    renderTimeline(res.commits || []);
    showToast(`已切换查看分支: ${branchName}`, 'info');
  } catch (e) {
    showToast('获取该分支历史失败', 'error');
  }
}

function renderBranches(branches) {
  const el = document.getElementById('gitBranchList');
  const countEl = document.getElementById('branchCount');
  if (!branches.length) {
    el.innerHTML = '<div class="git-empty-hint">暂无分支信息</div>';
    countEl.textContent = '';
    return;
  }
  const local = branches.filter(b => !b.is_remote);
  const remote = branches.filter(b => b.is_remote);
  countEl.textContent = `${local.length} 本地 / ${remote.length} 远程`;

  let html = '';
  // 当前分支排第一，然后本地，然后远程
  const sorted = [
    ...local.filter(b => b.is_current),
    ...local.filter(b => !b.is_current),
    ...remote
  ];

  sorted.forEach(b => {
    const isCur = b.is_current;
    const isViewing = (b.name === currentViewingBranch);
    const cls = (isCur ? ' current' : '') + (isViewing ? ' active-branch-view' : '');
    const dotCls = isCur ? 'current-dot' : (b.is_remote ? 'remote' : 'local');
    const badge = isCur ? '<span class="branch-current-badge">活动</span>' :
                  b.is_remote ? '<span class="branch-remote-badge">远程</span>' : '';

    // 若关联工作树目录且不是当前查看项目，提供「📂 切为此项目」按钮
    let switchBtn = '';
    if (b.worktree_path) {
      if (!b.is_active_project) {
        switchBtn = `<button class="btn-switch-project" data-wt-path="${escHtml(b.worktree_path)}" title="切换整个看板到此工作树项目">📂 切为此项目</button>`;
      } else {
        switchBtn = `<span style="color:var(--green);font-size:10px;font-weight:600">当前项目</span>`;
      }
    }

    html += `<div class="branch-item${cls}" data-branch="${escHtml(b.name)}" title="点击切换查看此分支提交历史">
      <span class="branch-dot ${dotCls}"></span>
      <span class="branch-name" title="${escHtml(b.name)}">${escHtml(b.name)}</span>
      <span class="branch-hash">${b.hash}</span>
      ${badge}
      <div class="branch-actions">
        ${switchBtn}
        <button class="btn-branch-action" data-branch="${escHtml(b.name)}" title="查看该分支提交历史">📜 历史</button>
      </div>
    </div>`;
  });

  el.innerHTML = html;

  // 绑定分支项点击查看时间线
  el.querySelectorAll('.branch-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // 若点击的是切换项目按钮，则不触发分支查看
      if (e.target.closest('.btn-switch-project')) return;
      const bName = item.dataset.branch;
      if (bName) viewBranchTimeline(bName);
    });
  });

  // 绑定「📂 切为此项目」按钮
  el.querySelectorAll('.btn-switch-project').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.dataset.wtPath;
      if (p) switchProjectDirectory(p);
    });
  });
}

function renderWorktrees(worktrees) {
  const el = document.getElementById('gitWorktreeList');
  const countEl = document.getElementById('worktreeCount');
  if (!worktrees.length) {
    el.innerHTML = '<div class="git-empty-hint">仅主工作树</div>';
    countEl.textContent = '';
    return;
  }
  countEl.textContent = `${worktrees.length} 个工作树`;

  // 获取当前配置的项目路径
  const currentPath = currentConfig?.project_path || '';

  el.innerHTML = worktrees.map((wt, i) => {
    const isMain = wt.is_main || i === 0;
    const isCurActive = (wt.path === currentPath) || (!currentPath && isMain);
    const mainCls = isMain ? ' main-wt' : '';
    const icon = isMain ? '🏠' : '🌳';
    const badge = isMain ? '<span class="wt-badge main">主工作树</span>' :
                           '<span class="wt-badge linked">链接工作树</span>';

    const branchName = wt.branch || (wt.detached ? 'HEAD (分离)' : (wt.bare ? '裸仓库' : '未知分支'));
    const branchInfo = `<span class="wt-branch">🌿 ${escHtml(branchName)}</span>`;
    const headInfo = wt.head ? `<span class="wt-head">@ ${wt.head}</span>` : '';

    // 状态标签
    let statusBadge = '';
    if (wt.changes) {
      if (wt.changes.clean) {
        statusBadge = '<span class="wt-status-badge clean">工作区干净 ✨</span>';
      } else {
        statusBadge = `<span class="wt-status-badge dirty">${wt.changes.total} 个修改 ⚠️</span>`;
      }
    }

    // 设为当前项目按钮 / 当前项目徽章
    let projectActionBadge = '';
    const matchedProject = allProjects.find(p => p.path === wt.path);
    if (isCurActive) {
      projectActionBadge = '<span class="wt-active-badge">当前活跃 ✓</span>';
    } else if (matchedProject) {
      projectActionBadge = `<button class="wt-switch-btn" data-project-id="${matchedProject.id}" title="切换至该项目看板">⚡ 切换为此项目</button>`;
    } else {
      projectActionBadge = `
        <button class="wt-switch-btn" data-wt-path="${escHtml(wt.path)}" title="将项目路径切至此工作树">🎯 切为此路径</button>
        <button class="wt-add-proj-btn" data-wt-path="${escHtml(wt.path)}" data-wt-name="${escHtml(branchName)}" title="将此工作树保存为独立看板项目">＋ 存为新项目</button>
      `;
    }

    // 最新提交
    let commitBlock = '';
    if (wt.commit) {
      commitBlock = `
        <div class="wt-commit-box">
          <div class="wt-commit-top">
            <span class="wt-commit-hash">${wt.commit.hash}</span>
            <span class="wt-commit-msg" title="${escHtml(wt.commit.message)}">${escHtml(wt.commit.message)}</span>
          </div>
          <div class="wt-commit-meta">${escHtml(wt.commit.author || '')} · ${wt.commit.time || ''}</div>
        </div>`;
    }

    return `
      <div class="wt-item${mainCls}">
        <div class="wt-top-row">
          <div class="wt-header">
            <span class="wt-icon">${icon}</span>
            ${branchInfo}
            ${headInfo}
          </div>
          <div class="wt-badges">
            ${statusBadge}
            ${projectActionBadge}
            ${badge}
          </div>
        </div>

        <div class="wt-path-container">
          <span class="wt-path-label">路径:</span>
          <span class="wt-path-text">${escHtml(wt.path)}</span>
          <button class="wt-copy-path-btn" data-path="${escHtml(wt.path)}" title="复制完整路径">📋 复制</button>
        </div>

        ${commitBlock}
      </div>`;
  }).join('');

  // 绑定复制完整路径事件
  el.querySelectorAll('.wt-copy-path-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.dataset.path;
      if (!p) return;
      navigator.clipboard.writeText(p).then(() => {
        showToast('📋 工作树路径已复制！', 'success');
      }).catch(() => {
        showToast('复制失败，请手动复制', 'error');
      });
    });
  });

  // 绑定「切换项目」按钮
  el.querySelectorAll('.wt-switch-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = btn.dataset.projectId;
      if (pid) {
        switchProject(pid);
      } else {
        const p = btn.dataset.wtPath;
        if (p) switchProjectDirectory(p);
      }
    });
  });

  // 绑定「＋ 存为新项目」按钮
  el.querySelectorAll('.wt-add-proj-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.dataset.wtPath;
      const bName = btn.dataset.wtName || '';
      openProjectModal(null, p);
      if (bName && bName !== '未知分支' && !bName.startsWith('HEAD')) {
        const nameInput = document.getElementById('projectModalName');
        if (nameInput) nameInput.value = bName;
      }
    });
  });
}

function renderStashes(stashes) {
  const el = document.getElementById('gitStashList');
  const countEl = document.getElementById('stashCount');
  if (!stashes.length) {
    el.innerHTML = '<div class="git-empty-hint">无暂存内容</div>';
    countEl.textContent = '';
    return;
  }
  countEl.textContent = `${stashes.length} 条`;

  el.innerHTML = stashes.map(s => `
    <div class="stash-item">
      <span class="stash-ref">${escHtml(s.ref)}</span>
      <span class="stash-msg" title="${escHtml(s.message)}">${escHtml(s.message)}</span>
      <span class="stash-time">${escHtml(s.time)}</span>
    </div>`).join('');
}

function renderTags(tags) {
  const el = document.getElementById('gitTagList');
  const countEl = document.getElementById('tagCount');
  if (!tags.length) {
    el.innerHTML = '<div class="git-empty-hint">暂无标签</div>';
    countEl.textContent = '';
    return;
  }
  countEl.textContent = `${tags.length} 个`;

  el.innerHTML = tags.map(t => `
    <div class="tag-item">
      <span class="tag-icon">🏷️</span>
      <span class="tag-name">${escHtml(t.name)}</span>
      <span class="tag-hash">${t.hash}</span>
      <span class="tag-time">${escHtml(t.time)}</span>
    </div>`).join('');
}

// ======= Git 自由拖拽分栏与本地记忆 =======
const STORAGE_KEY_GIT_LAYOUT = 'vibe_git_layout_v1';

function restoreGitLayout() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_GIT_LAYOUT);
    if (!saved) return;
    const { overviewWidth, worktreeFlex, timelineFlex } = JSON.parse(saved);
    const colOverview = document.getElementById('colGitOverview');
    const colWorktree = document.getElementById('colGitWorktree');
    const colTimeline = document.getElementById('colGitTimeline');

    if (overviewWidth && colOverview) {
      colOverview.style.width = `${overviewWidth}px`;
    }
    if (worktreeFlex && timelineFlex && colWorktree && colTimeline) {
      colWorktree.style.flex = `${worktreeFlex} 1 0%`;
      colTimeline.style.flex = `${timelineFlex} 1 0%`;
    }
  } catch (e) {}
}

function saveGitLayout() {
  try {
    const colOverview = document.getElementById('colGitOverview');
    const colWorktree = document.getElementById('colGitWorktree');
    const colTimeline = document.getElementById('colGitTimeline');

    if (!colOverview || !colWorktree || !colTimeline) return;

    const overviewWidth = colOverview.getBoundingClientRect().width;
    const worktreeWidth = colWorktree.getBoundingClientRect().width;
    const timelineWidth = colTimeline.getBoundingClientRect().width;

    const totalRight = worktreeWidth + timelineWidth;
    const worktreeFlex = totalRight > 0 ? (worktreeWidth / totalRight) * 2 : 1;
    const timelineFlex = totalRight > 0 ? (timelineWidth / totalRight) * 2 : 1;

    localStorage.setItem(STORAGE_KEY_GIT_LAYOUT, JSON.stringify({
      overviewWidth: Math.round(overviewWidth),
      worktreeFlex: Number(worktreeFlex.toFixed(3)),
      timelineFlex: Number(timelineFlex.toFixed(3))
    }));
  } catch (e) {}
}

function resetGitLayout() {
  try {
    localStorage.removeItem(STORAGE_KEY_GIT_LAYOUT);
    const colOverview = document.getElementById('colGitOverview');
    const colWorktree = document.getElementById('colGitWorktree');
    const colTimeline = document.getElementById('colGitTimeline');
    if (colOverview) colOverview.style.width = '';
    if (colWorktree) colWorktree.style.flex = '';
    if (colTimeline) colTimeline.style.flex = '';
    showToast('已恢复默认三栏布局 ✨', 'success');
  } catch (e) {}
}

function initGitResizers() {
  restoreGitLayout();

  const resizer1 = document.getElementById('resizerOverview');
  const resizer2 = document.getElementById('resizerWorktree');
  const colOverview = document.getElementById('colGitOverview');
  const colWorktree = document.getElementById('colGitWorktree');
  const colTimeline = document.getElementById('colGitTimeline');
  const btnReset = document.getElementById('btnResetGitLayout');

  if (btnReset) {
    btnReset.addEventListener('click', resetGitLayout);
  }

  // ---- 分割条 1: 拖拽左侧概览栏宽度 ----
  if (resizer1 && colOverview) {
    let startX = 0;
    let startWidth = 0;

    const onMouseMove1 = (e) => {
      const dx = e.clientX - startX;
      const newWidth = Math.max(200, Math.min(600, startWidth + dx));
      colOverview.style.width = `${newWidth}px`;
    };

    const onMouseUp1 = () => {
      document.body.classList.remove('resizing-col');
      resizer1.classList.remove('is-dragging');
      document.removeEventListener('mousemove', onMouseMove1);
      document.removeEventListener('mouseup', onMouseUp1);
      saveGitLayout();
    };

    resizer1.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = colOverview.getBoundingClientRect().width;
      document.body.classList.add('resizing-col');
      resizer1.classList.add('is-dragging');
      document.addEventListener('mousemove', onMouseMove1);
      document.addEventListener('mouseup', onMouseUp1);
    });

    // 双击恢复默认左栏宽度
    resizer1.addEventListener('dblclick', () => {
      colOverview.style.width = '280px';
      saveGitLayout();
      showToast('左栏已恢复默认宽度', 'info');
    });
  }

  // ---- 分割条 2: 拖拽工作树与提交历史的宽度比例 ----
  if (resizer2 && colWorktree && colTimeline) {
    let startX = 0;
    let startWtWidth = 0;
    let startTlWidth = 0;

    const onMouseMove2 = (e) => {
      const dx = e.clientX - startX;
      const totalWidth = startWtWidth + startTlWidth;
      const newWtWidth = Math.max(200, Math.min(totalWidth - 200, startWtWidth + dx));
      const newTlWidth = totalWidth - newWtWidth;

      const wtFlex = (newWtWidth / totalWidth) * 2;
      const tlFlex = (newTlWidth / totalWidth) * 2;

      colWorktree.style.flex = `${wtFlex} 1 0%`;
      colTimeline.style.flex = `${tlFlex} 1 0%`;
    };

    const onMouseUp2 = () => {
      document.body.classList.remove('resizing-col');
      resizer2.classList.remove('is-dragging');
      document.removeEventListener('mousemove', onMouseMove2);
      document.removeEventListener('mouseup', onMouseUp2);
      saveGitLayout();
    };

    resizer2.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWtWidth = colWorktree.getBoundingClientRect().width;
      startTlWidth = colTimeline.getBoundingClientRect().width;
      document.body.classList.add('resizing-col');
      resizer2.classList.add('is-dragging');
      document.addEventListener('mousemove', onMouseMove2);
      document.addEventListener('mouseup', onMouseUp2);
    });

    // 双击等分右侧双栏
    resizer2.addEventListener('dblclick', () => {
      colWorktree.style.flex = '1 1 0%';
      colTimeline.style.flex = '1 1 0%';
      saveGitLayout();
      showToast('工作树与提交历史已等分', 'info');
    });
  }
}

function startGitRefresh() {
  if (cloudMode) return;
  if (gitRefreshTimer) clearInterval(gitRefreshTimer);
  refreshGitStatus();
  gitRefreshTimer = setInterval(refreshGitStatus, gitRefreshInterval);
}

function initGit() {
  document.getElementById('gitRefreshBtn').addEventListener('click', refreshGitStatus);
  const resetBranchBtn = document.getElementById('btnResetTimelineBranch');
  if (resetBranchBtn) {
    resetBranchBtn.addEventListener('click', () => {
      currentViewingBranch = '';
      refreshGitStatus();
      showToast('已切回当前活动分支时间线', 'info');
    });
  }
  initGitResizers();
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
    // 同步到全局变量，否则刷新页面后未点「保存设置」时，自动刷新仍用默认 5 秒
    gitRefreshInterval = config.git_refresh_interval || 5000;
    document.getElementById('projectName').textContent = config.project_name || '仪表盘';

    // 加载统计
    loadStats();
    // 加载备份概览
    loadBackupSummary();
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

      // 同步刷新项目列表与 Git 状态
      await loadProjects();
      await refreshGitStatus();
    } catch (e) {
      showToast('保存失败', 'error');
    }
  });
}

// ======= 多项目管理与快速切换 =======

async function loadProjects() {
  try {
    const res = await api('/projects');
    allProjects = res.projects || [];
    activeProjectId = res.active_project_id || (allProjects[0] ? allProjects[0].id : '');

    const cur = allProjects.find(p => p.id === activeProjectId) || allProjects[0];
    if (cur) {
      document.getElementById('projectName').textContent = cur.name || '仪表盘';
      const dot = document.getElementById('projectBadgeDot');
      if (dot) {
        dot.style.background = cur.color || '#58a6ff';
        dot.style.boxShadow = `0 0 6px ${cur.color || '#58a6ff'}`;
      }
    }

    renderProjectSwitcher();
    renderProjectManageList();
  } catch (e) {
    console.error('加载项目列表失败:', e);
  }
}

function renderProjectSwitcher(query = '') {
  const container = document.getElementById('projectDropdownList');
  const countBadge = document.getElementById('projectCountBadge');
  if (!container) return;

  if (countBadge) {
    countBadge.textContent = `${allProjects.length} 个项目`;
  }

  const q = (query || '').toLowerCase().trim();
  const filtered = allProjects.filter(p => {
    if (!q) return true;
    return (p.name || '').toLowerCase().includes(q) || (p.path || '').toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">无匹配项目</div>`;
    return;
  }

  container.innerHTML = filtered.map(p => {
    const isActive = p.id === activeProjectId;
    const stats = p.stats || { todo: 0, doing: 0, done: 0 };
    const taskCountStr = `${stats.todo} 待做 · ${stats.doing} 进行中`;
    const shortPath = p.path ? p.path.replace(/^\/Users\/[^/]+/, '~') : '未关联路径';

    return `
      <div class="project-item ${isActive ? 'active' : ''}" data-project-id="${p.id}">
        <div class="project-item-left">
          <span class="project-item-dot" style="background:${p.color || '#58a6ff'}"></span>
          <div class="project-item-info">
            <div class="project-item-name">
              <span>${escHtml(p.name)}</span>
            </div>
            <div class="project-item-path" title="${escHtml(p.path || '')}">${escHtml(shortPath)}</div>
          </div>
        </div>
        <div class="project-item-right">
          <span class="project-task-pill">${taskCountStr}</span>
          ${isActive ? '<span class="project-active-check">✓</span>' : ''}
        </div>
      </div>
    `;
  }).join('');

  // 绑定切换事件
  container.querySelectorAll('.project-item').forEach(item => {
    item.addEventListener('click', () => {
      const pid = item.dataset.projectId;
      closeProjectDropdown();
      if (pid !== activeProjectId) {
        switchProject(pid);
      }
    });
  });
}

function closeProjectDropdown() {
  const switcher = document.getElementById('projectSwitcher');
  if (switcher) switcher.classList.remove('open');
}

function toggleProjectDropdown() {
  const switcher = document.getElementById('projectSwitcher');
  if (!switcher) return;
  const isOpen = switcher.classList.contains('open');
  if (isOpen) {
    closeProjectDropdown();
  } else {
    switcher.classList.add('open');
    const searchInput = document.getElementById('projectSearchInput');
    if (searchInput) {
      searchInput.value = '';
      renderProjectSwitcher('');
      setTimeout(() => searchInput.focus(), 50);
    }
  }
}

function initProjectSwitcher() {
  const switcherBtn = document.getElementById('projectSwitcherBtn');
  const searchInput = document.getElementById('projectSearchInput');
  const btnQuickNew = document.getElementById('btnQuickNewProject');
  const btnQuickManage = document.getElementById('btnQuickManageProjects');

  if (switcherBtn) {
    switcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleProjectDropdown();
    });
  }

  // 搜索框过滤
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      renderProjectSwitcher(e.target.value);
    });
    searchInput.addEventListener('click', (e) => e.stopPropagation());
  }

  // 快捷新建项目
  if (btnQuickNew) {
    btnQuickNew.addEventListener('click', (e) => {
      e.stopPropagation();
      closeProjectDropdown();
      openProjectModal();
    });
  }

  // 快捷前往项目管理
  if (btnQuickManage) {
    btnQuickManage.addEventListener('click', (e) => {
      e.stopPropagation();
      closeProjectDropdown();
      const settingsTab = document.querySelector('.tab-btn[data-tab="settings"]');
      if (settingsTab) settingsTab.click();
      const target = document.getElementById('projectManageList');
      if (target) {
        setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
      }
    });
  }

  // 点击外部收起
  document.addEventListener('click', (e) => {
    const switcher = document.getElementById('projectSwitcher');
    if (switcher && !switcher.contains(e.target)) {
      closeProjectDropdown();
    }
  });

  // ESC 键收起
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeProjectDropdown();
    }
  });
}

// 切换项目主函数（秒级实时无缝联动）
async function switchProject(projectId) {
  if (!projectId) return;
  const target = allProjects.find(p => p.id === projectId);
  const targetName = target ? target.name : '新项目';

  try {
    showToast(`正在切换至项目: ${targetName}...`, 'info');
    await api('/projects/active', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId })
    });

    activeProjectId = projectId;
    currentViewingBranch = ''; // 重置分支查看状态

    // 重新加载所有模块
    await loadProjects();
    await loadTasks();
    await loadSettings();
    await refreshGitStatus();

    showToast(`已切换至项目：${targetName} 🎉`, 'success');
  } catch (e) {
    showToast('切换项目失败: ' + (e.message || e), 'error');
  }
}

// 渲染设置页中的项目管理列表
function renderProjectManageList() {
  const container = document.getElementById('projectManageList');
  if (!container) return;

  if (allProjects.length === 0) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:24px;color:var(--text-muted);">暂无项目，点击上方「＋ 新增项目」添加</div>`;
    return;
  }

  container.innerHTML = allProjects.map(p => {
    const isActive = p.id === activeProjectId;
    const stats = p.stats || { total: 0, todo: 0, doing: 0, done: 0 };
    const shortPath = p.path ? p.path.replace(/^\/Users\/[^/]+/, '~') : '（未配置路径）';

    return `
      <div class="project-manage-card ${isActive ? 'active-card' : ''}" data-id="${p.id}">
        <div class="pm-card-top">
          <div class="pm-title-group">
            <span class="pm-color-dot" style="background:${p.color || '#58a6ff'}"></span>
            <span class="pm-name" title="${escHtml(p.name)}">${escHtml(p.name)}</span>
          </div>
          ${isActive ? '<span class="pm-active-tag">● 当前活跃</span>' : ''}
        </div>

        <div class="pm-path" title="${escHtml(p.path || '')}">
          📂 ${escHtml(shortPath)}
        </div>

        <div class="pm-stats-row">
          <span class="pm-stat-badge">📝 ${stats.todo || 0} 待做</span>
          <span class="pm-stat-badge">🔄 ${stats.doing || 0} 进行中</span>
          <span class="pm-stat-badge">✅ ${stats.done || 0} 已完成</span>
        </div>

        <div class="pm-actions">
          ${!isActive ? `<button class="btn btn-outline btn-sm btn-pm-switch" data-id="${p.id}">⚡ 切换为此项目</button>` : ''}
          <button class="btn btn-outline btn-sm btn-pm-edit" data-id="${p.id}">✏️ 编辑</button>
          <button class="btn btn-danger btn-sm btn-pm-delete" data-id="${p.id}">🗑️ 删除</button>
        </div>
      </div>
    `;
  }).join('');

  // 绑定事件
  container.querySelectorAll('.btn-pm-switch').forEach(btn => {
    btn.addEventListener('click', () => switchProject(btn.dataset.id));
  });

  container.querySelectorAll('.btn-pm-edit').forEach(btn => {
    btn.addEventListener('click', () => openProjectModal(btn.dataset.id));
  });

  container.querySelectorAll('.btn-pm-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteProject(btn.dataset.id));
  });
}

// 删除项目
async function deleteProject(projectId) {
  const p = allProjects.find(item => item.id === projectId);
  if (!p) return;

  if (!confirm(`确定要删除项目「${p.name}」吗？\n\n该操作将同时清理该项目的独立需求看板数据文件，请谨慎操作！`)) {
    return;
  }

  try {
    showToast(`正在删除项目: ${p.name}...`, 'info');
    await api(`/projects/${projectId}`, { method: 'DELETE' });
    showToast('项目已成功删除', 'success');

    // 重新加载项目和状态
    await loadProjects();
    await loadTasks();
    await loadSettings();
    await refreshGitStatus();
  } catch (e) {
    showToast('删除项目失败: ' + (e.message || e), 'error');
  }
}

// 新建 / 编辑项目模态框
function openProjectModal(projectId = null, defaultPath = '') {
  const modal = document.getElementById('projectModal');
  const title = document.getElementById('projectModalTitle');
  const idInput = document.getElementById('editProjectId');
  const nameInput = document.getElementById('projectModalName');
  const pathInput = document.getElementById('projectModalPath');

  if (!modal) return;

  if (projectId) {
    const p = allProjects.find(item => item.id === projectId);
    if (!p) return;
    title.textContent = '✏️ 编辑项目';
    idInput.value = p.id;
    nameInput.value = p.name || '';
    pathInput.value = p.path || '';
    selectedProjectColor = p.color || '#58a6ff';
  } else {
    title.textContent = '＋ 新建项目看板';
    idInput.value = '';
    nameInput.value = '';
    pathInput.value = defaultPath || '';
    // 如果有 defaultPath，尝试自动预填名称
    if (defaultPath) {
      const parts = defaultPath.split('/').filter(Boolean);
      if (parts.length > 0) nameInput.value = parts[parts.length - 1];
    }
    selectedProjectColor = '#58a6ff';
  }

  // 更新颜色选择器高亮
  document.querySelectorAll('#projectColorPicker .color-swatch').forEach(swatch => {
    if (swatch.dataset.color === selectedProjectColor) {
      swatch.classList.add('active');
    } else {
      swatch.classList.remove('active');
    }
  });

  modal.classList.add('open');
  setTimeout(() => nameInput.focus(), 80);
}

function closeProjectModal() {
  const modal = document.getElementById('projectModal');
  if (modal) modal.classList.remove('open');
}

function initProjectModal() {
  const modal = document.getElementById('projectModal');
  const btnClose = document.getElementById('projectModalClose');
  const btnCancel = document.getElementById('projectModalCancel');
  const btnSave = document.getElementById('projectModalSave');
  const btnBrowse = document.getElementById('btnBrowseModalPath');
  const btnAdd = document.getElementById('btnAddNewProject');

  if (btnAdd) {
    btnAdd.addEventListener('click', () => openProjectModal());
  }

  if (btnClose) btnClose.addEventListener('click', closeProjectModal);
  if (btnCancel) btnCancel.addEventListener('click', closeProjectModal);

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeProjectModal();
    });
  }

  // 颜色选择
  document.querySelectorAll('#projectColorPicker .color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      document.querySelectorAll('#projectColorPicker .color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      selectedProjectColor = swatch.dataset.color;
    });
  });

  // 浏览选择路径
  if (btnBrowse) {
    btnBrowse.addEventListener('click', () => {
      const current = document.getElementById('projectModalPath').value.trim();
      openBrowser(current, 'projectModalPath');
    });
  }

  // 保存按钮
  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      const id = document.getElementById('editProjectId').value;
      const name = document.getElementById('projectModalName').value.trim();
      const path = document.getElementById('projectModalPath').value.trim();

      if (!name) {
        showToast('项目名称不能为空', 'error');
        document.getElementById('projectModalName').focus();
        return;
      }

      try {
        if (id) {
          // 编辑现有项目
          await api(`/projects/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              name,
              path,
              color: selectedProjectColor
            })
          });
          showToast('项目信息已更新', 'success');
        } else {
          // 新建项目
          await api('/projects', {
            method: 'POST',
            body: JSON.stringify({
              name,
              path,
              color: selectedProjectColor,
              set_active: true
            })
          });
          showToast(`已成功创建项目: ${name} 🎉`, 'success');
        }

        closeProjectModal();
        await loadProjects();
        await loadTasks();
        await loadSettings();
        await refreshGitStatus();
      } catch (e) {
        showToast('保存项目失败: ' + (e.message || e), 'error');
      }
    });
  }
}

// ======= 文件夹浏览器 =======
let browsePath = '';  // 当前浏览路径
let browseIsGit = false;
let browserTargetInputId = 'settingProjectPath';

function openBrowser(startPath, targetInputId = 'settingProjectPath') {
  if (cloudMode) { showToast('目录浏览请在本地版使用', 'info'); return; }
  browserTargetInputId = targetInputId;
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

    browsePath = data.path || dirPath;
    browseIsGit = data.is_git || false;

    const manualInput = document.getElementById('browseManualInput');
    if (manualInput) manualInput.value = browsePath;

    // 更新面包屑
    renderBreadcrumb(browsePath);

    // 更新底部信息 & 选择按钮
    document.getElementById('browseCurrentInfo').textContent = browsePath;
    const selectBtn = document.getElementById('browseSelect');
    selectBtn.disabled = false;
    selectBtn.textContent = browseIsGit ? '✅ 选择此 Git 仓库' : '✅ 选择此文件夹';

    if (data.error && (!data.items || data.items.length === 0)) {
      if (data.is_git) {
        // 该目录是 Git 仓库，只是无权限读取子目录内容，这是正常情况
        list.innerHTML = `<div class="browse-empty">
          <div style="font-size:32px">📦</div>
          <div style="color:var(--text-secondary);font-size:14px;font-weight:600;margin-top:8px">这是一个 Git 仓库</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">无法列出子目录（权限受限），可直接点击底部按钮选择此路径</div>
        </div>`;
      } else {
        list.innerHTML = `<div class="browse-empty"><div style="color:var(--orange)">⚠️ ${escHtml(data.error)}</div><div style="font-size:12px;color:var(--text-muted);margin-top:6px">您可以在上方地址栏直接输入/粘贴目标路径后点击前往</div></div>`;
      }
      return;
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

    if (!data.items || data.items.length === 0) {
      html += '<div class="browse-empty"><div style="font-size:24px">📭</div><div>该目录下没有子文件夹</div></div>';
    } else {
      for (const item of data.items) {
        if (item.name === '.git') continue;
        const gitCls = item.is_git ? ' is-git-repo' : '';
        const gitBadge = item.is_git ? '<span class="git-badge">Git 仓库</span>' : '';
        const icon = item.is_git ? '📦' : '📁';
        html += `<div class="browse-item${gitCls}" data-path="${escHtml(item.path)}">
          <span class="folder-icon">${icon}</span>
          <span class="folder-name">${escHtml(item.name)}</span>
          ${gitBadge}
          <button type="button" class="browse-item-select-btn" data-path="${escHtml(item.path)}" title="直接选择此文件夹">选择此项</button>
        </div>`;
      }
    }

    list.innerHTML = html;

    // 绑定点击事件（进入子目录）
    list.querySelectorAll('.browse-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.browse-item-select-btn')) return;
        loadBrowseDir(el.dataset.path);
      });
    });

    // 绑定行内快捷「选择此项」按钮
    list.querySelectorAll('.browse-item-select-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const selected = btn.dataset.path;
        applySelectedPath(selected);
      });
    });

  } catch (e) {
    list.innerHTML = `<div class="browse-empty"><div>❌ 加载失败</div><div style="font-size:12px">${e.message}</div></div>`;
  }
}

function applySelectedPath(targetPath) {
  if (!targetPath) return;
  const targetInput = document.getElementById(browserTargetInputId);
  if (targetInput) {
    targetInput.value = targetPath;
    if (browserTargetInputId === 'projectModalPath') {
      const nameInput = document.getElementById('projectModalName');
      if (nameInput && !nameInput.value.trim()) {
        const parts = targetPath.split('/').filter(Boolean);
        if (parts.length > 0) {
          nameInput.value = parts[parts.length - 1];
        }
      }
    }
  }
  closeBrowser();
  showToast(`已选择路径：${targetPath}`, 'success');
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
  // 打开浏览器 (设置页触发)
  document.getElementById('btnBrowseFolder').addEventListener('click', () => {
    const current = document.getElementById('settingProjectPath').value.trim();
    openBrowser(current, 'settingProjectPath');
  });

  // 关闭
  document.getElementById('browseClose').addEventListener('click', closeBrowser);
  document.getElementById('browseCancel').addEventListener('click', closeBrowser);
  document.getElementById('browseModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('browseModal')) closeBrowser();
  });

  // 手动输入路径直达
  const manualInput = document.getElementById('browseManualInput');
  const btnGo = document.getElementById('btnBrowseGo');
  if (btnGo && manualInput) {
    btnGo.addEventListener('click', () => {
      const val = manualInput.value.trim();
      if (val) loadBrowseDir(val);
    });
    manualInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = manualInput.value.trim();
        if (val) loadBrowseDir(val);
      }
    });
  }

  // 选择按钮
  document.getElementById('browseSelect').addEventListener('click', () => {
    applySelectedPath(browsePath);
  });
}

// ======= 看板视图控制（文档直读 / 紧凑模式 / 全部展开） =======
let isAllDocsExpanded = false;

function initKanbanViewControls() {
  const btnDoc = document.getElementById('viewBtnDoc');
  const btnCompact = document.getElementById('viewBtnCompact');
  const btnToggleAll = document.getElementById('btnToggleAllExpand');
  const kanbanBoard = document.querySelector('.kanban-board');
  if (!btnDoc || !btnCompact || !kanbanBoard) return;

  const currentMode = localStorage.getItem('kanban_view_mode') || 'doc';
  applyViewMode(currentMode);

  btnDoc.addEventListener('click', () => {
    applyViewMode('doc');
  });

  btnCompact.addEventListener('click', () => {
    applyViewMode('compact');
  });

  if (btnToggleAll) {
    btnToggleAll.addEventListener('click', () => {
      isAllDocsExpanded = !isAllDocsExpanded;
      document.querySelectorAll('.card-doc-box').forEach(docBox => {
        const toggleBtn = docBox.querySelector('.card-doc-toggle-btn');
        if (isAllDocsExpanded) {
          docBox.classList.add('is-expanded');
          if (toggleBtn) toggleBtn.textContent = '收起 ▴';
        } else {
          // 如果是短文档保持展开，长文档恢复折叠
          const content = docBox.querySelector('.card-doc-content');
          if (content && content.scrollHeight > 150) {
            docBox.classList.remove('is-expanded');
            if (toggleBtn) toggleBtn.textContent = '展开全部 ▾';
          }
        }
      });
      btnToggleAll.textContent = isAllDocsExpanded ? '↕ 全部收起' : '↕ 全部展开';
    });
  }

  function applyViewMode(mode) {
    localStorage.setItem('kanban_view_mode', mode);
    if (mode === 'compact') {
      kanbanBoard.classList.add('view-compact');
      btnCompact.classList.add('active');
      btnDoc.classList.remove('active');
    } else {
      kanbanBoard.classList.remove('view-compact');
      btnDoc.classList.add('active');
      btnCompact.classList.remove('active');
    }
  }
}

// ======= 垃圾箱管理 =======
let trashTasks = [];
let trashCount = 0;

async function updateTrashBadge(count = null) {
  try {
    if (typeof count === 'number') {
      trashCount = count;
    } else {
      const data = await api('/tasks/trash');
      trashCount = data.count || 0;
    }
    const badge = document.getElementById('trashCountBadge');
    const btn = document.getElementById('btnOpenTrash');
    if (badge) badge.textContent = trashCount;
    if (btn) {
      if (trashCount > 0) btn.classList.add('has-items');
      else btn.classList.remove('has-items');
    }
  } catch (e) {
    console.warn('获取垃圾箱计数失败:', e);
  }
}

async function openTrashModal() {
  const modal = document.getElementById('trashModal');
  if (!modal) return;
  modal.classList.add('open');
  await loadTrashTasks();
}

function closeTrashModal() {
  const modal = document.getElementById('trashModal');
  if (modal) modal.classList.remove('open');
}

async function loadTrashTasks() {
  try {
    const data = await api('/tasks/trash');
    trashTasks = data.tasks || [];
    renderTrashList();
    updateTrashBadge(trashTasks.length);
  } catch (e) {
    showToast('加载垃圾箱失败', 'error');
  }
}

function renderTrashList() {
  const list = document.getElementById('trashList');
  const emptyState = document.getElementById('trashEmptyState');
  const subtitle = document.getElementById('trashModalSubtitle');
  const btnEmpty = document.getElementById('btnEmptyTrash');
  if (!list || !emptyState) return;

  if (subtitle) {
    subtitle.textContent = `共 ${trashTasks.length} 个已废弃需求`;
  }

  if (trashTasks.length === 0) {
    list.innerHTML = '';
    emptyState.style.display = 'block';
    if (btnEmpty) btnEmpty.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  if (btnEmpty) btnEmpty.style.display = 'inline-flex';

  list.innerHTML = trashTasks.map(t => {
    const statusText = t.status === 'done' ? '✅ 已完成' : t.status === 'doing' ? '🔄 进行中' : '📝 待做';
    const statusClass = `badge-${t.status || 'todo'}`;
    const timeStr = t.deleted_at ? `已删除于 ${formatTime(t.deleted_at)}` : '';

    const promptSnippet = (t.prompt || '').trim();
    const previewHtml = promptSnippet
      ? `<div class="trash-item-preview">${escHtml(promptSnippet.length > 140 ? promptSnippet.slice(0, 140) + '...' : promptSnippet)}</div>`
      : '';

    return `
      <div class="trash-item" data-id="${t.id}">
        <div class="trash-item-header">
          <div class="trash-item-left">
            <span class="trash-item-badge ${statusClass}">${statusText}</span>
            <span class="trash-item-title" title="${escHtml(t.title)}">${escHtml(t.title)}</span>
          </div>
          <span class="trash-item-time">${timeStr}</span>
        </div>
        ${previewHtml}
        <div class="trash-item-actions">
          <button class="btn-trash-restore" data-id="${t.id}">↩ 还原需求</button>
          <button class="btn-trash-delete" data-id="${t.id}">🗑 彻底删除</button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.btn-trash-restore').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await restoreTask(id);
    });
  });

  list.querySelectorAll('.btn-trash-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await permanentDeleteTask(id);
    });
  });
}

async function permanentDeleteTask(id) {
  const task = trashTasks.find(t => t.id === id);
  const taskTitle = task ? task.title : '该需求';
  if (!confirm(`确定彻底删除需求「${taskTitle}」？\n\n此操作将永久抹除数据，无法恢复！`)) return;

  try {
    await api(`/tasks/${id}`, { method: 'DELETE' });
    trashTasks = trashTasks.filter(t => t.id !== id);
    renderTrashList();
    updateTrashBadge(trashTasks.length);
    showToast('需求已彻底永久删除', 'success');
  } catch (e) {
    showToast('彻底删除失败', 'error');
  }
}

async function emptyTrash() {
  if (trashTasks.length === 0) return;
  if (!confirm(`确定要清空垃圾箱吗？\n\n共 ${trashTasks.length} 个废弃需求将被永久删除，不可恢复！`)) return;

  try {
    await api('/tasks/trash', { method: 'DELETE' });
    trashTasks = [];
    renderTrashList();
    updateTrashBadge(0);
    showToast('垃圾箱已彻底清空 🧹', 'success');
  } catch (e) {
    showToast('清空失败', 'error');
  }
}

function initTrashModal() {
  const btnOpen = document.getElementById('btnOpenTrash');
  const modal = document.getElementById('trashModal');
  const btnClose = document.getElementById('trashModalClose');
  const btnDone = document.getElementById('trashModalDone');
  const btnEmpty = document.getElementById('btnEmptyTrash');

  if (btnOpen) btnOpen.addEventListener('click', openTrashModal);
  if (btnClose) btnClose.addEventListener('click', closeTrashModal);
  if (btnDone) btnDone.addEventListener('click', closeTrashModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeTrashModal();
    });
  }
  if (btnEmpty) btnEmpty.addEventListener('click', emptyTrash);
}

// ======= 需求本地备份 =======
let backupItems = [];

async function loadBackupSummary() {
  try {
    const s = await api('/backups');
    document.getElementById('bkTotal').textContent = s.total_archived;
    document.getElementById('bkAlive').textContent = s.alive_count;

    const delEl = document.getElementById('bkDeleted');
    delEl.textContent = s.deleted_count;
    delEl.classList.toggle('has-value', s.deleted_count > 0);

    document.getElementById('bkSnapshots').textContent = s.snapshots.count;
    const dirEl = document.getElementById('bkDir');
    dirEl.textContent = cloudMode ? '云端存储（可导出下载）' : s.backup_dir;
    dirEl.title = cloudMode ? '备份随看板一起持久保存' : s.backup_dir;
    document.getElementById('bkUpdatedAt').textContent =
      `最近备份：${s.updated_at ? formatTime(s.updated_at) : '—'}` +
      (s.journal.latest ? `　·　事件日志 ${s.journal.latest}` : '');
  } catch (e) {
    document.getElementById('bkUpdatedAt').textContent = '备份状态读取失败，请确认服务已启动';
  }
}

function openBackupModal() {
  document.getElementById('backupModal').classList.add('open');
  document.getElementById('backupSearch').value = '';
  document.getElementById('backupOnlyDeleted').checked = false;
  loadBackupList();
}

function closeBackupModal() {
  document.getElementById('backupModal').classList.remove('open');
}

// 需求变更后，只有在设置页可见时才刷新备份概览，避免无谓的请求
function refreshBackupSummaryIfVisible() {
  const panel = document.getElementById('tab-settings');
  if (panel && panel.classList.contains('active')) loadBackupSummary();
}

async function loadBackupList() {
  const listEl = document.getElementById('backupList');
  const q = document.getElementById('backupSearch').value.trim();
  const onlyDeleted = document.getElementById('backupOnlyDeleted').checked;
  listEl.innerHTML = '<div class="backup-empty">加载中…</div>';
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (onlyDeleted) params.set('deleted', '1');
    const qs = params.toString();
    const res = await api(`/backups/archive${qs ? '?' + qs : ''}`);
    backupItems = res.items || [];
    renderBackupList(backupItems);
  } catch (e) {
    listEl.innerHTML = '<div class="backup-empty">读取备份档案失败</div>';
    document.getElementById('backupListInfo').textContent = '';
  }
}

function renderBackupList(items) {
  const listEl = document.getElementById('backupList');
  document.getElementById('backupListInfo').textContent = `共 ${items.length} 条备份记录`;

  if (!items.length) {
    listEl.innerHTML = `<div class="backup-empty">
      <div style="font-size:28px">🗂️</div>
      <div>没有匹配的备份记录</div>
    </div>`;
    return;
  }

  listEl.innerHTML = items.map(it => {
    const statusLabel = { todo: '📝 待做', doing: '🔄 进行中', done: '✅ 已完成' }[it.status] || it.status;
    const tags = (it.tags || []).slice(0, 4)
      .map(t => `<span class="backup-badge">${escHtml(t)}</span>`).join('');
    const prompt = it.prompt ? escHtml(it.prompt.replace(/\s+/g, ' ').slice(0, 140)) : '';

    return `<div class="backup-item ${it.deleted_at ? 'is-deleted' : ''}">
      <div class="backup-item-main">
        <div class="backup-item-title">${escHtml(it.title)}</div>
        <div class="backup-item-meta">
          ${it.deleted_at ? '<span class="backup-badge badge-deleted">已删除</span>' : ''}
          <span class="backup-badge">${statusLabel}</span>
          ${it.project_name ? `<span class="backup-badge badge-project">${escHtml(it.project_name)}</span>` : ''}
          ${tags}
          <span>备份于 ${formatTime(it.last_backed_up_at)}</span>
          <span>· ${it.version_count} 个版本</span>
        </div>
        ${prompt ? `<div class="backup-item-prompt">${prompt}</div>` : ''}
      </div>
      <div class="backup-item-actions">
        <button class="btn btn-outline btn-sm btn-restore" data-id="${it.id}">♻️ 恢复</button>
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.btn-restore').forEach(btn => {
    btn.addEventListener('click', () => restoreBackupTask(btn.dataset.id));
  });
}

async function restoreBackupTask(taskId) {
  const item = backupItems.find(i => i.id === taskId);
  const label = item ? item.title : taskId;
  const target = (item && item.project_name) ? `「${item.project_name}」` : '当前项目';
  if (!confirm(`确定把「${label}」恢复到 ${target} 的看板吗？`)) return;

  try {
    const r = await api('/backups/restore', { method: 'POST', body: JSON.stringify({ task_id: taskId }) });
    let msg;
    if (r.fell_back) msg = `原项目已不存在，已恢复到「${r.project_name}」✅`;
    else if (r.revived_from_trash) msg = `已从垃圾箱救回到「${r.project_name}」✅`;
    else msg = `需求已恢复到「${r.project_name}」✅`;
    showToast(msg, 'success');
    await loadTasks();
    await loadStats();
    await loadBackupList();
    await loadBackupSummary();
  } catch (e) {
    showToast('恢复失败：该需求可能已经存在于看板中', 'error');
  }
}

async function createBackupSnapshot() {
  const btn = document.getElementById('btnBackupSnapshot');
  const raw = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 备份中…';
  try {
    const r = await api('/backups/snapshot', { method: 'POST' });
    showToast(`全量备份完成，共 ${r.task_count} 条需求 ✅`, 'success');
    await loadBackupSummary();
  } catch (e) {
    showToast('备份失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = raw;
  }
}

function copyBackupDir() {
  const dir = document.getElementById('bkDir').textContent;
  if (!dir || dir === '—') { showToast('备份目录尚未就绪', 'error'); return; }
  navigator.clipboard.writeText(dir).then(
    () => showToast('备份目录已复制 📋', 'success'),
    () => showToast('复制失败，请手动选择', 'error')
  );
}

// 灾备：档案被误删/写坏时，从只追加的事件日志重放重建
async function rebuildBackupArchive() {
  let preview;
  try {
    preview = await api('/backups/rebuild');
  } catch (e) {
    showToast('无法读取事件日志', 'error');
    return;
  }

  if (!preview.events_applied) {
    showToast('事件日志里没有可重放的记录，未做任何改动', 'error');
    return;
  }

  const msg =
    `将从 ${preview.journal_files} 个事件日志文件中重放 ${preview.events_applied} 条事件，\n` +
    `重建出 ${preview.would_rebuild_tasks} 条需求（其中 ${preview.would_rebuild_deleted} 条为已删除）。\n\n` +
    `当前档案会先另存一份再覆盖。确定继续吗？`;
  if (!confirm(msg)) return;

  try {
    const r = await api('/backups/rebuild', { method: 'POST' });
    showToast(`已从日志重建 ${r.rebuilt_tasks} 条需求（重放 ${r.events_applied} 条事件）✅`, 'success');
    await loadBackupSummary();
  } catch (e) {
    showToast('重建失败', 'error');
  }
}

function initBackupUI() {
  document.getElementById('btnBackupSnapshot')?.addEventListener('click', createBackupSnapshot);
  // 「导出备份」是 <a href> 直链，交给浏览器按服务端 Content-Disposition 下载，无需 JS
  document.getElementById('btnBackupBrowse')?.addEventListener('click', openBackupModal);
  document.getElementById('btnCopyBackupDir')?.addEventListener('click', copyBackupDir);
  document.getElementById('btnBackupRebuild')?.addEventListener('click', rebuildBackupArchive);

  document.getElementById('backupModalClose')?.addEventListener('click', closeBackupModal);
  document.getElementById('backupModalCancel')?.addEventListener('click', closeBackupModal);
  document.getElementById('backupModal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('backupModal')) closeBackupModal();
  });

  let searchTimer = null;
  document.getElementById('backupSearch')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadBackupList, 250);
  });
  document.getElementById('backupOnlyDeleted')?.addEventListener('change', loadBackupList);
}

// ======= 初始化 =======
async function init() {
  try {
    const health = await api('/health');
    cloudMode = health.mode === 'cloud';
  } catch (e) { /* 本地服务仍可继续初始化并显示已有错误提示。 */ }
  if (cloudMode) {
    const notice = document.createElement('div');
    notice.textContent = '☁️ 云端版 · 看板与备份独立保存在云端，不与本地自动同步。Git 状态和目录浏览请使用本地版。';
    notice.style.cssText = 'padding:10px 20px;background:var(--bg-secondary,#161b22);color:var(--text-muted,#8b949e);font-size:13px';
    document.querySelector('header').after(notice);
    document.querySelector('[data-tab="git"]').style.display = 'none';
    document.querySelector('#backupCard h2').textContent = '🗄️ 需求云端备份';
    document.querySelector('#backupCard .card-subtitle').textContent = '需求更新时自动保存备份，可恢复历史内容或导出下载';
    document.getElementById('btnCopyBackupDir').style.display = 'none';
    if (location.hash === '#git') history.replaceState(null, '', '#kanban');
  }
  initTabs();
  initModal();
  initGit();
  initEditor();
  initSettings();
  initBrowser();
  initProjectSwitcher();
  initProjectModal();
  initKanbanViewControls();
  initTrashModal();
  initBackupUI();

  await loadProjects();
  await loadTasks();
  await loadSettings();
}

document.addEventListener('DOMContentLoaded', init);
