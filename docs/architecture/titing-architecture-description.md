# Titing Architecture Description

更新日期：2026-05-13

## 1. 文档目标

本文档不是对当前代码的复述，而是给出一份更合理、更可演进的 Titing 目标架构设计说明。重点是定义每一个核心模块的职责、边界、内部设计、对外接口和协作方式。

本文档默认面向以下读者：

- 架构设计者
- 核心后端开发
- 插件开发者
- 前端控制台开发者
- 后续接手项目的新成员

本文档的原则是：

- 优先设计长期合理的系统边界
- 不受当前文件结构和历史实现束缚
- 允许当前实现与目标态存在差距
- 每个模块都给出清晰职责，而不是泛泛描述

## 2. 系统定位

Titing 是一个 AI 工程执行控制平台，用于统一管理任务接入、调度分发、工作区准备、执行器调用、质量评估、自动修复、人工接管和观测治理。

它不是一个单纯的任务系统，也不是一个单纯的 AI Agent。它更准确的定位是：

- 一个面向工程任务的执行控制器
- 一个连接任务来源与执行工具的控制平面
- 一个支持自动修复与人工闭环的工作流编排系统

系统目标是把“让 AI 真正稳定地完成工程任务”这件事拆成多个可治理、可观测、可扩展的模块。

## 3. 设计原则

### 3.1 核心原则

- 核心领域稳定：任务状态机、调度模型、修复循环必须稳定收敛在核心域
- 变化点外置：执行器、环境、任务来源、质量策略、治理策略都应通过插件扩展
- 读写分离：命令操作和查询聚合要分开设计
- 编排与规则分离：流程编排不等于领域规则，状态规则和策略规则应单独建模
- 事件优先：重要状态变化和系统行为都必须产出结构化事件
- 可恢复优先：任何长流程都必须考虑失败恢复和幂等
- 宿主轻量：HTTP 框架、数据库、日志系统只是承载者，不应污染核心语义

### 3.2 架构风格

推荐采用“模块化单体 + Ports and Adapters + 领域服务编排”的结构：

- 模块化单体：单仓库、单宿主、单进程起步，但内部强制模块边界
- Ports and Adapters：核心只依赖接口，不依赖具体数据库或框架
- 领域服务编排：复杂主链路由应用服务编排，但领域规则仍归领域层控制

### 3.3 非目标

本设计不优先解决：

- 分布式多活
- 强多租户隔离
- PB 级日志分析
- 组织级权限平台
- 跨区域高可用

这些不是不支持，而是不作为第一阶段架构中心。

## 4. 总体架构分层

目标架构建议分为六层：

### 4.1 Presentation Layer

职责：

- 提供 Web 控制台
- 提供对外 HTTP API
- 提供 SSE / WebSocket 实时事件订阅
- 提供 Webhook 接入口

关注点：

- 输入校验
- DTO 转换
- 鉴权和访问控制
- 响应封装

不负责：

- 任务状态流转判断
- 调度决策
- 插件业务逻辑

### 4.2 Application Layer

职责：

- 实现用例
- 编排跨模块流程
- 组织事务边界
- 发布领域事件和集成事件
- 驱动调度、执行、修复、恢复等流程

关注点：

- 用例顺序
- 幂等控制
- 重试策略
- 错误归一化

### 4.3 Domain Layer

职责：

- 定义领域实体和值对象
- 定义状态机与领域约束
- 定义领域策略接口
- 定义聚合边界

关注点：

- 业务语义正确性
- 不变量保护
- 状态转换合法性

### 4.4 Domain Service / Policy Layer

职责：

- 封装无法归属单一实体的规则
- 承载调度策略、修复策略、路由策略、风险判定策略

这一层与 Application Layer 不同：

- Application 关心“怎么组织流程”
- Policy 关心“业务上应该怎么判断”

### 4.5 Infrastructure Layer

职责：

