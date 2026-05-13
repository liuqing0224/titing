import { PluginConfig } from "@titing/plugin-api";

/**
 * 插件运维：列出运行时健康、读/写 DB 中的 `plugin_configs`（启用、优先级、扩展 JSON）。
 * 写入后由 Server 重新加载或下一进程生效策略依部署而定；事件 `plugin.config_updated` 用于可观测。
 */
type PluginAdminHost = {
  listPlugins(): Promise<Array<Record<string, unknown>>>;
  listPluginConfigs(): Promise<PluginConfig[]>;
  upsertPluginConfig(input: {
    pluginId: string;
    kind: PluginConfig["kind"];
    enabled: boolean;
    priority: number;
    config: Record<string, unknown>;
  }): Promise<PluginConfig>;
};

export class PluginAdminService {
  constructor(private readonly host: PluginAdminHost) {}

  listPlugins(): ReturnType<PluginAdminHost["listPlugins"]> {
    return this.host.listPlugins();
  }

  listPluginConfigs(): Promise<PluginConfig[]> {
    return this.host.listPluginConfigs();
  }

  upsertPluginConfig(input: {
    pluginId: string;
    kind: PluginConfig["kind"];
    enabled: boolean;
    priority: number;
    config: Record<string, unknown>;
  }): Promise<PluginConfig> {
    return this.host.upsertPluginConfig(input);
  }
}
