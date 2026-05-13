# Titing 未完成任务清单

更新日期：2026-05-13

本文档基于当前仓库的实际落地结果整理，仅列出**未完成**或**仅有骨架**的任务，作为后续实现清单。  
当前已完成的范围：Fastify 宿主、纯 TypeScript Core、基础状态机、SQL migration runner、SQLite repository、基础 API、SSE、最小控制台。
本文档同时补充与目标设计 [titing-architecture-description.md](./titing-architecture-description.md) 不一致、尚待补齐的任务。

## 使用说明

- [ ] 未开始
- [~] 已有骨架，但实现不完整
- [x] 不在本文档列出

---

## 0. 目标架构对齐

### 0.1 核心模块拆分

- [x] 新增 `packages/core/src/titing/task-command-service.ts`，把命令类任务入口收敛为独立门面，并由 `TitingServices` 组合暴露。
- [x] 新增 `packages/core/src/titing/task-query-service.ts`，将任务/Trace/观测类查询接口收敛为独立门面。
- [x] 新增 `packages/core/src/titing/scheduler-service.ts`，补充 scheduler 门面，并保留现有调度测试覆盖。
- [x] 新增 `packages/core/src/titing/execution-orchestrator.ts` 和 `packages/core/src/titing/repair-loop-service.ts`，将执行编排与修复循环边界显式建模。
- [x] 新增 `packages/core/src/titing/human-intervention-service.ts`，集中承接人工回复去重与恢复入口。
- [x] 新增 `packages/core/src/titing/plugin-admin-service.ts`，集中处理 plugin list/config 更新入口。
- [x] 为 `Task`、`Execution`、`RepairPlan`、`HumanReview`、`AgentLease` 补齐 TypeScript 类型定义与映射函数，并新增 round-trip 测试。

### 0.2 插件生态重构

- [x] 新增 `packages/core/src/titing/plugin-capability-router.ts`，实现 `kind + capability + priority` 三元路由。
- [x] 新增 `packages/core/src/titing/plugin-policy-engine.ts`，实现启用/禁用与优先级仲裁。
- [x] 新增 `packages/core/src/titing/plugin-lifecycle-manager.ts`，统一执行 `validate -> init -> health -> close` 生命周期。
- [x] 为 `@titing/plugin-api` 增加 `PluginCapability`、`PluginManifest`、`PluginDependency`、`PluginConfigSchema` 类型。
- [x] 把 `apps/server/src/titing/external-plugins.ts` 改成基于 manifest 的装配器，并在 bootstrap 阶段做 kind-specific contract 校验。
- [x] 为 `task-source`、`workspace`、`executor`、`quality-check`、`governance`、`log-store`、`observability`、`notification`、`intelligence`、`platform` 各写一份最小可执行插件骨架和测试。

### 0.3 核心能力域补齐

- [x] 为 `task-source` 定义 `pullTasks()`、`ackTask()`、`reportResult()`、`pullHumanReplies()` 四个标准方法，并通过骨架插件测试校验接口存在。
- [x] 为 `workspace` 定义 `prepareWorkspace()`、`restoreWorkspace()`、`snapshotWorkspace()`、`cleanupWorkspace()` 四个标准方法，并将 artifact 目录规范保持在 `PreparedWorkspace.artifactsPath`。
- [x] 为 `executor` 定义 `execute()`、`resume()`、`interrupt()`、`inspectSession()` 四个标准方法，并统一返回结构。
- [x] 为 `quality-check` 定义统一 `EvaluationReport` 结构，包含 `checks[]`、`riskLevel`、`score`、`acceptanceStatus`、`failureClass`、`evidence`。
- [x] 为 `governance` 定义前置/后置钩子接口，覆盖 `validateCommand()`、`scanSecrets()`、`enforceDiffLimit()`、`approveRisk()`。
- [x] 为 `observability` 定义 `publishEvent()`、`queryTimeline()`、`buildTraceView()`、`computeHealthSnapshot()` 的读写边界。
- [x] 为 `notification` 定义 `notify()`、`notifyHumanReview()`、`notifyStatusChange()`、`routeNotification()` 的统一消息模型。
- [x] 为 `intelligence` 定义 `suggestRepair()`、`classifyRisk()`、`summarizeFailure()`、`rankTasks()`，并约束其为只读建议接口。

### 0.4 平台基础能力补齐

