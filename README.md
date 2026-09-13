# ⚡ Vibe Coding 仪表盘 (Vibe Coding Dashboard)

专为 AI 辅助编程（Vibe Coding / Cursor / Claude Code / Codex）打造的本地轻量级可视化仪表盘。实时掌握项目开发进度、Git 多工作树状态、需求完成看板，并高效沉淀提示词（Prompt）。

无需安装任何第三方 npm 依赖 —— 采用 Node.js 原生内置模块驱动，开箱即用，极速轻量。

---

## ✨ 核心特性

- 🌿 **Git 状态与工作流全景**：
  - **类 IDE 自由分栏 (Splitter)**：分界线支持鼠标左右拖动，像素级自定义每栏宽度，双击自动 50:50 等分，`localStorage` 本地自动记忆；
  - **多工作树 (Git Worktree) 探测**：自动识别主工作树与所有链接工作树（如 WorkBuddy / Git Worktree），展开展示完整物理路径、最新提交与工作区干净度，支持一键复制路径与一键切换项目；
  - **分支与历史时间线穿梭**：点击分支列表即刻切换右侧「提交历史」时间线；分支若关联工作树，可一键切换为当前活动项目；
  - **实时自动感知**：每 5 秒自动轮询，文件修改、暂存、Commit 及远程 ahead/behind 状态实时更新。
- 📋 **需求看板 (Kanban)**：
  - 待做 / 进行中 / 已完成三栏，支持拖拽移动与任务统计；
  - 任务与 Prompt 深度联动，一键复制预置提示词发送给 AI。
- ✍️ **Prompt 编辑器**：
  - Markdown 实时分栏预览；
  - 内置 4 套经典 Prompt 模板（新功能开发 / Bug 修复 / 代码重构 / 单元测试编写）。
- ⚙️ **零依赖与极简架构**：
  - 无需 `npm install` 沉重依赖，纯 Node.js HTTP 原生开发，内存占用仅约 20MB；
  - 数据以标准 JSON 格式持久化在本地 `server/data/` 目录中。

---

## 🚀 快速启动

```bash
# 1. 启动服务 (需 Node.js >= 16)
npm start

# 2. 浏览器打开
open http://localhost:3333
```

> **安全说明**：服务仅监听 `127.0.0.1`，仅限本机访问。

---

## 🛠️ 首次使用配置

1. 启动后进入右上角 **⚙️ 设置**；
2. 点击 **📂 浏览选择** 或手动填入本地 Git 仓库路径（例如 `/Users/yourname/my-project`）；
3. 保存后切换至 **🌿 Git 状态** 即可开始体验！

---

## 📁 数据存储

- `server/data/tasks.json` —— 看板需求与待办数据
- `server/data/config.json` —— 项目路径与本地配置（已加入 `.gitignore`，安全防泄露）