- 数据库实现
- 日志系统实现
- 消息与事件总线实现
- 插件加载器实现
- Git / CLI / 文件系统 / 进程调用实现

### 4.6 Extension Layer

职责：

- 暴露可替换能力实现
- 提供能力发现、声明与匹配
- 承载外部系统接入与工具执行
- 为核心提供可治理的扩展点

这一层是系统最外部的变化承载层。

## 5. 核心模块清单

目标态建议拆成以下核心模块：

### 5.1 Identity & Access Module

职责：

- 用户身份识别
- API Token / Session 管理
- 角色与权限控制
- 操作审计

说明：

即使当前是本地优先系统，也建议单独定义该模块，避免未来所有接口都默认无鉴权。

### 5.2 Task Intake Module

职责：

- 接收人工任务
- 接收外部系统同步任务
- 任务标准化
- 去重、幂等和来源绑定

### 5.3 Task Lifecycle Module

职责：

- 管理任务状态机
- 管理任务基本信息修改规则
- 维护任务与执行、修复、人工接管之间的关联

### 5.4 Scheduler Module

职责：

- 周期性扫描待处理任务
- 计算调度顺序
- 分配任务给可用执行槽
- 处理资源竞争、超时、过载与恢复

### 5.5 Agent Capacity Module

职责：

- 管理执行槽位和执行能力
- 维护心跳、租约、占用状态和恢复逻辑
- 支持能力路由和并发控制

### 5.6 Workspace Module

职责：

- 管理仓库缓存
- 创建工作区
- 注入任务上下文和运行时配置
- 清理临时资源

### 5.7 Execution Orchestration Module

职责：

- 选择执行器
- 构造执行请求
- 驱动多阶段执行流程
- 收集执行结果、摘要和原始输出

### 5.8 Quality Evaluation Module

职责：

- 运行质量检查链
- 生成评测报告
- 输出结构化风险结论

### 5.9 Repair Loop Module

职责：

- 决定是否进入修复
- 生成修复目标
- 记录修复轮次
- 决定何时停止自动修复

### 5.10 Human Intervention Module

职责：

- 生成人工接管请求
- 记录补充说明、审批、反馈
- 恢复任务继续执行

### 5.11 Plugin Management Module

职责：

- 插件注册
- 插件发现与加载
- 插件健康检查
- 插件配置管理
- 插件版本兼容校验
- 插件能力声明管理

### 5.11.1 插件应暴露的能力范围

插件不是按名字堆砌的脚本集合，而是按能力域提供标准能力的可插拔实现。系统中的插件应围绕核心逻辑分成三类：

- 核心能力插件：直接参与任务主流程，负责接入、准备、执行、评测和治理
- 横切能力插件：为主流程提供日志、观测、通知和审计
- 增强能力插件：提供智能分析、协作辅助、策略建议，但不拥有最终裁决权

核心能力插件必须与主链路严格对齐，横切能力插件必须保持只写事件或只读查询，增强能力插件只能输出建议或辅助信息。

### 5.11.2 核心不应下放给插件的能力

以下能力应始终由核心控制，不应交给插件自行决定：

- 任务状态机合法性
- 调度是否允许
- 任务是否完成
- 是否允许进入人工介入
- 修复预算和停止条件
- 最终状态写入
- 审计与事件发布

### 5.11.3 插件暴露能力的标准形式

每个插件都应显式声明：

- `kind`：插件所属能力域
- `id`：唯一身份
- `version`：协议版本
- `capabilities`：能力清单
- `dependencies`：依赖的其它插件或宿主能力
- `health`：健康检查结果
- `configSchema`：可配置项结构

只有通过这些声明的能力才允许被核心路由与调用。

### 5.11.4 未来可拓展的能力列表

以下能力应被视为未来可扩展能力池，系统可以逐步开放，但默认不要求当前版本全部具备：

#### 核心能力域

- 任务接入
- 工作区
- 执行器
- 质量评测
- 治理与安全

#### 横切能力域

