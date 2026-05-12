# Titing

Titing 是一个 local-first 的 AI 工程执行控制器。它负责任务生命周期、调度、Goal Loop、观测、治理，以及把外部任务源接入统一执行链路。

当前仓库已经完成从旧双轨实现到新架构的收敛：

- 后端宿主：Fastify
- 核心：纯 TypeScript `packages/core/src/titing/*`
- 插件协议：`packages/plugin-api/src/titing/*`
- 持久化：SQLite + SQL migrations
- 运行能力：本地 `git worktree`、Codex/Cursor CLI、质量检查链
- 前端：React 控制台

## 目录

```text
apps/
  server/                    Titing server host
  web/                       Titing web console
packages/
  core/                      Core controller runtime
  plugin-api/                Stable plugin contracts
docs/
  architecture/              设计、配置、运维与任务清单
```

## 关键能力

- 任务状态机：`created -> validated -> pending -> queued -> running -> evaluating -> repairing -> done`
- Goal Loop：支持 repair continuation、重复失败识别、no-diff 停止、高风险阻断
- 工程环境：repo cache、git worktree、依赖安装、artifact 保留、失败清理策略
- 执行器：Codex / Cursor CLI，支持从 `WORKFLOW_PROMPTS.md` 解析节点 workflow，并返回结构化 session/summary/errorCategory
- 质量闭环：`lint / typecheck / test / build` + diff risk
- 治理：secret scan、命令 allow/block policy、输出脱敏、评测后风险阻断
- 观测：execution logs、SSE、trace 聚合查询、任务诊断脚本
- 任务接入：手工创建、Meegle polling、Meegle webhook

## Workflow Prompt System

目标仓库可通过以下任一文件声明执行 workflow：

- `knowledge/WORKFLOW_PROMPTS.md`
- `WORKFLOW_PROMPTS.md`

执行器会解析默认节点顺序、节点 prompt 模板与 `loopEnabled` / `maxLoops` 配置，并在同一个 workspace 中按节点顺序执行。缺失或格式错误时，任务会在执行前失败，而不会回退到旧的单 prompt 模式。

## 快速开始

### 环境

- Node.js + npm
- SQLite
- git
- `codex` CLI 或 Cursor CLI `agent`

### 安装

```bash
npm install
```

### 启动数据库迁移

```bash
npm run migration:run -w apps/server
```

### 启动服务

```bash
npm run dev:backend
npm run dev:frontend
```

默认地址：

- Web: `http://localhost:5173`
- API: `http://localhost:3000/api`

## 常用命令

```bash
npm run build
npm test
npm run migration:run -w apps/server
npm run migration:legacy -w apps/server
npm run smoke:sqlite -w apps/server
npm run diagnose:task -w apps/server -- --task-id <task-id>
```

## 文档

- 技术设计：[docs/architecture/titing-technical-design.md](/Users/l/Documents/work/code/demo/autoDevAgent/docs/architecture/titing-technical-design.md:1)
- 未完成任务清单：[docs/architecture/titing-open-tasks.md](/Users/l/Documents/work/code/demo/autoDevAgent/docs/architecture/titing-open-tasks.md:1)
- 配置说明：[docs/architecture/titing-config.md](/Users/l/Documents/work/code/demo/autoDevAgent/docs/architecture/titing-config.md:1)
- 运维说明：[docs/architecture/titing-ops.md](/Users/l/Documents/work/code/demo/autoDevAgent/docs/architecture/titing-ops.md:1)

## 当前状态

旧 `NestJS` / `TypeORM` / 旧插件目录已从代码树中物理移除。当前仓库只保留 Titing 实现路径；若需要了解迁移背景或历史方案，应以 `docs/architecture/*` 为准，而不是旧资料。
