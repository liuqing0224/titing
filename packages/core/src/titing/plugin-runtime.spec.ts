import { PluginRuntime } from "./plugin-runtime";
import {
  EnvironmentPlugin,
  ExecutionPlugin,
  LogPlugin,
  ObservabilityGovernancePlugin,
  PluginConfig,
  QualityPlugin,
  RuntimePlugin,
  TaskIntegrationPlugin
} from "@titing/plugin-api";

describe("PluginRuntime", () => {
  it("passes plugin configs to init hooks", async () => {
    const initCalls: Array<{ pluginId: string; config: PluginConfig | null }> = [];
    const runtime = new PluginRuntime(
      [
        createExecutionPlugin("codex", 10, ["codex"], {
          init: async (config) => {
            initCalls.push({ pluginId: "codex", config });
          }
        }),
        createEnvironmentPlugin("env", 10, {
          init: async (config) => {
            initCalls.push({ pluginId: "env", config });
          }
        })
      ],
      [
        createConfig("codex", "execution", { enabled: false, priority: 99 }),
        createConfig("env", "environment", { enabled: true, priority: 50 })
      ]
    );

    await runtime.init();

    expect(initCalls).toEqual([
      {
        pluginId: "codex",
        config: expect.objectContaining({
          pluginId: "codex",
          enabled: false,
          priority: 99
        })
      },
      {
        pluginId: "env",
        config: expect.objectContaining({
          pluginId: "env",
          enabled: true,
          priority: 50
        })
      }
    ]);
  });

  it("filters disabled plugins out of runtime selection", () => {
    const runtime = new PluginRuntime(
      [
        createTaskIntegrationPlugin("meegle-a", 100, ["meegle"]),
        createTaskIntegrationPlugin("meegle-b", 10, ["meegle"]),
        createExecutionPlugin("codex-a", 100, ["codex"]),
        createExecutionPlugin("codex-b", 10, ["codex"])
      ],
      [
        createConfig("meegle-a", "task-integration", { enabled: false }),
        createConfig("codex-a", "execution", { enabled: false })
      ]
    );

    expect(runtime.getTaskIntegrations().map((plugin) => plugin.id)).toEqual(["meegle-b"]);
    expect(runtime.selectExecutionPlugin("codex").id).toBe("codex-b");
  });

  it("uses config priority overrides when selecting plugins", () => {
    const runtime = new PluginRuntime(
      [
        createExecutionPlugin("codex-a", 100, ["codex"]),
        createExecutionPlugin("codex-b", 10, ["codex"]),
        createEnvironmentPlugin("env-a", 100),
        createEnvironmentPlugin("env-b", 10),
        createQualityPlugin("quality-a", 100),
        createQualityPlugin("quality-b", 10)
      ],
      [
        createConfig("codex-a", "execution", { priority: 1 }),
        createConfig("codex-b", "execution", { priority: 500 }),
        createConfig("env-a", "environment", { priority: 1 }),
        createConfig("env-b", "environment", { priority: 500 }),
        createConfig("quality-a", "quality", { priority: 1 }),
        createConfig("quality-b", "quality", { priority: 500 })
      ]
    );

    expect(runtime.selectExecutionPlugin("codex").id).toBe("codex-b");
    expect(runtime.selectEnvironmentPlugin().id).toBe("env-b");
    expect(runtime.selectQualityPlugin().id).toBe("quality-b");
  });

  it("returns null when no quality plugin is enabled", () => {
    const runtime = new PluginRuntime(
      [createQualityPlugin("quality", 100)],
      [createConfig("quality", "quality", { enabled: false })]
    );

    expect(runtime.getPrimaryQualityPlugin()).toBeNull();
  });

  it("throws when no enabled plugin matches a required capability", () => {
    const runtime = new PluginRuntime(
      [
        createExecutionPlugin("codex", 100, ["codex"]),
        createGovernancePlugin("gov", 100)
      ],
      [createConfig("codex", "execution", { enabled: false })]
    );

    expect(() => runtime.selectExecutionPlugin("codex")).toThrow(
      "No execution plugin registered for capability codex"
    );
    expect(runtime.getGovernancePlugins().map((plugin) => plugin.id)).toEqual(["gov"]);
  });

  it("selects the highest-priority log plugin", () => {
    const runtime = new PluginRuntime([
      createLogPlugin("log-a", 10),
      createLogPlugin("log-b", 100)
    ]);

    expect(runtime.selectLogPlugin().id).toBe("log-b");
  });
});

function createConfig(
  pluginId: string,
  kind: PluginConfig["kind"],
  overrides: Partial<Pick<PluginConfig, "enabled" | "priority" | "config">> = {}
): PluginConfig {
  return {
    id: `config-${pluginId}`,
    pluginId,
    kind,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 10,
    config: overrides.config ?? {},
    updatedAt: new Date("2026-05-11T00:00:00.000Z")
  };
}

function createBasePlugin(
  id: string,
  kind: RuntimePlugin["kind"],
  priority: number,
  capabilities: string[],
  overrides: Partial<RuntimePlugin> = {}
): RuntimePlugin {
  return {
    id,
    kind,
    priority,
    capabilities,
    health: async () => ({ healthy: true, message: "ok" }),
    ...overrides
  };
}

function createTaskIntegrationPlugin(
  id: string,
  priority: number,
  capabilities: string[]
): TaskIntegrationPlugin {
  return {
    ...createBasePlugin(id, "task-integration", priority, capabilities),
    kind: "task-integration",
    pullTasks: async () => [],
    reportResult: async () => undefined
  };
}

function createExecutionPlugin(
  id: string,
  priority: number,
  capabilities: string[],
  overrides: Partial<ExecutionPlugin> = {}
): ExecutionPlugin {
  return {
    ...createBasePlugin(id, "execution", priority, capabilities, overrides),
    kind: "execution",
    execute: async () => {
      throw new Error("not used");
    },
    ...overrides
  };
}

function createEnvironmentPlugin(
  id: string,
  priority: number,
  overrides: Partial<EnvironmentPlugin> = {}
): EnvironmentPlugin {
  return {
    ...createBasePlugin(id, "environment", priority, ["local"], overrides),
    kind: "environment",
    prepareWorkspace: async () => {
      throw new Error("not used");
    },
    cleanupWorkspace: async () => undefined,
    ...overrides
  };
}

function createLogPlugin(id: string, priority: number): LogPlugin {
  return {
    ...createBasePlugin(id, "log", priority, ["default"]),
    kind: "log",
    append: async () => undefined,
    listByTask: async () => [],
    listByTrace: async () => [],
    recentEvents: async () => [],
    snapshotEvents: () => [],
    subscribe: () => () => undefined
  };
}

function createQualityPlugin(
  id: string,
  priority: number,
  overrides: Partial<QualityPlugin> = {}
): QualityPlugin {
  return {
    ...createBasePlugin(id, "quality", priority, ["default"], overrides),
    kind: "quality",
    evaluate: async () => {
      throw new Error("not used");
    },
    ...overrides
  };
}

function createGovernancePlugin(id: string, priority: number): ObservabilityGovernancePlugin {
  return {
    ...createBasePlugin(id, "observability-governance", priority, ["events"]),
    kind: "observability-governance"
  };
}