- [x] 新增 `packages/plugin-api/src/titing/models/identity.ts`，定义 `Principal`、`Permission`、`AuditEvent`。
- [x] 新增服务端 `Console BFF` 聚合层 `apps/server/src/titing/ops-view.ts`，并暴露 `/api/ops-view`。
- [x] 将 `execution_logs`、SSE 事件、审计记录补充为明确 channel/schema 语义，统一由稳定 schema envelope 承载。
- [x] 新增 `AgentLease` 表与 repository，支持 `leasedAt`、`leaseExpiresAt`、`releasedAt`、`releaseReason`。
- [x] 为 scheduler 决策补齐 `AgentLease` 解释性字段模型：`candidateAgents`、`selectionReason`、`prioritySnapshot`、`leaseId`。
- [x] 新增 `HumanReview` 表与 repository，支持 `requestType`、`reason`、`externalThreadRef`、`responseSummary`、`status`。

## P0：上线前必须完成

### 1. 执行链路正确性

- [x] 修正执行阶段时序，当前实现是 running -> evaluating -> execute -> quality，应调整为 running -> execute -> evaluating。已改为 scheduler 认领后直接执行，执行完成后再进入 evaluating。
- [x] 为执行过程补充显式的 executions 生命周期状态定义，例如 preparing / executing / evaluating / repairing / completed / failed。已补齐 execution status 模型和状态日志。
- [x] 为任务状态流转补齐执行日志写入；当前只记录了 task_transitions 和 SSE 事件，没有把每次状态变更同步落到 execution_logs。现已统一写入 task.transition 日志。
- [x] 修正失败路径中的任务对象使用，避免调度异常时继续基于旧任务对象进行后续 cleanup 和状态收敛。异常处理已基于当前运行态任务对象收敛。
- [x] 为任务入队和调度增加并发保护，避免多 scheduler tick 下重复认领同一任务。已为 task/agent 增加原子 claim 语义。

### 2. 工程环境插件

- [x] LocalWorktreeEnvironmentPlugin 目前只做了目录创建。现已补齐本地 repo cache、git worktree、依赖准备和清理策略。
- [x] 实现 repo clone/fetch/checkout/worktree。已按 mirror repo cache -> fetch -> worktree add -> checkout branch 落地。
- [x] 实现依赖安装、环境变量注入、产物目录管理。已支持 Node 项目依赖安装、task.metadata.env 注入和 artifacts/ 清单产物。
- [x] 实现 workspace cleanup 策略，包括失败保留、成功清理、artifact 保留。已支持成功清理、失败保留的可配置策略。
- [x] 为环境准备失败定义明确的错误分类和恢复路径。现已区分 retryable / non-retryable 环境错误，并分别收敛到自动回队重试或 blocked。

### 3. 执行器插件

- [x] CodexExecutionPlugin / CursorExecutionPlugin 目前只是最小 CLI 调用包装。现已补齐 provider 级执行包装和结构化返回。
- [x] 按各自 CLI 规范补齐参数组装、工作目录、分支、超时、stdout/stderr 捕获格式。已接入 codex exec/resume 与 cursor agent/create-chat 的工作目录和输出格式约束。
- [x] 实现 session continuation；当前 continueSession() 直接抛错。现已支持 Codex 会话继续与 Cursor chat resume。
- [x] 为执行器返回统一的 sessionId、summary、错误分类、超时分类。已统一为结构化 ExecutionResult。
- [x] 实现命令前治理检查和敏感参数脱敏。已增加 secret 模式阻断与 stdout/stderr/命令元数据脱敏。

### 4. 质量闭环

- [x] DefaultQualityPlugin 当前只依据 exit code 给出简单评测。现已改为脚本链和 diff 风险联合评测。
- [x] 实现 lint / typecheck / unit test / build 检查链。已按仓库内可用脚本自动执行，缺失脚本会显式标记为 skipped。
- [x] 实现 diff 风险评估。已基于 git diff --shortstat 和 git status --short 输出 churn/risk。
- [x] 实现 acceptance criteria 检查。当前以“自动化检查通过后的推断满足”方式落地，后续可再接入更强语义校验。
- [x] 实现可结构化的 checks[] / report / riskLevel 输出。已包含脚本结果、timedOut、diff 汇总和风险级别。
- [x] 将 quality 结果真正驱动 Goal Loop，而不是只按退出码近似判断。当前 Goal Loop 以脚本链、diff 风险和 acceptance 推断共同决定通过/修复。

### 5. Goal Loop 收敛规则

