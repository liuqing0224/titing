/**
 * 简单聚合 dashboard、任务、Agent、插件列表，供 `/api/ops-view` 或运维面板消费。
 */
type OpsViewServices = {
  dashboard(): Promise<Record<string, unknown>>;
  listTasks(query?: { status?: string; executor?: string }): Promise<Array<Record<string, unknown>>>;
  listAgents(): Promise<Array<Record<string, unknown>>>;
  listPlugins(): Promise<Array<Record<string, unknown>>>;
};

/** 并行拉取快照，结构与 `schemaVersion` 对齐前端契约。 */
export async function buildOpsView(services: OpsViewServices) {
  const [dashboard, tasks, agents, plugins] = await Promise.all([
    services.dashboard(),
    services.listTasks(),
    services.listAgents(),
    services.listPlugins()
  ]);

  return {
    schemaVersion: "2026-05-13",
    dashboard,
    tasks,
    agents,
    plugins
  };
}
