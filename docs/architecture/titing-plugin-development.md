# Titing 插件开发指南

更新日期：2026-05-11

当前仓库里的插件实现仍以内置类注册为主，但协议层已经稳定，新增插件时应遵循 `packages/plugin-api/src/titing/*` 的接口模型。

## 插件类型

Titing 当前支持以下插件类型：

- `task-integration`
- `execution`
- `environment`
- `quality`
- `observability-governance`
- `log`

每类插件都至少需要这些字段：

- `id`
- `kind`
- `priority`
- `capabilities`
- `health()`

## 开发入口

实现位置可参考：

- [apps/server/src/titing/plugins.ts](/Users/l/Documents/work/code/demo/autoDevAgent/apps/server/src/titing/plugins.ts:1)
- [packages/plugin-api/src/titing/index.ts](/Users/l/Documents/work/code/demo/autoDevAgent/packages/plugin-api/src/titing/index.ts:1)
- [packages/core/src/titing](/Users/l/Documents/work/code/demo/autoDevAgent/packages/core/src/titing)

## 最小约束

### Task Integration

职责：

- 拉取外部任务
- 映射到 `TitingTask`
- 回写执行结果

建议实现：

- `pullTasks()`
- `reportResult(task, summary)`
- `health()`

关键要求：

- 外部任务必须稳定映射到 `source + externalId`
- 输入字段要做合法性校验
- 不应在插件内部直接改任务状态，交由 `TitingServices` 处理

### Execution

职责：

- 调用真实执行器
- 返回结构化 `ExecutionResult`
- 可选支持 `continueSession()`

关键要求：

- 必须返回统一 `sessionId`
- 必须区分 `errorCategory` 与 `timeoutCategory`
- stdout/stderr/summary 应走治理插件脱敏
- 执行 cwd 必须落在 workspace repo 下

### Environment

职责：

- 准备仓库工作区
- 注入环境变量
- 负责清理策略

关键要求：

- `prepareWorkspace()` 必须返回 `workspacePath / repoPath / artifactsPath / env`
- 环境失败应抛出可分类错误
- 清理策略要区分成功和失败

### Quality

职责：

- 运行自动化检查
- 生成 `checks[] / report / riskLevel`

关键要求：

- 即使脚本缺失，也要显式产出 skipped 检查结果
- 结果必须足够结构化，能驱动 Goal Loop

### Observability Governance

职责：

- 执行前策略校验
- 执行后输出清洗
- 评测后风险阻断

关键要求：

- `beforeCommand()` 阻断时要返回清晰原因
- `redact()` 不能破坏 JSON 基本可读性
- 治理记录应可关联到文件日志与 SSE

### Log

职责：

- 接收统一结构化日志事件
- 把 task / trace / execution / executor 输出落盘到根目录 `logs/`
- 为 SSE、ops 聚合、task 日志查询提供统一读取入口

关键要求：

- 插件必须支持 `append()`、按 task/trace 查询、最近事件快照和订阅
- 日志文件格式统一为 JSON Lines
- `stdout / stderr / summary` 等执行器输出必须通过该插件写入 `logs/tasks/<taskId>/executor/`
- 无 `taskId` 的系统级事件也必须有稳定落盘位置，避免只存在内存

## 注册方式

当前服务端通过 `createBuiltinPlugins(config)` 注册插件集合，而不是运行时动态发现。

新增插件的最小步骤：

1. 在 `packages/plugin-api` 确认所需协议已存在。
2. 在 `apps/server/src/titing/plugins.ts` 新增实现类。
3. 在 `createBuiltinPlugins()` 中加入该实现。
4. 为该插件补 `health()`、主流程测试和必要的配置项。
5. 如需可配置优先级或开关，通过 `plugin_configs` 覆盖运行时选择。

## 配置覆盖

插件选择逻辑会同时考虑：

- 插件内置 `priority`
- `plugin_configs.enabled`
- `plugin_configs.priority`
- capability 是否匹配

因此：

- 新插件上线前应给出稳定默认 priority
- 同类插件并存时必须说明 capability 和覆盖关系

## 测试建议

至少覆盖：

- `health()`
- 正常路径
- 参数/输入非法路径
- 被禁用或 capability miss 路径
- 与 `TitingServices` 的集成选择路径

参考测试：

- [apps/server/src/titing/plugins.spec.ts](/Users/l/Documents/work/code/demo/autoDevAgent/apps/server/src/titing/plugins.spec.ts:1)
- [packages/core/src/titing/plugin-runtime.spec.ts](/Users/l/Documents/work/code/demo/autoDevAgent/packages/core/src/titing/plugin-runtime.spec.ts:1)

## 设计边界

- 插件不要直接操作 HTTP 层。
- 插件不要直接写 SQLite 表，统一经由 service/repository。
- 插件不要自行维护任务状态机。
- 外部系统的幂等与重试语义，要通过 `source + externalId`、结构化日志和 service 层状态机收敛。
- 日志插件是唯一文件日志入口；不要在其他插件里直接向 `logs/` 写业务日志文件。