- [x] 当前已有 repair loop 骨架，但停止条件不完整。现已补齐 stop reason 分析与 session-aware repair loop。
- [x] 实现“连续两轮无有效 diff”停止条件。已基于 diff 统计加入 no_effective_diff 终止。
- [x] 实现“同类错误重复”归因与停止条件。已基于失败签名加入 repeated failure 检测。
- [x] 实现“高风险修改”阻断。高风险评测不再自动收敛到 needs_human：写入 execution_logs（goal.stop_reason_continued）后继续 repair，直至迭代上限后以 budget_limited 收尾为 failed；仍可通过 API 手动 needs-human。
- [x] 将 RepairGoal.status 与真实循环状态对齐，而不是只在达到上限时写 budget_limited。现已按 repairing / achieved / needs_human / budget_limited 真实落库。
- [x] 支持从前一次执行结果中生成更具体的 repair objective、constraints、doneWhen。现已从失败 checks、风险和任务约束推导 repair 目标。

### 6. 调度与 Agent 管理

- [x] 当前只有固定 seed agent 和简单 getIdle() 调度。现已补齐 scheduler tick 互斥和 stale agent 恢复。
- [x] 实现 agent heartbeat 刷新。已提供 heartbeat service 和 API。
- [x] 实现 agent offline 判定。已按 heartbeat timeout 标记 offline。
- [x] 实现 running -> queued 的 offline recovery。stale busy agent 的 running task 会自动 re-queue。
- [x] 实现 agent disabled / error 状态与人工摘除。已提供 disable / enable / recover 控制入口。
- [x] 实现调度并发上限、重试策略、超时重排队。现已具备 scheduler tick 互斥、agent 数量驱动的并发上限、环境失败重试，以及执行阶段 timeout / launch_error 的自动回队与超预算阻断。
- [x] 避免多个 executor 共用一套简单轮询逻辑导致的资源争抢。当前同一 scheduler tick 已具备互斥保护，避免重入争抢。

### 7. SQLite 运行时验证

- [x] 用真实 SQLite 运行时完成一次 migration + server bootstrap + API smoke test。现已通过临时 SQLite 数据库完成 smoke test，并验证 /api/health 与 /api/dashboard。
- [x] 验证 npm run migration:run 和 npm run start:dev 在空库场景可直接启动。现已固化为 npm run smoke:sqlite -w apps/server。
- [x] 补齐数据库连接失败、迁移失败的启动错误处理。已增加数据库连接预检、迁移错误包装和启动期显式错误输出。

---

## P1：要达到完整 Titing 方案必须完成

### 8. 任务接入插件

- [x] MeegleTaskIntegrationPlugin 当前只有占位实现。现已具备 polling 文件接入、webhook ingest、结果回写与集成健康暴露能力。
- [x] 实现任务拉取 pullTasks()。已支持从配置的 JSON 文件拉取任务。
- [x] 实现任务回写 reportResult()。已支持将执行结果写回到配置的结果文件。
- [x] 实现字段映射、合法性校验、upsert 策略。已接入 source/externalId upsert 和基础字段校验。
- [x] 实现 polling / webhook 模式选择。现已支持 polling 文件拉取与 /api/integrations/meegle/webhook webhook 接入。
- [x] 实现插件级健康检查和认证异常暴露。现已提供 /api/integrations/meegle/health，显式暴露 mode、shared-secret 配置与 readiness。

### 9. Controller 主循环

- [x] 将 task integration plugins 接入 scheduler 主循环，支持 poll -> validate -> enqueue。当前 scheduler tick 会先执行 integration sync，再进入调度。
- [x] 增加“任务来源”与“手动创建任务”共存策略。当前 manual / meegle 来源已能共存，external task 走 source+externalId upsert。
- [x] 支持任务被 blocked / needs_human 后的人工恢复入口。现已提供 recover API 和服务入口。
- [x] 为 cancelled / blocked / needs_human 增加明确的业务入口和审计记录。现已提供 block / needs-human / recover / cancel 业务入口，并复用 transition + execution log 审计链。

### 9A. 同类型问题的自我沉淀与修复