- 日志
- 观测
- 通知
- 审计

#### 增强能力域

- 智能分析
- 协作辅助
- 策略建议
- 报告生成

#### 平台能力域

- 多环境
- 多仓库
- 多执行器
- 多租户
- 配置中心

#### 能力演进方向

- 每个能力域都应优先定义标准接口，而不是优先定义具体实现
- 能力域可以不断拆细，但不能打破核心/横切/增强/平台四层关系
- 新插件只有在能映射到已有能力域时才允许接入
- 如果新增能力域，必须先补核心契约，再补插件实现

### 5.11.5 插件能力矩阵

| 能力域 | 对应插件类型 | 标准接口示例 | 核心约束 |
| --- | --- | --- | --- |
| 任务接入 | `task-source` | `pullTasks`, `pullHumanReplies`, `reportResult`, `ackTask` | 输入任务和回写结果，不决定任务状态 |
| 工作区 | `workspace` | `prepareWorkspace`, `cleanupWorkspace`, `snapshotWorkspace`, `restoreWorkspace` | 只负责环境准备，不写领域状态 |
| 执行器 | `executor` | `execute`, `resume`, `interrupt`, `inspectSession` | 只负责执行，不直接写最终状态 |
| 质量评测 | `quality-check` | `runChecks`, `scoreRisk`, `produceReport`, `explainFailure` | 只提供评估，不替代任务决策 |
| 治理与安全 | `governance` | `validateCommand`, `scanSecrets`, `enforceDiffLimit`, `approveRisk` | 可以阻断执行，但不能篡改业务状态 |
| 日志 | `log-store` | `appendLog`, `queryLogs`, `subscribeLogs`, `archiveLogs` | 只负责日志，不承载业务状态机 |
| 观测 | `observability` | `publishEvent`, `queryTimeline`, `buildTraceView`, `computeHealthSnapshot` | 只读为主，不做领域写入 |
| 通知 | `notification` | `notify`, `notifyHumanReview`, `notifyStatusChange`, `routeNotification` | 通知失败不能中断主流程 |
| 智能增强 | `intelligence` | `summarizeFailure`, `suggestRepair`, `classifyRisk`, `rankTasks` | 只提供建议，不拥有最终裁决权 |
| 平台协同 | `platform` | `listCapabilities`, `negotiateVersion`, `resolveDependencies` | 只能做能力协调，不参与业务决策 |

说明：

- 同一能力域可以有多个插件实现
- 核心通过能力声明和策略选择具体实现
- 具体接口名可以随协议版本演进，但语义必须保持稳定
- 插件能力不得绕过核心状态机直接修改任务聚合
- 插件可以建议下一步动作，但不能单方面改变任务最终结果
- 插件能力需要随版本演进，但必须保持向后兼容或显式迁移

### 5.12 Observability Module

职责：

- 事件采集
- Trace 聚合
- 指标统计
- 日志查询
- 调试视图

### 5.13 Governance & Risk Module

职责：

- 命令策略校验
- 输出限制
- 敏感信息扫描
- 风险等级提升
- 执行阻断与人工升级

### 5.14 Notification Module

职责：

- 任务状态通知
- 人工接管通知
- 执行完成通知
- 插件健康告警

### 5.15 Console BFF Module

职责：

- 为前端控制台提供聚合查询
- 屏蔽核心模型复杂性
- 提供前端友好的只读视图

这个模块建议存在于服务端，但逻辑上独立于核心命令模块。

## 6. 领域模型详细设计

### 6.1 Task 聚合

Task 是系统的核心聚合根。

核心字段建议：

- `taskId`
- `sourceType`
- `sourceRef`
- `title`
- `instruction`
- `targetRepo`
- `targetRevision`
- `plannedBranch`
- `executorProfile`
- `priority`
- `status`
- `currentExecutionId`
- `currentRepairPlanId`
- `traceId`
- `createdAt`
- `updatedAt`

Task 聚合负责保证：

