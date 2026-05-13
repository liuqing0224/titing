---
name: titing-architecture-standards
description: Enforces TiTing target-architecture norms and review gates (layering dependency rules, CQRS, events/traceId, leases, intake idempotency, scheduler/governance/plugin boundaries). Use for design reviews, PR review, refactoring guardrails, or when judging whether changes comply with docs/architecture/titing-architecture-description.md.
disable-model-invocation: true
---

# TiTing 架构规范（评审门禁）

规范性要求以架构文档为准：[titing-architecture-description.md](../../../docs/architecture/titing-architecture-description.md)。结构与模块背景见 [titing-architecture](../titing-architecture/SKILL.md)；插件专项见 [titing-plugin-authoring](../titing-plugin-authoring/SKILL.md)。

以下为 **MUST（必须满足）** / **MUST NOT（禁止）** 级陈述；不满足 MUST 且无明确豁免说明的改动，建议在合并前降级或重做。

## 1. 设计原则（对齐 §3）

- **核心域稳定**：任务状态机、调度模型、修复循环的裁决规则须在核心域收口，不得散落在 Presentation 或未归属的「万能 Service」。
- **变化点外置**：执行器、环境准备、来源接入、评测链、治理策略等通过端口/插件扩展，而不是在核心深处硬编码实现分支大爆炸。
- **读写分离**：对外命令路径与聚合查询路径分开设计与暴露；不因图省事在同一 handler 混杂写模型与视图拼装（BFF 只读聚合除外）。
- **编排 vs 规则**：Application 编排步骤与顺序；Policy/Domain Service 承载「业务上该不该」的判断，避免把编排代码写成隐含状态机脚本。
- **事件优先**：重要状态变化必须产出可追溯的结构化事件；审计与领域事件语义分离。
- **可恢复与幂等**：长流程的步骤与外部副作用须可幂等或具备稳定幂等键；失败恢复路径可解释。
- **宿主轻量**：HTTP/DI/日志框架不污染核心业务语义——领域对象与用例不因框架类型而失真。

## 2. 分层与依赖（对齐 §4、§13）

| 层级 | MUST | MUST NOT |
| --- | --- | --- |
| Domain | 只表达业务语义与不变量；端口为接口 | 依赖具体 ORM/SDK/Web 框架 |
| Application | 用例编排、事务边界、归一化错误、触发领域命令 | 在编排层偷偷写绕过状态机的字段补丁 |
| Presentation | DTO、校验、鉴权、响应封装 | 判断任务可否调度、可否完成等业务终局 |
| Infrastructure | 实现端口；技术细节本地化 | 把业务状态裁决规则塞进 repository「便捷方法」 |
| Extension / 插件 | 仅通过声明的能力被调用 | 直连改核心聚合存储或替换状态机合法性 |

## 3. 硬约束门禁（对齐 §13，合并前逐项过）

评审勾选项（全部应为「满足」或其偏离已在文档登记）：

1. **领域层**：无指向 Web 框架、具体 DB driver 的类型依赖或未抽象的技术泄漏。
2. **状态**：任何任务状态迁移经显式领域命令/Application 用例，而非 ORM/`UPDATE` patch 零散触发。
3. **事件**：关键动作有结构化领域/集成事件或等价可追溯记录。
4. **插件**：不改变任务/执行/Repair/HumanReview/审计的权威最终结果存储语义（见插件 skill 的禁用列表）。
5. **并发**：调度与占用与 **AgentLease（或等价物）** 一致；禁止「先到先得式」隐式占坑且无超时回收语义。
6. **人工**：`HumanReview` 为一等流程——有请求原因、结构化回复索引、resume 可追溯依据。
7. **前端/BFF**：浏览器端与 BFF 查询层不出现状态机、修复预算或停止裁决的「第二真相」。

## 4. 模块级规范摘录

以下条款在改动触及对应模块时 **必须专项检查**：

- **Identity & Access（§7.1）**：命令操作携带 `operator`；系统自动化操作用 `system:<module>`；审计与业务日志不混在同一语义通道。
- **Task Intake（§7.2）**：来源字段结构化（`sourceType` / `sourceSystem` / `sourceEntityId` / `sourceSyncKey`）；幂等键不得基于标题与自然语言说明推导。
- **Task Lifecycle（§7.3）**：每次迁移有 `reason`；状态规则与路由/DTO **解耦**。
- **Scheduler（§7.4）**：决策可解释、同 tick **可重放**、具备过载保护与租约超时回收；禁止把调度散落在通用类里或以「首个 idle Agent」顶替调度器策略。
- **Workspace（§7.6）**：创建幂等；与 task/execution **显式绑定**；禁止执行器任意写宿主根目录。
- **Execution（§7.7）**：执行器不直接改任务聚合状态；必须有取消/超时/中断路径；产出归一到标准结果模型。
- **Quality（§7.8）**：评测报告分项记录；评分与接纳结论字段分离。
- **Repair Loop（§7.9）**：停止信号显式（如 `risk_too_high`、`repair_budget_exhausted`、`same_failure_repeated` 等）；预算独立建模。
- **Observability（§7.12）**：`traceId` 贯穿任务链路；日志与事件分模；运维查询不走「扫执行输出裸文件」当主路径。
- **Governance（§7.13）**：结论结构化；可阻断但不「悄悄改」领域语义；升级走显式命令。
- **Notification（§7.14）**：订阅事件触发；失败 **不阻断** 主链路；投递幂等去重。
- **Console BFF（§7.15）**：仅只读视图模型；可做缓存；禁止变成第二套命令入口。

## 5. HTTP / API 规范（对齐 §10）

- MUST：区分命令路由与聚合查询路由；返回对外稳定 DTO。
- MUST NOT：把细碎状态枚举摊成碎片化动作面；让调用方仅靠 GET 拼装推导合法下一状态。
- SHOULD：`GET /tasks/{id}/timeline`、`/executions` 等视图与命令分离，避免「一个 PATCH 包办一切」。

## 6. 数据与存储（对齐 §9）

- MUST：事务存储 / 事件与审计存储 / 大对象与附件存储职责分离。
- MUST NOT：在同一「宽任务表」里混写执行细节、大块日志与评测正文导致语义塌方。
- MUST：同一聚合本地事务一致性优先；跨聚合变更倾向事件驱动的最终一致性，并文档化一致性级别。

## 7. PR 评审输出模板（建议）

对他人 PR 套用本 skill 时，优先按下面结构写结论（可删未涉及段）：

```markdown
## 架构门禁（TiTing）
- 门禁结果：PASS | PASS with notes | BLOCK
- 违反的 MUST / MUST NOT：[逐条列出，如无写「无」]

## 模块落位
- 涉及模块：[Task Lifecycle | Scheduler | …]
- 是否落在正确层级：[说明]

## 风险与回填
- 技术债/临时妥协：[如无写「无」]
- 建议跟进 issue：[如无写「无」]
```

---

**豁免**：仅在架构文档 ADR/issue 中有书面记录并得到评审认可时接受对 MUST 的偏离；豁免需写明范围与回填期限。