- [~] 当前 Goal Loop 只支持任务内的 repeated failure 检测，还没有跨任务的同类问题知识沉淀。现状是 buildFailureHash() 基于 errorCategory / timeoutCategory / summary / failedChecks 判断“重复失败”，能停止但还不能复用修复经验。
- [ ] 新增 `failure-class` 稳定枚举/字典文件，覆盖 `build / test / lint / env / governance / diff-risk`，并把现有 `buildFailureHash()` 改成“分类 + 指纹”双层策略。
- [ ] 在 `EvaluationReport` 或独立 `ExecutionResult` 中新增 `failureClass`、`rootCause`、`scope`、`evidence`、`suggestedStrategy` 字段，并补齐 schemaVersion 迁移。
- [ ] 新增 `repair_knowledge`（或同名）表，字段至少包括 `failureClass`、`successStrategy`、`failureStrategy`、`exampleSummary`、`successRate`、`lastMatchedAt`。
- [ ] 实现 `RepairKnowledgeService.lookup(failureClass)`，在每次 repair 前先查历史策略并注入 `repair objective/constraints/doneWhen`。
- [ ] 实现 `RepairKnowledgeService.recordOutcome()`，在 repair 成功、失败、no_effective_diff、高风险时分别更新策略权重。
- [ ] 在 dashboard / ops 视图新增按 `failureClass` 聚合的统计面板：命中率、自动修复率、人工升级率、平均修复轮次、top unsafe strategies。
- [ ] 为失败分类、历史策略检索、repair 结果回写、知识库 schema 迁移补齐测试。

### 10. 观测与治理插件

- [x] DefaultObservabilityGovernancePlugin 当前只有空实现。现已补齐可配置治理策略、结构化治理记录与 health 统计。
- [x] 实现结构化日志汇聚。现已汇聚 before_command / after_command / after_eval 治理记录，并同步写入 execution log 与 SSE 事件。
- [x] 实现 secret scan。现已覆盖命令、stdout/stderr/summary 与 eval report 的 secret 扫描。
- [x] 实现 command whitelist / blacklist。现已支持 allowlist binary 与 block regex policy。
- [x] 实现成本控制与高风险操作阻断。现已支持 prompt/output 大小限制与 diff 风险阈值阻断。
- [x] 实现 token 脱敏和输出清洗。现已统一脱敏常见 token / api key / bearer 输出，并截断超长输出。
- [x] 将治理插件真正接入执行前、执行后、评测后节点。现已贯通 execution plugin 与 eval 落库前钩子。

### 10A. 插件机制收口

- [ ] 在 `packages/plugin-api` 增加 `TaskIntegrationPluginSpec`、`ExecutionPluginSpec`、`EnvironmentPluginSpec`、`QualityPluginSpec`、`ObservabilityPluginSpec`、`LogPluginSpec` 的 kind-specific contract。
- [ ] 在 `apps/server/src/titing/external-plugins.ts` 做 bootstrap 级 contract 校验，缺少必需方法时直接拒绝启动。
- [ ] 统一外置插件装配策略：明确采用“同 kind 多插件并存 + capability/priority 选择”，并删除“整类替换”的模糊描述。
- [ ] 重写 `PluginRuntime` 的选择逻辑测试，覆盖同 kind 多实现、禁用过滤、priority override、capability miss 和 fallback。
- [ ] 重新定义 `PluginConfig.config` 的语义：只做初始化快照还是支持运行时刷新，并在 API/文档/测试中保持一致。
- [ ] 将 `task.source` 改造成稳定的 `sourceIdentity` / `integrationKey`，并同步修改任务回写、needs-human 和 reply sync 的查询条件。
- [ ] 补齐插件生命周期测试矩阵：启动校验失败、健康检查失败、配置更新后生效、日志插件缺失、执行插件缺少 resume/interrupt 等场景。

### 11. 事件与观测面

- [~] 目前只提供基础 SSE 推送。
- [x] 补齐 scheduler.* / executor.* / eval.* / goal.* / plugin.* / agent.* 事件覆盖率。现已覆盖 scheduler sync/dispatch/tick、plugin pull/report/config、agent 生命周期及现有 executor/eval/goal 事件。
- [x] 增加事件 payload 的稳定 schema 和版本约束。现有 SSE 事件统一带 id 与 schemaVersion。
- [x] 提供 execution log 与 SSE event 的关联字段规范。现已统一注入 data.correlation，包含 correlationId / eventId / traceId / taskId / executionId / pluginId / agentId，同一次 log+event 发射共享同一 eventId。
- [x] 增加 trace 视角查询能力，而不仅是 task 维度。现已提供 /api/traces/:traceId，聚合 tasks、transitions、executions、execution logs、eval results、repair goals。

### 12. API 补全

