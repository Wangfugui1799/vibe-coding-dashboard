# Vercel 部署

本地仍使用 `PORT=3336 npm start`，无需数据库、账号或额外依赖。本地数据保持在 `server/data/`，Git 与目录浏览功能保留。

云端版使用独立的 Upstash Redis 数据，不会上传或同步本地任务、路径和备份。首次运行创建空看板。云端支持项目、任务、Prompt、回收站、备份与恢复；本机 Git、目录浏览只在本地使用。

## 部署步骤

1. 在 Vercel 点击 **Add New → Project**，导入 `Wangfugui1799/vibe-coding-dashboard`。
2. Framework Preset 选 **Other**，Root Directory 保持仓库根目录。仓库的 `vercel.json` 已配置入口；Build Command 为空，Output Directory 为 `public`，不填写 `npm start`。
3. 从 Vercel Marketplace 添加 **Upstash Redis** 并连接项目，或在 Upstash 控制台创建数据库，复制 REST URL 和可写 REST Token。
4. 在 Vercel 项目的 Environment Variables 配置：

| 变量 | 值 |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | Redis 的 HTTPS REST 地址 |
| `UPSTASH_REDIS_REST_TOKEN` | Redis 的可写 REST Token（不是 Readonly Token） |
| `DASHBOARD_PASSWORD` | 自行生成至少 16 位的随机密码 |
| `DASHBOARD_USERNAME` | 可选，默认 `admin` |

也支持 Marketplace 提供的 `KV_REST_API_URL` / `KV_REST_API_TOKEN`。凭证只配置在 Vercel，不提交 GitHub。

5. 点击 Deploy。更改环境变量后重新部署。打开网址时浏览器会弹出登录框，输入用户名 `admin` 和设置的密码。此版本是共用一个工作区的个人仪表盘，不支持多用户权限隔离。
6. 创建任务并刷新确认保存，再在设置里试一次备份导出。之后推送到生产分支 `main` 会自动部署。

没有配置密码或数据库时会显示配置错误，绝不会使用临时文件假装保存成功。设置更新失败时先刷新确认，不要连续重复提交。

## 存储与边界

- Redis 保存一个带版本号的完整数据文档，包括所有看板、档案、日志与快照。每次请求用独立临时目录执行已有业务逻辑；写入 Redis 成功才返回成功，临时目录随后清理。
- 并发写入使用 Redis Lua 原子版本检查；冲突返回 409，请刷新后重试，避免覆盖其他窗口的更新。
- 默认 key 为 `vibe-dashboard:production:v1`、`vibe-dashboard:preview:v1` 或 `vibe-dashboard:development:v1`，生产与预览隔离，同一环境内共享。可以用 `DASHBOARD_REDIS_KEY` 指定独立工作区。不要让预览与生产使用同一个自定义 key。
- 此方案适合小型个人看板，整个文档上限 3 MB（含备份）。达到上限后拒绝新增写入，仍可读取、导出，不会自动删除历史。大量任务或长期日志应改为按记录存储的数据库。定期下载备份，Redis 数据库不要开启自动驱逐业务数据。
- 首次云端看板为空。本地数据不会因为推送、云端部署而迁移；保留原本本地运行习惯即可。
- `server/data/` 已停止 Git 跟踪，现有本地文件保留。旧 Git 提交中的历史数据没有被重写。

## 验证

使用 Node.js 22 或更高版本执行 `npm test`。本地运行本身仍支持 Node.js 16+；云端使用 Vercel 支持的现代 Node.js 版本（建议在项目设置选择 22.x）。

测试包括本地磁盘持久化、云端认证、增删改与备份恢复、请求隔离、数据库失败与并发冲突。测试使用模拟 Redis REST 服务，不需要真实凭证；上线后需按步骤 6 验证真实数据库连接。

参考：[Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)、[Upstash REST API](https://upstash.com/docs/redis/features/restapi)。
