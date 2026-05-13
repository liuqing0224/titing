---
name: titing-architecture
description: Aligns design and implementation with the TiTing target architecture (layers, bounded modules, aggregates, CQRS-ish API, events, leases, observability). Use when working on TiTing/Titing, task lifecycle, scheduler, workspace, execution, repair loop, governance, console/BFF, or evolving code toward docs/architecture/titing-architecture-description.md.
disable-model-invocation: true
---

# TiTing 目标架构对齐

设计与实现前先对照 [titing-architecture-description.md](../../../docs/architecture/titing-architecture-description.md)（下文称「架构文档」）。目标是**边界清晰、事件可观测、可恢复、插件外置变化点**，而不是复述当前目录结构。

## 系统定位

TiTing 是 **AI 工程执行控制平台**：任务接入 → 调度 → 工作区准备 → 执行器调用 → 质量评估 → 自动修复 → 人工接管 → 观测治理。定位是执行控制器与控制平面，不是单纯工单系统也不是单一 Agent 封装。

## 分层（实现归属自查）

| 层 | 职责 | 不负责 |
| --- | --- | --- |
| Presentation | HTTP/Webhook/SSE/WebSocket、DTO、校验、鉴权封装 | 状态机裁决、调度、插件业务规则 |
| Application | 用例编排、事务边界、发布领域/集成事件、幂等与重试 | 纯领域不变量应由 Domain 守住 |
| Domain | 实体/值对象、状态机与约束、聚合边界、策略接口 | 具体 DB/框架 |
| Domain Service / Policy | 调度/修复/路由/风险等「跨实体业务判断」 | 与 Application 分清：编排 vs 规则 |
| Infrastructure | DB、日志、事件总线、插件加载、Git/进程/FS | — |
| Extension | 可替换实现、能力发现匹配、外部接入 | — |

架构风格：**模块化单体 + Ports/Adapters + 领域服务编排**。核心领域**不得**依赖具体 Web 框架与数据库驱动（架构文档 §13）。

## 核心模块速查（改哪里）

按职责落位：`Identity & Access`、`Task Intake`、`Task Lifecycle`、`Scheduler`、`Agent Capacity`、`Workspace`、`Execution Orchestration`、`Quality Evaluation`、`Repair Loop`、`Human Intervention`、`Plugin Management`、`Observability`、`Governance & Risk`、`Notification`、`Console BFF`。

主协作链（对齐改造时对照）：

- **建任务**：`Presentation → Task Intake → Task Lifecycle → Event Store → Notification`
- **调度执行**：`Scheduler → Agent Capacity → Workspace → Execution → Quality → Repair Loop → Task Lifecycle`
- **人工**：`Repair Loop → Human Intervention → Notification → … → Human Intervention → Task Lifecycle → Scheduler`
- **插件调用**：`Application → Capability Router → Plugin Policy → Capability Plugin → Observability`

## 领域聚合与职责

修改任务/执行相关模型时对齐以下边界：

- **Task**：聚合根；状态仅按状态机迁移；不写放大日志/raw 输出大块报告。
- **Execution**：一次运行尝试；实例、结果索引、关联日志/评测/修复原因。
- **RepairPlan**：显式建模修复目标与轮次/stopSignal，区别于「单纯失败计数」。
- **HumanReview**：正式人工流程；请求类型、`responseSummary`、`externalThreadRef`；恢复时需可追溯基于哪条反馈。
- **Agent + AgentLease**：占用与并发用租约建模，避免仅在 Agent 上挂 `taskId`；支持超时回收与恢复。

建议任务生命周期状态（可加子状态/原因字段，忌无限堆砌顶层枚举）：`draft` → `ready` → `scheduled` → `executing` → `evaluating` → `repairing` → `waiting_human` → `completed` / `failed` / `cancelled`。

架构文档列出的 Lifecycle 命令（`createTask`、`submitTask`、`scheduleTask`、`startExecution`、`enterEvaluation`、`enterRepair`、`requestHumanReview`、`completeTask`/`failTask`/`cancelTask`/`resumeTask` 等）是语义参考：状态迁移须 **reason + 领域事件**，且**状态规则不得与路由层耦合**。

## API / BFF / 前端原则

- **命令与查询分离**：命令示例 `POST /tasks`、`POST /tasks/{id}/submit|cancel|resume`、`POST /ops/scheduler/tick`；查询 `GET /tasks`、`GET /tasks/{id}`、`…/timeline`、`…/executions`、`GET /dashboard`。
- 避免：状态名细碎映射碎片化 API、前端推导状态机、直接暴露内部存储形状。
- **Console BFF**：只读、可缓存、面向视图；服务端聚合业务，前端不承载状态机与修复决策规则。

## 存储与一致性

三类存储：**事务存储**（任务、执行、租约、RepairPlan、HumanReview）、**事件/审计存储**、**对象/文件**（原始日志、产物附件）。同一聚合尽量本地事务；跨聚合倾向事件驱动最终一致；长流程依赖**幂等命令与可重放语义**。

## 硬约束（长期）

以下内容作为代码审查与设计评审的否决级检查项（摘自架构文档 §13）：

1. 核心领域层不得依赖具体 Web 框架和数据库驱动  
2. 所有状态迁移必须经过显式命令  
3. 所有关键动作必须产出结构化事件  
4. 插件不得直接改写核心存储里的任务/执行/修复/审计等权威结果  
5. 调度与执行须通过租约或等价并发控制机制  
6. 人工接管须为正式领域流程，而非「异常分支补丁」  
7. 前端不得承载状态机和修复预算/停止等业务裁决规则  

## 向目标态演进顺序（参考）

如需大规模重构，优先顺序（架构文档 §14）：先拆 CQRS → 拆调度/执行/修复编排 → 引入 `AgentLease` 与 `RepairPlan` → 来源字段结构化 → 插件注册中心 + 能力路由 → 最后拆控制台与 BFF。

## 配套 skills

- [titing-plugin-authoring](../titing-plugin-authoring/SKILL.md) — 插件 kind、能力与路由
- [titing-architecture-standards](../titing-architecture-standards/SKILL.md) — MUST/MUST NOT 门禁与评审清单