- [x] 增加任务 transition 历史查询接口。现已提供 /api/tasks/:id/transitions。
- [x] 增加 execution log 查询接口文档与稳定 schema 说明。现已提供 /api/tasks/:id/observability，带稳定 schemaVersion 和聚合日志结构。
- [x] 增加 plugin config 查询/更新接口。现已提供 /api/plugin-configs 的查询与更新。
- [x] 增加 agent 管理接口，例如 heartbeat、disable、enable、recover。现已提供 /api/agents/:id/heartbeat|disable|enable|recover。
- [x] 增加手动触发 scheduler / sync 的调试入口。现已提供 /api/debug/sync 与 /api/debug/scheduler。
- [x] 增加更细粒度的 health/readiness API。现已提供结构化 /api/health 与 /api/readiness，并在真库 smoke test 中验证。

### 13. 数据层补全

- [x] 为 task_transitions 增加 repository/query API。现已支持按 task 与 trace 查询。
- [x] 为常用查询增加索引设计，例如 tasks(status, executor)、executions(task_id, started_at)。现已补充 tasks/trace/transitions/executions/execution_logs/eval_results/agents/plugin_configs 的热点索引，并将外部任务唯一约束收敛为 source + external_id。
- [x] 为数据迁移补充旧表到新表的一次性迁移脚本。现已提供 npm run migration:legacy -w apps/server，可识别旧 NestJS/TypeORM tasks / agents / execution_logs 结构，重命名为 legacy_*，跑新 SQL migrations，并回填到新 Titing schema。
- [x] 为 JSON 字段 schema 定义约束和版本策略。现已统一采用 { schemaVersion, data } envelope，新写入按版本封装，读取兼容旧裸数组/裸对象，并通过 migration/default/check constraint 收敛数据库形状。

### 14. 前端控制台补全

- [~] 当前控制台已支持 dashboard/tasks/agents/plugins 概览、任务 master-detail、Execution Recovery 摘要，以及按 category 的事件/日志筛选；但仍缺更完整的运营聚合面板与跨任务观测视图。
- [x] 增加任务详情页。现已在控制台提供任务 master-detail 视图。
- [x] 展示 executions、execution logs、eval results、repair goal。现已接入对应详情接口并展示时间线与修复目标。
- [x] 增加任务筛选、搜索、状态聚合。现已支持状态 pills、全文搜索和任务状态聚合显示，并补了前端交互测试。
- [x] 增加实时事件时间线视图。现已按任务/trace 展示最近 SSE 事件流。
- [x] 增加插件健康与错误明细视图。现已提供插件详情卡，展示 health、enabled/priority、capabilities、readiness 状态与配置明细。
- [x] 增加人工操作入口：validate / queue / retry / cancel。现已在任务详情页提供这些操作按钮。
- [x] 为断线重连、错误态、空态补全交互。现已补齐数据刷新失败重试、SSE 断线重连提示与按钮，以及 tasks/agents/plugins/details 的空态展示。

### 15. 测试体系

- [x] 当前只有基础状态机测试和已有前端测试。现已覆盖 TitingServices 生命周期、scheduler、plugin runtime、PG repository、API、Goal Loop 和前端交互。
- [x] 为 TitingServices 编写任务生命周期测试。现已覆盖 execute/evaluate/repair/offline recovery/governance stop 等主路径。
- [x] 为 scheduler 编写并发与 recovery 测试。现已覆盖并发 tick 下的原子认领、多 agent 场景下的 stale agent offline 扫描，以及 running task 的 recovery/re-queue 语义。
- [x] 为 plugin runtime 编写 capability 选择测试。现已覆盖 init(config)、disabled 过滤、priority override 和 capability miss 场景，并让运行时选择逻辑真正吃 plugin_configs.enabled/priority。
- [x] 为 repositories 编写 SQLite 集成测试。现已通过临时 SQLite 真库覆盖 tasks/trace/transitions/executions/logs/agents/plugin_configs 的 round-trip 和 claim 语义（实现类名仍为 Pg* 历史前缀）。
- [x] 为 API 编写 Fastify handler 测试。现已覆盖 health/readiness、任务创建校验、trace 聚合、debug 入口和错误映射。
- [x] 为 Goal Loop 编写成功、修复成功、预算耗尽三类测试。现已显式覆盖首轮成功、repair 后成功与 budget_limited -> failed（含过程日志）等主路径。

---

## P2：清理与增强

### 16. 旧代码清理

