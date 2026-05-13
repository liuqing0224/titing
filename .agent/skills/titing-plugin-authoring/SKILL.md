---
name: titing-plugin-authoring
description: Guides TiTing plugin kinds, mandatory metadata, capability routing rules, forbidden delegations from core to plugins, lifecycle, and cross-cutting constraints. Use when implementing or reviewing task-source/workspace/executor/quality-check/governance/observability/log-store/notification/intelligence/platform plugins in this repo or mapping features to capability domains per docs/architecture/titing-architecture-description.md §5.11–§7.11.
disable-model-invocation: true
---

# TiTing 插件编写与路由

插件是能力域的标准实现载体，不是「按需动态 import 的脚本集合」。完整背景见 [titing-architecture-description.md](../../../docs/architecture/titing-architecture-description.md)。

## 插件三大类

| 类型 | 作用 | 硬约束 |
| --- | --- | --- |
| 核心能力插件 | 接入、准备、执行、评测、治理等主链路 | 与主链路语义严格对齐 |
| 横切能力插件 | 日志、观测、通知、审计 | 以只写事件或只读查询为主；不得承载业务状态机 |
| 增强能力插件 | 分析、协作辅助、策略建议 | **仅建议/辅助**，无最终裁决权 |

平台类能力映射到 `platform` 域：`listCapabilities`、`negotiateVersion`、`resolveDependencies` 等协调能力，不参与业务裁决。

## 核心不得下放给插件的能力（必须留在核心）

以下决策只能由核心产生，插件不可自行改写或绕开持久化语义：

- 任务状态机合法性与迁移  
- 是否允许调度、任务是否完结  
- 是否进入人工介入、修复预算与停止条件  
- 最终权威状态写入、审计与事件发布  

插件可**建议**下一步动作，但不得单方面变更任务最终结果或越过核心改写聚合存储。

## 每个插件必须显式声明

仅声明过的能力可被核心路由与调用：

- `kind` — 所属能力域  
- `id` — 全局唯一身份  
- `version` — 协议版本  
- `capabilities` — 能力清单（细粒度钩子）  
- `dependencies` — 依赖的其他插件或宿主能力  
- `health` — 健康检查输出  
- `configSchema` — 可配置项结构（供校验/UI）  

## 标准 `kind` 与矩阵（能力与约束）

能力与接口名可随协议演进，**语义保持稳定**。同名多实现由能力路由 + 策略选择。

| kind | 标准接口示例 | 核心约束 |
| --- | --- | --- |
| `task-source` | `pullTasks`, `pullHumanReplies`, `reportResult`, `ackTask` | 输入与结果回写，**不决定任务领域状态** |
| `workspace` | `prepareWorkspace`, `cleanupWorkspace`, `snapshotWorkspace`, `restoreWorkspace` | **仅环境准备**，不写领域状态 |
| `executor` | `execute`, `resume`, `interrupt`, `inspectSession` | **只执行**，不直接写最终任务状态 |
| `quality-check` | `runChecks`, `scoreRisk`, `produceReport`, `explainFailure` | **只评估**，不替代完成/失败等决策 |
| `governance` | `validateCommand`, `scanSecrets`, `enforceDiffLimit`, `approveRisk` | **可阻断执行**，但不得篡改领域业务状态 |
| `log-store` | `appendLog`, `queryLogs`, `subscribeLogs`, `archiveLogs` | 日志专用，不承担状态机 |
| `observability` | `publishEvent`, `queryTimeline`, `buildTraceView`, `computeHealthSnapshot` | **偏只读**，不做领域写入 |
| `notification` | `notify`, `notifyHumanReview`, `notifyStatusChange`, `routeNotification` | **失败不中断主流程**；触发基于事件 |
| `intelligence` | `summarizeFailure`, `suggestRepair`, `classifyRisk`, `rankTasks` | **仅输出建议** |

## 能力暴露规则

- 核心按 **能力** 路由，不按包名/文件路径路由。  
- 能力必须可被声明、校验、查询与禁用；禁止未声明能力的「后门」入口。  
- 同一 `kind` 可多实例并存；由优先级/策略仲裁。  
- 能力组合规则须显式定义，不可隐式魔法串联。  

## 插件生命周期（实现与运维对齐）

发现 → 解析元数据 → 校验协议版本 → 初始化 → 健康检查 → 注册能力 → 运行时调用 → 停机卸载。  
不推荐「按 kind 整类仅此一份」耦合；应以注册表 + **CapabilityRouter / PluginPolicyEngine** 选型。

横切优先级方向（规划/评审用）：核心主链路闭环 → 横切观测/审计/治理 → 增强解释与协作效率 → 平台多环境规模化。

## 与架构 skills 的配合

分层与聚合详见 [titing-architecture](../titing-architecture/SKILL.md)；MUST/MUST NOT 门禁与评审清单见 [titing-architecture-standards](../titing-architecture-standards/SKILL.md)。
