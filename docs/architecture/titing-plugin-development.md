# Titing 插件开发指南

更新日期：2026-05-12

插件分两类：**内置插件**（由宿主内建模块按插件种类分组注册）与 **外置插件**（通过环境变量指定 npm 包或文件路径后，宿主在启动时对该种类 kind **整类替换**为外置模块返回的单个插件）。协议类型定义在公开的插件契约包（plugin-api）。运行时可通过数据库中的插件配置启用、禁用或调整优先级。

宿主在启动时使用「插件运行时」载入解析后的插件列表；因此外置包无需修改本仓库源码即可替换某一种类的内置实现。

## 插件类型

Titing 当前支持以下插件类型（括号内为 kind 英文名）：

- 任务接入（task-integration）
- 执行器（execution）
- 环境与工作区（environment）
- 质量评测（quality）
- 观测与治理（observability-governance）
- 日志（log）

每类插件都至少需要这些字段或行为约定：

- 插件标识 id（全局稳定，并与插件配置表的 plugin_id 对应）
- 种类 kind（与上表一致）
- 优先级 priority（默认可被数据库覆盖）
- 能力列表 capabilities（执行器选型、环境选型的标签）
- 健康检查 health

可选用初始化方法 init：宿主在载入后为每个插件注入与其 id 匹配的插件配置行。

### 宿主侧扩展：HTTP 路由插件

部分任务接入需要对外暴露 HTTP（例如 Webhook）。宿主单独约定：在满足通用运行时插件形状的实现上，可额外提供 registerRoutes，把路由挂到 Fastify，并传入服务访问器与进程配置快照。

内置 Meegle 集成在挂载 API 时注册了 integrations/meegle 相关路径。

### 运行时选择：PluginRuntime

核心包中的插件运行时负责：

- 按插件配置的 enabled 过滤（无配置行时视为启用）
- 环境、质量、日志等同类插件按有效优先级降序取第一个（数据库可覆盖优先级）
- 执行器按 capabilities 是否包含任务的 executor，并结合优先级选取
- 必须存在至少一个可用的日志类插件以满足日志与 SSE 数据源

就绪检查 readiness 聚合环境、执行、观测治理三类插件的健康状况；日志、质量、任务接入不参与就绪门禁，但若缺失仍会破坏实际业务链路。

## 开发入口

实现时可按模块职责浏览：

- 外置插件解析：按 kind 合并内置分组与外置单个实例
- 内置插件编排：分组构建与扁平列表（供测试）
- 应用内插件子目录下的各具体实现
- 插件契约包中的接口声明
- 核心包中的应用服务与插件运行时

## 最小约束

### 任务接入（task-integration）

- 从外部系统拉任务，映射为本域任务模型，回写执行结果
- 建议具备拉取列表、上报结果与健康检查
- 外部任务必须用 source + externalId 唯一标识；不得在插件内自行推进任务状态机

### 执行器（execution）

- 调用真实 CLI 或远端执行单元，返回统一结构的执行结果
- 建议区分错误类别与超时类别，会话标识一致，可选用会话续跑
- 标准输出与错误输出宜经治理链路脱敏；工作目录须落在已为任务准备的工作区内

### 环境（environment）

- 克隆或更新仓库、准备工作区、注入环境变量、按策略清理
- 准备接口须返回约定的工作区路径、仓库路径、分支、缓存路径、产物路径与环境变量映射

### 质量（quality）

- 串联自动化检查并给出检查项列表、结构化报告与风险等级
- 脚本缺失时也须明确标记跳过，不可用模糊结论糊弄 Goal Loop

### 观测与治理（observability-governance）

- 命令前策略、命令后清理、评测后策略
- 阻断须给出可读原因；脱敏不应破坏结构化数据的基本可读性

### 日志（log）

- 接收结构化日志条目，写入仓库根 logs 目录树，并为 SSE 与按任务/trace 查询提供读接口
- 须支持追加、订阅与快照；执行器控制台类输出归入任务专属子目录

## 注册方式（外置插件）

宿主对每个 PluginKind 按固定顺序拼装最终列表（log → task-integration → environment → execution → quality → observability-governance）：

- 若某项环境变量 **未配置**（包名为空），则该 kind **保留全部内置插件**（例如 execution 默认可同时存在 Codex 与 Cursor）
- 若配置了 **非空** 外部包路径或包名，则 **仅注册外置模块返回的那一个插件**，该 kind **所有内置实现都不再出现**

