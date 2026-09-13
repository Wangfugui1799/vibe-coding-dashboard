# ⚡ Vibe Coding 仪表盘

在 Vibe Coding 过程中，实时掌握项目进度、Git 状态、需求完成情况，并高效管理待办 Prompt 文档。

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 启动服务
npm start

# 3. 浏览器访问
open http://localhost:3333
```

## 功能

| 模块 | 功能 |
|------|------|
| 📋 需求看板 | 三栏 Kanban（待做 / 进行中 / 已完成），拖拽移动，一键复制 Prompt |
| 🌿 Git 状态 | 实时分支、最新 commit、变更文件、提交时间线，每 5 秒自动刷新 |
| ✍️ Prompt 编辑 | Markdown 编辑器 + 实时预览，内置 4 种模板，一键复制给 AI |
| ⚙️ 设置 | 配置 Git 项目路径、项目名称，查看今日完成统计 |

## 首次使用

1. 启动后点击 **⚙️ 设置** Tab
2. 填写你的 Git 项目的本地路径（如 `/Users/yourname/myproject`）
3. 点击保存，切到 **🌿 Git 状态** 即可看到实时信息

## 数据存储

所有数据保存在 `server/data/` 目录下：
- `tasks.json` —— 需求数据
- `config.json` —— 项目配置