- 状态只能按状态机流转
- 关键字段变更符合当前状态约束
- 执行与修复引用保持一致
- 关闭态任务不能被随意修改

Task 不应该直接承载：

- 大量原始日志
- 执行 stdout/stderr
- 大块评测报告

这些内容应放在独立对象中。

### 6.2 Execution 聚合

Execution 表示一次具体运行尝试。

核心字段建议：

- `executionId`
- `taskId`
- `attemptNo`
- `agentLeaseId`
- `workspaceId`
- `executorProfile`
- `status`
- `startedAt`
- `endedAt`
- `stopReason`
- `summary`
- `outputRefs`

Execution 负责：

- 描述一次运行实例
- 保存运行结果的主索引
- 与日志、评测、修复原因建立关联

### 6.3 RepairPlan 聚合

RepairPlan 用于表达一次或一组修复目标。

核心字段建议：

- `repairPlanId`
- `taskId`
- `basedOnExecutionId`
- `iteration`
- `objective`
- `constraints`
- `acceptanceSignals`
- `status`
- `stopSignal`

RepairPlan 的作用不是“记失败次数”，而是把修复活动显式建模，便于解释系统为什么继续修、为什么停止修。

### 6.4 HumanReview 聚合

HumanReview 表示一次人工介入会话。

核心字段建议：

- `reviewId`
- `taskId`
- `reason`
- `requestType`
- `status`
- `requestedAt`
- `resolvedAt`
- `responseSummary`
- `externalThreadRef`

这个聚合负责：

- 记录为什么需要人工
- 记录人工反馈是否已被处理
- 记录任务恢复所基于的人工意见

### 6.5 AgentLease 聚合

建议不要只建模 Agent，而是建模 `Agent` 与 `AgentLease`：

`Agent`

- 代表长期存在的执行资源
- 包含能力、状态、标签、最大并发等信息

`AgentLease`

- 代表某次任务对资源的临时占用
- 包含租约开始时间、超时、续租时间、释放原因

这种设计比直接在 Agent 上挂 `taskId` 更稳健，更适合故障恢复和并发控制。

## 7. 模块详细设计

## 7.1 Identity & Access Module

### 7.1.1 模块目标

保证所有管理操作、调度操作和敏感数据访问都有明确身份来源和权限边界。

### 7.1.2 子模块

- `AuthService`
- `TokenService`
- `PermissionService`
- `AuditService`

### 7.1.3 核心接口

- `authenticate(credentials): Principal`
- `authorize(principal, action, resource): Decision`
- `recordAudit(event): void`

### 7.1.4 设计要求

- 所有命令操作必须带 `operator`
- 系统自动触发操作使用系统身份 `system:<module>`
- 审计记录不可与业务日志混淆

## 7.2 Task Intake Module

### 7.2.1 模块目标

把不同来源的任务转为统一 Task 模型，并完成去重、归一化和初始建档。

### 7.2.2 子模块

- `ManualTaskIntakeService`
- `ExternalTaskIntakeService`
- `TaskNormalizer`
- `TaskDedupPolicy`

### 7.2.3 输入输出

输入：

- 人工创建请求
- 外部平台任务载荷

输出：

- 新任务
- 任务更新
- 幂等忽略结果

### 7.2.4 设计要求

- 来源字段必须结构化，不允许只用单个字符串混用语义
- 应拆分：
  - `sourceType`
  - `sourceSystem`
  - `sourceEntityId`
  - `sourceSyncKey`
- 幂等键必须单独建模，不能依赖标题或说明文本

## 7.3 Task Lifecycle Module

### 7.3.1 模块目标

作为任务状态和关键业务动作的唯一写入口。

### 7.3.2 状态设计

建议状态分层，而不是简单平铺：

- `draft`
- `ready`
- `scheduled`
- `executing`
- `evaluating`
- `repairing`
- `waiting_human`
- `completed`
- `failed`
- `cancelled`

