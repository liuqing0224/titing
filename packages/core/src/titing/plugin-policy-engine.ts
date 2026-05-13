import { PluginConfig, RuntimePlugin } from "@titing/plugin-api";

/**
 * 将数据库中的 `plugin_configs` 行应用到运行时插件实例：
 *
 * - **启用**：默认 `enabled`，无配置记录时视为启用。
 * - **优先级**：条目中的 `priority` 覆盖插件 manifest 的 `plugin.priority`（`getEffectivePriority`）。
 * - **排序**：`rankPlugins` 供 Router 使用，数值 **越大越优先**。
 *
 * `updateConfigs` 返回**新实例**（不可变），便于将来热更新配置时不改旧 runtime（当前主路径多在进程启动时构建一次）。
 */
export class PluginPolicyEngine {
  constructor(private readonly configs: PluginConfig[] = []) {}

  getEnabledPlugins<T extends RuntimePlugin>(plugins: T[]): T[] {
    return plugins.filter((plugin) => this.getConfig(plugin.id)?.enabled ?? true);
  }

  getEffectivePriority(plugin: RuntimePlugin): number {
    return this.getConfig(plugin.id)?.priority ?? plugin.priority;
  }

  rankPlugins<T extends RuntimePlugin>(plugins: T[]): T[] {
    return [...this.getEnabledPlugins(plugins)].sort(
      (left, right) => this.getEffectivePriority(right) - this.getEffectivePriority(left)
    );
  }

  /** 不抛错版本：找不到 capability 时返回 `null`。 */
  selectByCapability<T extends RuntimePlugin>(plugins: T[], capability: string): T | null {
    return this.rankPlugins(plugins).find((plugin) => plugin.capabilities.includes(capability)) ?? null;
  }

  updateConfigs(configs: PluginConfig[]): PluginPolicyEngine {
    return new PluginPolicyEngine(configs);
  }

  private getConfig(pluginId: string): PluginConfig | undefined {
    return this.configs.find((item) => item.pluginId === pluginId);
  }
}