- [x] 物理移除旧 NestJS 栈相关源码，避免仓库长期双轨。现已删除 apps/server/src 顶层旧宿主与 packages/core/src 旧模块，仅保留 Titing 路径实现。
- [x] 归档或删除旧 plugins/* 中不再参与新架构编译的实现。现已物理移除旧 plugins/ 目录及其前端测试引用。
- [x] 清理旧 README、旧 PRD 描述与当前实现不一致的部分。现已重写 README，并将旧 PRD 改为归档说明与当前文档入口。
- [x] 将项目命名从 autodev-agent 全量收敛到 titing。现已完成 root/workspaces/title/lockfile 收口，历史名称仅保留在归档说明中。

### 17. 配置体系

- [x] 将当前零散 env 变量收敛为统一配置模型。现已统一进入 ServerConfig，并保留旧 env 名 fallback 兼容。
- [x] 支持 scheduler / workspace / goalRecovery / plugins / governance 结构化配置。现已完成运行时分组，并让 goal recovery 参数真实驱动服务。
- [x] 增加配置校验与默认值文档。现已补齐 readConfig() 校验测试与 [titing-config.md](./titing-config.md) 默认值文档。

### 18. 文档补全

- [x] 增加 API 文档。现已补充 [titing-api.md](./titing-api.md)，覆盖 health/tasks/agents/plugins/integrations/debug/SSE。
- [x] 增加插件开发指南。现已补充 [titing-plugin-development.md](./titing-plugin-development.md)，说明插件类型、实现约束、注册方式和测试建议。
- [x] 增加数据库 schema 文档。现已补充 [titing-database-schema.md](./titing-database-schema.md)，说明表结构、JSON envelope、索引和 legacy migration。
- [x] 增加本地开发和联调指南。现已补充 [titing-local-dev.md](./titing-local-dev.md)，覆盖启动、手工任务、Meegle 文件型和 webhook 联调。
- [x] 增加生产部署说明。现已补充 [titing-deployment.md](./titing-deployment.md)，说明单机部署、升级、备份与限制。

### 19. 生产级运维能力

- [x] 补充启动日志、指标、告警建议。现已补充到 [titing-ops.md](./titing-ops.md)，包含启动日志清单、建议指标和告警策略。
- [x] 增加失败任务诊断命令或脚本。现已提供 npm run diagnose:task -w apps/server -- --task-id <id>，汇总 task/execution/eval/repair/log 诊断信息。
- [x] 增加数据修复与回滚操作手册。现已补充到 [titing-ops.md](./titing-ops.md)，覆盖 migration、业务恢复、备份回滚。

---

## 当前实现与目标方案的主要差距

以下几项是当前“看起来已经有了”，但实际仍只是骨架：

- [~] 状态机：已存在，但未完全覆盖日志、治理、恢复和人工介入闭环。
- [x] Goal Loop：已存在，但归因、diff 收敛和风险阻断还没有。现已补齐失败归因、no-diff、high-risk 和 session continuation。
- [~] 同类问题自我沉淀：当前只支持单任务内 repeated failure 停止，还没有 failure taxonomy、repair playbook、跨任务经验库和反馈学习闭环。
- [~] 插件体系：已存在，但仍缺 kind-specific 外置校验、多外置装配策略、config 语义收口，以及 source identity 与 readiness 依赖的一致性治理。
- [x] 工程环境：已存在接口和本地插件，但还没有真实 repo/worktree 管理。现已接入真实 git cache/worktree/cleanup。
- [x] 质量闭环：已存在 plugin，但还不是 lint/test/build/risk 的真实闭环。现已补齐脚本检查、diff 风险和结构化评测。
- [~] 控制台：已切到新 API，并补齐任务详情、恢复摘要、实时事件和分类筛选；但还没有更完整的跨任务运营观测面。

---

## 建议执行顺序

1. 先完成 P0 的执行链路正确性、工程环境、执行器、质量闭环和 SQLite 真实联调。
2. 再完成 P1 的任务接入、治理、Goal Loop 的同类问题知识沉淀、事件补全、前端详情页和测试体系。
3. 最后处理 P2 的旧代码清理、配置收敛和生产化文档。

---

## 文档维护约定

- 每完成一个任务，直接在本文档中勾选并补一句结果说明。
- 若任务被拆分，应在原条目下方改写为更细粒度条目，不新增第二份 checklist。
- 若实际实现偏离 [titing-technical-design.md](./titing-technical-design.md)，先更新设计文档，再更新本清单。