其中可增加子状态或阶段原因字段，而不是无限增加顶层状态。

### 7.3.3 子模块

- `TaskCommandService`
- `TaskStateMachine`
- `TaskMutationPolicy`

### 7.3.4 关键命令

- `createTask`
- `updateTaskSpec`
- `submitTask`
- `scheduleTask`
- `startExecution`
- `enterEvaluation`
- `enterRepair`
- `requestHumanReview`
- `completeTask`
- `failTask`
- `cancelTask`
- `resumeTask`

### 7.3.5 设计要求

- 所有状态迁移都必须显式记录 reason
- 所有状态迁移都必须生成事件
- 状态机规则和 API 路由不能耦合

## 7.4 Scheduler Module

### 7.4.1 模块目标

从待调度任务集合中选择最适合的任务，并分配给满足能力约束的资源。

### 7.4.2 子模块

- `SchedulerTickService`
- `DispatchPlanner`
- `TaskPriorityPolicy`
- `CapacityMatcher`
- `LeaseAllocator`
- `RecoveryScanner`

### 7.4.3 调度流程

1. 拉取可调度任务
2. 过滤不可执行任务
3. 按优先级、等待时长、来源策略排序
4. 选择满足能力约束的 Agent
5. 创建租约
6. 将任务推进到 `scheduled` / `executing`

### 7.4.4 设计要求

- 调度决策要可解释
- 同一次 tick 内的分配结果要可重放
- 必须支持过载保护
- 必须支持租约超时回收

### 7.4.5 不建议的设计

- 不建议把调度逻辑散落在通用服务类里
- 不建议直接用“找到第一个 idle agent 就执行”的策略代替调度器

## 7.5 Agent Capacity Module

### 7.5.1 模块目标

管理执行资源，而不是只管理“在线状态”。

### 7.5.2 Agent 模型建议

字段建议：

- `agentId`
- `agentType`
- `capabilities`
- `supportedExecutors`
- `status`
- `maxConcurrentExecutions`
- `lastHeartbeatAt`
- `healthStatus`

### 7.5.3 AgentLease 模型建议

- `leaseId`
- `agentId`
- `taskId`
- `executionId`
- `leasedAt`
- `leaseExpiresAt`
- `renewedAt`
- `releasedAt`
- `releaseReason`

### 7.5.4 设计要求

- 调度占用必须通过租约
- 心跳更新的是资源健康，不直接等于业务成功
- agent 掉线后要有明确恢复策略

## 7.6 Workspace Module

### 7.6.1 模块目标

为任务执行提供隔离、可重建、可清理的工程环境。

### 7.6.2 子模块

- `RepoCacheService`
- `WorkspaceProvisioner`
- `WorkspaceContextBuilder`
- `WorkspaceCleaner`

### 7.6.3 关键能力

- 仓库镜像缓存
- 指定 revision 检出
- 独立工作区创建
- 环境变量注入
- 临时文件与提示词写入
- 执行后产物收集与清理

### 7.6.4 设计要求

- 工作区创建必须幂等
- 工作区必须与任务和执行显式绑定
- 清理策略必须可配置且可追踪
- 不允许执行器直接随意写宿主根目录

## 7.7 Execution Orchestration Module

### 7.7.1 模块目标

统一驱动执行流程，而不是把任务直接交给某个 CLI 然后等待结果。

### 7.7.2 子模块

- `ExecutionCommandService`
- `ExecutorRouter`
- `ExecutionPlanBuilder`
- `ExecutionRunner`
- `ExecutionResultAssembler`

### 7.7.3 核心流程

1. 根据任务选择执行器 profile
2. 构建执行计划
3. 注入工作区与上下文
4. 调用治理模块进行前置校验
5. 调用执行器插件运行
6. 采集 stdout/stderr/summary/artifacts
7. 调用治理模块做后置检查
8. 生成标准化执行结果

### 7.7.4 设计要求