### 环境变量与外置包名

与配置文档及示例环境文件中的命名一致：

| 插件种类 (kind) | 环境变量 (Env variable) |
| --- | --- |
| task-integration | TITING_PLUGIN_TASK_INTEGRATION_PACKAGE |
| execution | TITING_PLUGIN_EXECUTION_PACKAGE |
| environment | TITING_PLUGIN_ENVIRONMENT_PACKAGE |
| quality | TITING_PLUGIN_QUALITY_PACKAGE |
| observability-governance | TITING_PLUGIN_OBSERVABILITY_GOVERNANCE_PACKAGE |
| log | TITING_PLUGIN_LOG_PACKAGE |

包名字符串可以是：**npm 已安装包名**（由 Node 解析），或以点号斜线或绝对路径形式给出的 **JavaScript 模块文件**（宿主会按文件 URL 方式动态导入）。

### 模块导出契约

外置模块须导出名为 createPlugin 的工厂，可采用：

- 命名导出 createPlugin
- 默认导出函数 createPlugin
- 默认导出对象上的 createPlugin 字段

宿主会把「当前完整配置快照」与「期望的插件种类」作为上下文传入。工厂返回的对象必须字段齐全，kind 必须与期望种类一致，宿主还会校验 id、capabilities、priority 与 health 等运行时必备形状，并实现该种类在契约中要求的方法。

### 执行器外置的特别说明

内置层本为 **两个** execution 插件（Codex、Cursor）。一旦配置了 execution 外置包，上述两者都会被移除，仅剩外置模块的 **单个** execution 插件。实务上常常在 capabilities 内同时宣告 codex 与 cursor，在 execute 内按任务所选 executor 分支；或收窄为只支持一种执行器并让默认执行器与环境变量对齐。

如需复用内置行为中的 CLI 路径与超时，可读配置快照中对应段落自行拼接命令行参数。

### 示例一：替换 quality（思路）

任选路径放置 CommonJS 文件，文件中 exports.createPlugin 指向工厂函数，工厂返回 quality 类插件对象（含插件标识、种类、优先级、capabilities、health 与评测方法 evaluate）。评测方法返回是否通过、分数、风险等级、检查项数组与报告对象。

在环境里将 TITING_PLUGIN_QUALITY_PACKAGE 设为该文件的相对或绝对路径，重启宿主即可。仓库中与外置质量插件相关的自动化测试描述了最小可用的返回形状，可作为兼容性参照。

### 示例二：发布 npm 包替换任务接入（思路）

打包 ESM 或 CJS，入口导出异步或同步 createPlugin，返回对象实现任务接入种类的拉取列表、上报结果与健康检查等契约方法。发布后把 TITING_PLUGIN_TASK_INTEGRATION_PACKAGE 设为包名。**注意**：外置替换后内置 Meegle 不再加载；若仍需 Webhook，可在同一插件对象上按宿主约定的 HTTP 扩展形状补充路由挂载方法。

## 注册方式（内置插件）

内置实现由宿主源码中的插件分组构造函数生成；仍可扁平化成单数组供测试。**生产路径**始终以「解析外置之后的列表」为准；未配置任何外置包名时等价于全部采用内置条目。

内置默认包含：文件日志插件、Meegle 接入、本地 worktree 环境、Codex/Cursor（共享治理钩子）、默认质量门禁、默认观测治理插件。

## 配置覆盖

选择逻辑同时考虑插件默认优先级、插件配置表里是否禁用、表中覆盖后的优先级数值，以及在 execution 上任务 executor 与各插件 capabilities 的匹配。

同类多实现并存时须在文档中标清 capability 与优先级策略。

## 测试建议

宜覆盖健康检查、主路径成功、非法入参、被禁用或能力不匹配分支，以及与宿主应用服务的集成选型路径。仓库中已有面向内置插件单元、插件运行时与外置装载用例的实现，可对照增补。

## 设计边界

- 除宿主约定的路由扩展外，业务逻辑应保持与 HTTP 传输解耦。
- 不要绕过服务层直接改写 SQLite。
- 不要绕过服务层自建任务状态机。
- 与外部幂等、重试相关的语义仍以 source + externalId 及服务层迁移为准。
- 业务可读日志应集中于日志插件落盘路径，不要在其他插件手写散落的自定义日志树根。
