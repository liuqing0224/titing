/**
 * 插件运行时门面：组合 **策略**（启用/priority）、**路由**（按 kind + capability 选实例）、
 * **生命周期**（`init` / `health` / `close`）。供 `TitingServices` 与调度器解析「当前应调用哪几个插件」。
 */
import {
  EnvironmentPlugin,
  ExecutionPlugin,
  LogPlugin,
  ObservabilityGovernancePlugin,
  PluginConfig,
  PluginKind,
  QualityPlugin,
  RuntimePlugin,
  TaskIntegrationPlugin
} from "@titing/plugin-api";
import { PluginCapabilityRouter } from "./plugin-capability-router";
import { PluginLifecycleManager } from "./plugin-lifecycle-manager";
import { PluginPolicyEngine } from "./plugin-policy-engine";

export class PluginRuntime {
  private policy: PluginPolicyEngine;
  private readonly router: PluginCapabilityRouter;
  private readonly lifecycle: PluginLifecycleManager;

  constructor(
    private readonly plugins: RuntimePlugin[],
    private readonly configs: PluginConfig[] = []
  ) {
    this.policy = new PluginPolicyEngine(configs);
    this.router = new PluginCapabilityRouter(this.policy);
    this.lifecycle = new PluginLifecycleManager(plugins, configs);
  }

  /** 依次 `init` + `health`；启动失败应阻断 Server。 */
  async init(): Promise<void> {
    await this.lifecycle.init();
  }

  /** 逆序关闭插件（若实现 `close`）。 */
  async close(): Promise<void> {
    await this.lifecycle.close();
  }

  /** 浅拷贝当前插件数组（仅供列举/观测，修改元素需谨慎）。 */
  list(): RuntimePlugin[] {
    return [...this.plugins];
  }

  /**
   * 返回指定 kind 的已启用插件列表（已按 `effectivePriority` 降序排列），不含 capability 二次过滤。
   * 下列 `get*Plugins` 多用于诊断或对某类插件全量遍历。
   */
  getTaskIntegrations(): TaskIntegrationPlugin[] {
    return this.router.list(
      "task-integration",
      this.plugins.filter((plugin): plugin is TaskIntegrationPlugin => plugin.kind === "task-integration")
    );
  }

  getExecutionPlugins(): ExecutionPlugin[] {
    return this.router.list(
      "execution",
      this.plugins.filter((plugin): plugin is ExecutionPlugin => plugin.kind === "execution")
    );
  }

  getEnvironmentPlugins(): EnvironmentPlugin[] {
    return this.router.list(
      "environment",
      this.plugins.filter((plugin): plugin is EnvironmentPlugin => plugin.kind === "environment")
    );
  }

  getQualityPlugins(): QualityPlugin[] {
    return this.router.list(
      "quality",
      this.plugins.filter((plugin): plugin is QualityPlugin => plugin.kind === "quality")
    );
  }

  getGovernancePlugins(): ObservabilityGovernancePlugin[] {
    return this.router.list(
      "observability-governance",
      this.plugins.filter(
        (plugin): plugin is ObservabilityGovernancePlugin => plugin.kind === "observability-governance"
      )
    );
  }

  getLogPlugins(): LogPlugin[] {
    return this.router.list("log", this.plugins.filter((plugin): plugin is LogPlugin => plugin.kind === "log"));
  }

  /**
   * 解析执行器名（如 `codex` / `cursor`）到具体 `ExecutionPlugin`：
   * 先按 policy 排序，再取 `capabilities` 包含该 executor 的第一项。
   */
  selectExecutionPlugin(executor: string): ExecutionPlugin {
    return this.router.select("execution", this.getExecutionPlugins(), executor);
  }

  /** 环境/质量/日志等单栈场景：取排序后的首插件（必须存在时由 router 抛错）。 */
  selectEnvironmentPlugin(): EnvironmentPlugin {
    return this.router.select("environment", this.getEnvironmentPlugins());
  }

  /** 与 `selectEnvironmentPlugin` 同理，取 policy 排序后的首项质量插件。 */
  selectQualityPlugin(): QualityPlugin {
    return this.router.select("quality", this.getQualityPlugins());
  }

  /**
   * 执行管线里允许「无质量阶段」时的便捷访问：取排序后的第一个质量插件，可能为 `null`
   * （例如仅跑执行、不做评测与修复）。
   */
  getPrimaryQualityPlugin(): QualityPlugin | null {
    return this.getQualityPlugins()[0] ?? null;
  }

  /**
   * 无 capability 参数时，选「优先级最高」的日志实现（通常仅一个 `RootLogsPlugin`）。
   */
  selectLogPlugin(): LogPlugin {
    return this.router.select("log", this.getLogPlugins());
  }
}