- 执行器只负责执行，不直接修改任务状态
- 执行器输出必须转换成标准结果模型
- 执行阶段必须支持取消、超时和中断

## 7.8 Quality Evaluation Module

### 7.8.1 模块目标

把“代码是否可接受”从执行器内部剥离出来，独立形成评估链。

### 7.8.2 子模块

- `QualityPipelineService`
- `CheckRunner`
- `RiskScorer`
- `AcceptanceEvaluator`

### 7.8.3 输出模型

建议输出统一 `EvaluationReport`：

- `reportId`
- `taskId`
- `executionId`
- `checks`
- `riskLevel`
- `score`
- `acceptanceStatus`
- `summary`
- `rawArtifacts`

### 7.8.4 设计要求

- 每个检查项必须独立记录
- 风险评分和通过/失败判断应拆开
- 评测规则可配置但不能任意污染核心状态逻辑

## 7.9 Repair Loop Module

### 7.9.1 模块目标

让系统具备“自动继续推进目标”的能力，但避免无限修复。

### 7.9.2 子模块

- `RepairDecisionService`
- `RepairGoalBuilder`
- `RepairBudgetPolicy`
- `StopSignalPolicy`

### 7.9.3 关键输入

- 执行结果
- 评测报告
- 历史失败记录
- 当前修复轮次
- 人工约束

### 7.9.4 关键输出

- 进入下一轮修复
- 请求人工介入
- 直接失败
- 降级完成

### 7.9.5 停止信号建议

- `risk_too_high`
- `no_effective_change`
- `same_failure_repeated`
- `repair_budget_exhausted`
- `blocked_by_missing_input`

### 7.9.6 设计要求

- 停止原因必须显式可见
- 修复预算必须独立建模
- 修复计划必须能被人工理解

## 7.10 Human Intervention Module

### 7.10.1 模块目标

把人工接管从“异常分支”提升为正式流程。

### 7.10.2 子模块

- `HumanReviewRequestService`
- `HumanResponseIngestService`
- `HumanResolutionPolicy`

### 7.10.3 请求类型建议

- `need_requirement_clarification`
- `need_risk_approval`
- `need_dependency_fix`
- `need_manual_merge_decision`

### 7.10.4 设计要求

- 人工请求必须明确所需动作
- 人工回复必须结构化保存
- 恢复执行时必须记录“基于哪条人工反馈恢复”

## 7.11 Plugin Management Module

### 7.11.1 模块目标

让插件成为围绕核心能力域运转的正式扩展生态，而不是几个动态 import 的散点实现。

### 7.11.2 插件种类建议

- `task-source`
- `workspace`
- `executor`
- `quality-check`
- `governance`
- `observability`
- `log-store`
- `notification`
- `intelligence`
- `platform`

### 7.11.3 子模块

- `PluginRegistry`
- `PluginLoader`
- `PluginValidator`
- `PluginHealthService`
- `PluginConfigService`
- `PluginCompatibilityService`
- `CapabilityRouter`
- `PluginPolicyEngine`
- `PluginLifecycleManager`

### 7.11.4 插件生命周期

1. 发现插件
2. 解析元数据
3. 校验协议版本
4. 初始化
5. 健康检查
6. 注册能力
7. 运行时调用
8. 停机卸载

### 7.11.5 设计要求

- 不建议“按 kind 整类替换”
- 应支持同类多插件并存
- 选择逻辑应由能力路由和策略层决定
- 插件必须声明协议版本和能力清单
- 核心插件优先保证主链路闭环
- 横切插件优先保证观测、审计与治理
- 增强插件优先保证解释、建议与协作效率
- 平台插件优先保证多环境、多执行器和规模化扩展
- 能力选择必须通过路由和策略层，而不是直接绑定具体实现

### 7.11.6 能力暴露规则

插件通过能力而不是通过“代码路径”暴露价值。能力暴露规则应满足：

