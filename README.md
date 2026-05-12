# Titing

Titing 是一个 local-first 的 AI 工程执行控制器。它负责任务生命周期、调度、Goal Loop、观测、治理，以及把外部任务源接入统一执行链路。

运行时需要 Node.js 自带的内置 SQLite 绑定（node:sqlite），具体见架构文档。默认数据库路径为 .titing/sqlite/titing.sqlite，可用环境变量 DATABASE_FILE 覆盖。

技术栈概要：

- 后端宿主：Fastify
- 核心：纯 TypeScript（core 包）
- 插件协议：plugin-api 稳定契约包
- 持久化：SQLite 单文件与 SQL 迁移；数据访问实现在服务端应用中（仓储层类名前缀为 Pg，底层为 SQLite）
- 运行能力：本地 git worktree、Codex/Cursor CLI、质量检查链
- 前端：React 控制台

## 目录结构（概览）

应用与包位于 apps 与 packages 目录；设计、配置与运维说明在 docs/architecture；可选工作流提示词模板在 docs/templates。

## 内置插件栈

宿主在源码中按插件种类编排默认实现；进程启动时再根据环境变量是否与外置包合并：**若配置了 TITING_PLUGIN_*_PACKAGE，则对应的整个种类由外置模块单独替换**。策略与范例见下文「如何新增插件」及插件开发文档。

| 顺序 (Order) | 插件标识 (Plugin ID) | 类型 (kind) | 能力标签 (capability) | 说明 |
| --- | --- | --- | --- | --- |
| 1 | root-logs | log | default | 根目录 logs 目录结构化落盘与 SSE 数据源 |
| 2 | meegle | task-integration | meegle | Meegle 文件轮询、Webhook，或可选 CLI 拉最新迭代 |
| 3 | git-worktree-local | environment | local-worktree | 镜像缓存、git worktree、依赖安装与清理 |
| 4 | codex | execution | codex | Codex CLI |
| 5 | cursor | execution | cursor | Cursor CLI agent |
| 6 | default-quality | quality | default | lint、类型检查、测试、构建及 diff 风险 |
| 7 | default-observability-governance | observability-governance | default | 命令策略、脱敏、敏感信息扫描与评测后策略 |

任务的 executor 须与所选执行插件的 capabilities 一致；未指定任务执行器时使用环境变量里的默认执行器（见配置说明）。

## 关键能力

- 任务状态机：自创建直至完成的多阶段迁移
- Goal Loop：支持修复续跑、重复失败收敛、无有效 diff、高风险等停止条件
- 工程环境与工作区管理与清理策略
- 执行器通过工作流提示词文件驱动多节点执行
- 质量脚本链与变更风险度量
- 治理与观测、trace 聚合与诊断脚本
- 任务来源：手动创建 Meegle 轮询或 Webhook

## Workflow Prompt System

目标仓库可在以下任选路径提供工作流说明文件：

- knowledge/WORKFLOW_PROMPTS.md
- WORKFLOW_PROMPTS.md

执行器解析节点顺序、模板与本地循环上限，在同一工作区内顺序执行。

## 快速开始

### 环境要求

- Node.js + npm（需支持内置模块 node:sqlite）
- git
- codex CLI 或 Cursor 的 agent 子命令

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

- Web：http://localhost:5173
- API：http://localhost:3000/api

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

设计与实现：[技术设计](./docs/architecture/titing-technical-design.md)、[HTTP API](./docs/architecture/titing-api.md)、[数据库 Schema](./docs/architecture/titing-database-schema.md)、[插件开发](./docs/architecture/titing-plugin-development.md)

配置与运维：[配置说明](./docs/architecture/titing-config.md)、[本地开发](./docs/architecture/titing-local-dev.md)、[生产部署](./docs/architecture/titing-deployment.md)、[运维手册](./docs/architecture/titing-ops.md)、[未完成任务清单](./docs/architecture/titing-open-tasks.md)

模板：[WORKFLOW_PROMPTS 示例](./docs/templates/WORKFLOW_PROMPTS.example.md)

## 如何新增插件

### 外置插件（不改本仓库源码）

在配置中填入各插件种类对应的环境变量，指向 npm 包名或可动态导入的文件路径；包须导出 createPlugin（接收配置快照与 pluginKind），并返回符合该种类的单个插件。**execution 一旦被外置，内置的 Codex 与 Cursor 会一起被换掉**，通常在 capabilities 内同时写上两种执行标签，或在任务与默认执行器上只保留一种。**细则与可复制思路**见 [插件开发文档](./docs/architecture/titing-plugin-development.md)。

### 内置插件（本仓库）

1. **对齐契约**：先在插件契约包中为领域概念补类型与接口。
2. **在本仓实现**：在服务端应用的插件目录内新增类或函数，补上 id、kind、priority、capabilities、health（及可选 init）。
3. **注册**：把新实例并入内置插件分组；运行时的优先与启用仍由插件配置表与运行时共同决定。
4. **如需 Webhook**：在任务接入实现上顺带满足宿主约定的「可注册 HTTP 路由」扩展形状。
5. **专有配置**：需要新环境变量时走统一的配置快照结构，运行时开关仍可依赖插件配置表或 HTTP 运维接口更新。
6. **测试**：为健康检查、主干路径及外置装载若有交叉影响则补回归。

设计与边界仍以 [插件开发文档](./docs/architecture/titing-plugin-development.md) 为准。
