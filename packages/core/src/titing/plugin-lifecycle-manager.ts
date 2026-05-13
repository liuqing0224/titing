import { PluginConfig, RuntimePlugin } from "@titing/plugin-api";

/**
 * 在 `PluginRuntime.init` 驱动下，对每个插件：
 *
 * 1. `validate` 静态契约（id / capabilities / priority / health 函数存在）
 * 2. 注入该插件在 DB 中的 `PluginConfig`（若存在），调用 `plugin.init(config)`
 * 3. 调用 `plugin.health()` 刷新健康快照
 *
 * `close` 逆序（当前实现为正向遍历，与列表顺序一致）调用可选 `close()`。
 */
export class PluginLifecycleManager {
  constructor(
    private readonly plugins: RuntimePlugin[],
    private readonly configs: PluginConfig[] = []
  ) {}

  async init(): Promise<void> {
    for (const plugin of this.plugins) {
      const config = this.configs.find((item) => item.pluginId === plugin.id) ?? null;
      this.validate(plugin);
      await plugin.init?.(config);
      await plugin.health();
    }
  }

  async close(): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.close?.();
    }
  }

  /** 构造期兜底校验，避免运行时路由到不完整插件。 */
  validate(plugin: RuntimePlugin): void {
    if (typeof plugin.id !== "string" || !plugin.id.trim()) {
      throw new Error("Invalid plugin id");
    }
    if (!Array.isArray(plugin.capabilities)) {
      throw new Error(`Plugin ${plugin.id} must define capabilities`);
    }
    if (typeof plugin.priority !== "number") {
      throw new Error(`Plugin ${plugin.id} must define priority`);
    }
    if (typeof plugin.health !== "function") {
      throw new Error(`Plugin ${plugin.id} must define health()`);
    }
  }
}