- 核心按能力路由，而不是按具体包名路由
- 能力必须可以被声明、校验、查询和禁用
- 同一 kind 下可以有多个插件实现，但必须通过能力与优先级仲裁
- 某些能力可以组合，但组合规则必须显式定义
- 插件不允许向核心暴露未声明能力
- 插件不能直接越过核心服务改写任务、执行、修复和审计结果

### 7.11.7 能力暴露示例

- `task-source` 插件暴露 `pullTasks`、`pullHumanReplies`、`reportResult`
- `workspace` 插件暴露 `prepareWorkspace`、`cleanupWorkspace`
- `executor` 插件暴露 `execute`、`resume`、`interrupt`
- `quality-check` 插件暴露 `runChecks`、`scoreRisk`、`produceReport`
- `governance` 插件暴露 `validateCommand`、`scanSecrets`、`enforceDiffLimit`
- `log-store` 插件暴露 `appendLog`、`queryLogs`、`subscribeLogs`
- `notification` 插件暴露 `notify`、`notifyHumanReview`

## 7.12 Observability Module

### 7.12.1 模块目标

让系统中每一次状态变化、调度行为和执行链路都可查询、可追踪、可解释。

### 7.12.2 子模块

- `DomainEventStore`
- `TraceService`
- `MetricsService`
- `LogIndexService`
- `OpsQueryService`

### 7.12.3 三类观测数据

- 事件：结构化业务动作
- 日志：原始输出与调试信息
- 指标：聚合统计与趋势

### 7.12.4 设计要求

- traceId 必须贯穿任务、执行、修复、人工介入
- 日志与事件必须分开建模
- 运营查询不能直接扫描原始执行输出文件

## 7.13 Governance & Risk Module

### 7.13.1 模块目标

在执行前、执行中、执行后对高风险行为进行限制、检测和升级。

### 7.13.2 子模块

- `CommandPolicyService`
- `SecretScanService`
- `OutputGuardService`
- `RiskEscalationService`

### 7.13.3 控制点

- 执行前：校验命令和输入
- 执行中：限制输出规模和资源使用
- 执行后：扫描 diff、秘密和高风险变更

### 7.13.4 设计要求

- 治理结论必须结构化
- 治理模块可以阻断执行，但不能直接篡改领域状态
- 风险升级必须通过应用层命令显式驱动

## 7.14 Notification Module

### 7.14.1 模块目标

把系统中的关键事件发给正确的人或系统。

### 7.14.2 子模块

- `NotificationRouter`
- `TemplateRenderer`
- `ChannelAdapter`

### 7.14.3 通知通道建议

- Web UI inbox
- Email
- Chat webhook
- 外部任务系统评论回写

### 7.14.4 设计要求

- 通知触发基于事件
- 通知失败不能阻断主链路
- 通知必须幂等去重

## 7.15 Console BFF Module

### 7.15.1 模块目标

为前端提供聚合查询，而不是让前端自己拼接复杂领域数据。

### 7.15.2 子模块

- `DashboardQueryService`
- `TaskDetailViewService`
- `TimelineViewService`
- `PluginOpsViewService`

### 7.15.3 设计要求

- 只读
- 可缓存
- 面向视图建模
- 与命令模型分离

## 8. 模块之间的协作关系

### 8.1 创建任务

`Presentation -> Task Intake -> Task Lifecycle -> Event Store -> Notification`

### 8.2 调度执行

`Scheduler -> Agent Capacity -> Workspace -> Execution Orchestration -> Quality Evaluation -> Repair Loop -> Task Lifecycle`

### 8.3 人工接管

`Repair Loop -> Human Intervention -> Notification -> External System/Human -> Human Intervention -> Task Lifecycle -> Scheduler`

### 8.4 插件调用

`Application Service -> Capability Router -> Plugin Policy Engine -> Capability Plugin -> Observability`

## 9. 数据存储设计建议

### 9.1 存储类型划分

建议至少区分三类存储：

