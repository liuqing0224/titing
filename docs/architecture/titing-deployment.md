# Titing 生产部署说明

更新日期：2026-05-11

本文档给出当前单机部署建议。当前实现更适合单实例、local-first 场景，不建议直接按多实例共享同一 SQLite 文件横向扩容。

## 部署形态

推荐：

- 1 个 Titing server 进程
- 1 个 SQLite 数据文件
- 本地磁盘持久化 `.titing/`
- 本机可用 git、执行器 CLI、目标仓库网络访问

不推荐：

- 多个 server 进程同时写同一 SQLite 文件
- 多机共享网络盘上的 SQLite 主库

## 运行前准备

- Node.js 运行时版本需支持 `node:sqlite`
- 安装 npm 依赖
- 安装 `git`
- 安装 `codex` 或 Cursor CLI `agent`
- 为工作目录和数据库目录准备持久化磁盘

推荐持久化目录：

- `.titing/sqlite`
- `.titing/repos`
- `.titing/workspaces`
- Meegle 文件接入目录（如使用）

## 建议环境变量

最小集：

```bash
export BACKEND_PORT=3000
export DATABASE_FILE=/var/lib/titing/sqlite/titing.sqlite
export TITING_WORKSPACE_ROOT=/var/lib/titing/workspaces
export TITING_WORKSPACE_REPO_CACHE_ROOT=/var/lib/titing/repos
export TITING_PLUGIN_EXECUTION_CODEX_BIN=codex
export TITING_PLUGIN_EXECUTION_CURSOR_BIN=agent
```

Webhook 模式还需要：

```bash
export TITING_PLUGIN_MEEGLE_MODE=webhook
export TITING_PLUGIN_MEEGLE_WEBHOOK_SECRET=<secret>
```

## 启动顺序

1. `npm install --omit=dev`
2. `npm run build`
3. `npm run migration:run -w apps/server`
4. `npm run start -w apps/server`
5. 校验 `/api/health` 和 `/api/readiness`

## 升级流程

推荐顺序：

1. 备份当前 `DATABASE_FILE`
2. 备份 `.titing/repos` 与必要 artifacts
3. 拉取新版本代码
4. 安装依赖并 build
5. 停旧进程
6. 执行 `migration:run`
7. 启新进程
8. 校验 `health/readiness/dashboard`

## 资源建议

受执行器与仓库规模影响较大，建议起点：

- CPU: 2-4 core
- Memory: 4-8 GB
- Disk: 至少 20 GB，可随 repo cache 增长

实际压测前不要把 `agentCount` 配太高。默认 `2` 更安全。

## 反向代理

若放在 Nginx/Caddy 后：

- 保留 `/api/events` 的流式连接
- 提高 SSE 连接超时
- 对 webhook 端点保留真实来源 IP

## 备份建议

至少备份：

- `DATABASE_FILE`
- `.titing/repos`
- 必要时 `.titing/workspaces/artifacts`

SQLite 备份建议在服务停止或低写入时进行，避免拿到不完整文件快照。

## 已知限制

- 当前数据库为 SQLite，单机写入模型优先
- scheduler 互斥是单进程内语义，不是分布式锁
- 执行器依赖本机 CLI 和本机权限模型

