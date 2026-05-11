import {
  EnvironmentPlugin,
  ExecutionPlugin,
  ObservabilityGovernancePlugin,
  PluginConfig,
  PluginKind,
  QualityPlugin,
  RuntimePlugin,
  TaskIntegrationPlugin
} from "@titing/plugin-api";

export class PluginRuntime {
  constructor(
    private readonly plugins: RuntimePlugin[],
    private readonly configs: PluginConfig[] = []
  ) {}

  async init(): Promise<void> {
    for (const plugin of this.plugins) {
      const config = this.configs.find((item) => item.pluginId === plugin.id) ?? null;
      await plugin.init?.(config);
    }
  }

  list(): RuntimePlugin[] {
    return [...this.plugins];
  }

  getTaskIntegrations(): TaskIntegrationPlugin[] {
    return this.getEnabledPlugins().filter((plugin): plugin is TaskIntegrationPlugin => plugin.kind === "task-integration");
  }

  getExecutionPlugins(): ExecutionPlugin[] {
    return this.getEnabledPlugins().filter((plugin): plugin is ExecutionPlugin => plugin.kind === "execution");
  }

  getEnvironmentPlugins(): EnvironmentPlugin[] {
    return this.getEnabledPlugins().filter((plugin): plugin is EnvironmentPlugin => plugin.kind === "environment");
  }

  getQualityPlugins(): QualityPlugin[] {
    return this.getEnabledPlugins().filter((plugin): plugin is QualityPlugin => plugin.kind === "quality");
  }

  getGovernancePlugins(): ObservabilityGovernancePlugin[] {
    return this.getEnabledPlugins().filter(
      (plugin): plugin is ObservabilityGovernancePlugin => plugin.kind === "observability-governance"
    );
  }

  selectExecutionPlugin(executor: string): ExecutionPlugin {
    return this.selectByCapability("execution", executor, this.getExecutionPlugins());
  }

  selectEnvironmentPlugin(): EnvironmentPlugin {
    const selected = this.getEnvironmentPlugins().sort((left, right) => this.getPriority(right) - this.getPriority(left))[0];
    if (!selected) {
      throw new Error("No environment plugin registered");
    }
    return selected;
  }

  selectQualityPlugin(): QualityPlugin {
    const selected = this.getQualityPlugins().sort((left, right) => this.getPriority(right) - this.getPriority(left))[0];
    if (!selected) {
      throw new Error("No quality plugin registered");
    }
    return selected;
  }

  private selectByCapability<T extends RuntimePlugin>(kind: PluginKind, capability: string, plugins: T[]): T {
    const matches = plugins
      .filter((plugin) => plugin.capabilities.includes(capability))
      .sort((left, right) => this.getPriority(right) - this.getPriority(left));
    if (matches.length === 0) {
      throw new Error(`No ${kind} plugin registered for capability ${capability}`);
    }
    return matches[0];
  }

  private getEnabledPlugins(): RuntimePlugin[] {
    return this.plugins.filter((plugin) => this.getConfig(plugin.id)?.enabled ?? true);
  }

  private getPriority(plugin: RuntimePlugin): number {
    return this.getConfig(plugin.id)?.priority ?? plugin.priority;
  }

  private getConfig(pluginId: string): PluginConfig | undefined {
    return this.configs.find((item) => item.pluginId === pluginId);
  }
}
