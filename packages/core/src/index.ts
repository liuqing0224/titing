/**
 * `@titing/core` 公共导出入口：领域服务、插件编排、状态机与可观测/仓储相关工具。
 *
 * 典型装配：`PluginRuntime`（插件选择与策略） + `TitingServices`（任务/调度/执行闭环）。
 */
export * from "./titing/errors";
export * from "./titing/state-machine";
export * from "./titing/plugin-runtime";
export * from "./titing/services";
export * from "./titing/task-command-service";
export * from "./titing/task-query-service";
export * from "./titing/scheduler-service";
export * from "./titing/execution-orchestrator";
export * from "./titing/repair-loop-service";
export * from "./titing/human-intervention-service";
export * from "./titing/plugin-admin-service";
export * from "./titing/plugin-capability-router";
export * from "./titing/plugin-policy-engine";
export * from "./titing/plugin-lifecycle-manager";
export * from "./titing/domain-models";
export * from "./titing/domain-mappers";