- 事务存储：任务、执行、租约、修复计划、人工审查
- 事件存储：领域事件与操作审计
- 对象/文件存储：原始日志、执行产物、评测附件

### 9.2 为什么不能只靠一个 tasks 表

因为系统不是简单工单系统，而是流程系统。任务、执行、修复、人工介入、资源租约是不同语义对象，混在一个大表里会导致：

- 状态不清晰
- 并发控制困难
- 可观测性差
- 演进成本高

### 9.3 数据一致性原则

- 同一聚合内尽量本地事务一致
- 跨聚合通过事件驱动最终一致
- 长流程恢复依赖幂等命令和事件回放

## 10. API 设计建议

### 10.1 命令与查询分离

命令接口示例：

- `POST /tasks`
- `POST /tasks/{id}/submit`
- `POST /tasks/{id}/cancel`
- `POST /tasks/{id}/resume`
- `POST /ops/scheduler/tick`

查询接口示例：

- `GET /tasks`
- `GET /tasks/{id}`
- `GET /tasks/{id}/timeline`
- `GET /tasks/{id}/executions`
- `GET /dashboard`

### 10.2 不建议的 API 设计

- 不建议把状态名直接映射成过多零散动作
- 不建议让前端自己推导状态机
- 不建议返回未加工的内部存储模型

## 11. 前端模块设计建议

### 11.1 页面层

- Dashboard
- Tasks
- Task Detail
- Plugin Ops
- Event Explorer
- Human Review Queue

### 11.2 前端数据层

- `taskQueries`
- `dashboardQueries`
- `pluginQueries`
- `opsQueries`
- `eventStreamClient`

### 11.3 前端状态原则

- 服务端负责业务聚合
- 前端负责视图交互
- 不让前端持有复杂业务规则

## 12. 推荐目录结构

下面是目标态推荐结构，不要求一步到位，但建议按这个方向演进：

```text
apps/
  api/
    src/
      presentation/
      bff/
      bootstrap/
  console/
    src/
      pages/
      features/
      shared/
modules/
  identity-access/
  task-intake/
  task-lifecycle/
  scheduler/
  agent-capacity/
  workspace/
  execution-orchestration/
  quality-evaluation/
  repair-loop/
  human-intervention/
  plugin-management/
  observability/
  governance-risk/
  notification/
shared/
  kernel/
  contracts/
  infrastructure/
plugins/
  builtins/
  external/
docs/
  architecture/
```

## 13. 最关键的架构约束

以下约束建议作为长期硬约束：

- 核心领域层不得依赖具体 Web 框架和数据库驱动
- 所有状态迁移必须通过显式命令完成
- 所有关键动作都必须留下结构化事件
- 插件不得直接改写核心存储
- 调度与执行必须通过租约或等价机制控制并发
- 人工接管必须建模为正式流程，而不是异常补丁
- 前端不得承载状态机和修复决策规则

## 14. 迁移建议

如果从现有实现往目标态演进，建议顺序如下：

1. 先拆命令与查询
2. 再拆调度、执行、修复三个核心编排模块
3. 引入 `AgentLease` 和 `RepairPlan`
4. 重构任务来源字段为结构化来源模型
5. 重构插件机制为注册中心 + 能力路由
6. 最后再拆前端控制台和 BFF

这个顺序的原因是：先稳住核心业务边界，再拆外围展示和接入层，风险最低。

## 15. 总结

最合理的 Titing 架构，不是把所有逻辑都塞进一个核心服务类，也不是把插件当成若干动态脚本，而是：

- 用 Task、Execution、RepairPlan、HumanReview、AgentLease 等核心对象表达真实业务语义
- 用 Intake、Lifecycle、Scheduler、Execution、Evaluation、Repair、Human Intervention 等模块分担清晰职责
- 用 Plugin Management 承载所有变化点
- 用 Observability、Governance、Notification 形成系统级横切能力

这样的设计能同时满足三个目标：

- 当前阶段可落地
- 中期阶段可扩展
- 长期阶段可维护
