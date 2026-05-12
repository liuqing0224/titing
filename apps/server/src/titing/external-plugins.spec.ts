import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DEFAULTS, ServerConfig } from "./config";
import { createResolvedPlugins, loadExternalPlugin } from "./external-plugins";

describe("external plugins", () => {
  it("replaces a built-in kind with the configured external package", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-external-quality-"));
    try {
      const modulePath = join(sandbox, "quality-plugin.cjs");
      await writeFile(modulePath, `
module.exports = {
  createPlugin() {
    return {
      id: "external-quality",
      kind: "quality",
      priority: 250,
      capabilities: ["default"],
      async health() {
        return { healthy: true, message: "external quality ready" };
      },
      async evaluate() {
        return {
          passed: true,
          score: 100,
          riskLevel: "low",
          checks: [],
          report: {}
        };
      }
    };
  }
};
`, "utf8");

      const config = createConfig({
        plugins: {
          ...CONFIG_DEFAULTS.plugins,
          quality: {
            packageName: modulePath
          }
        }
      });

      const plugins = await createResolvedPlugins(config);

      expect(plugins.map((plugin) => plugin.id)).toEqual([
        "root-logs",
        "meegle",
        "git-worktree-local",
        "codex",
        "cursor",
        "external-quality",
        "default-observability-governance"
      ]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("throws when an external package exports the wrong plugin kind", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-external-kind-"));
    try {
      const modulePath = join(sandbox, "wrong-kind.cjs");
      await writeFile(modulePath, `
module.exports = {
  createPlugin() {
    return {
      id: "wrong-kind",
      kind: "environment",
      priority: 100,
      capabilities: ["local"],
      async health() {
        return { healthy: true, message: "ok" };
      },
      async prepareWorkspace() {
        return {
          workspacePath: "/tmp/workspace",
          repoPath: "/tmp/workspace/repo",
          branch: "main",
          cachePath: "/tmp/cache",
          artifactsPath: "/tmp/artifacts",
          env: {}
        };
      },
      async cleanupWorkspace() {}
    };
  }
};
`, "utf8");

      await expect(loadExternalPlugin("quality", modulePath, createConfig())).rejects.toThrow(
        `External plugin package ${modulePath} returned kind environment, expected quality`
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("throws when an external package does not export createPlugin", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "titing-external-invalid-"));
    try {
      const modulePath = join(sandbox, "invalid-plugin.cjs");
      await writeFile(modulePath, "module.exports = {};\n", "utf8");

      await expect(loadExternalPlugin("log", modulePath, createConfig())).rejects.toThrow(
        `External plugin package ${modulePath} must export createPlugin()`
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

function createConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...CONFIG_DEFAULTS,
    ...overrides,
    scheduler: {
      ...CONFIG_DEFAULTS.scheduler,
      ...overrides.scheduler
    },
    workspace: {
      ...CONFIG_DEFAULTS.workspace,
      ...overrides.workspace
    },
    goalRecovery: {
      ...CONFIG_DEFAULTS.goalRecovery,
      ...overrides.goalRecovery
    },
    plugins: {
      ...CONFIG_DEFAULTS.plugins,
      ...overrides.plugins,
      taskIntegration: {
        ...CONFIG_DEFAULTS.plugins.taskIntegration,
        ...overrides.plugins?.taskIntegration
      },
      execution: {
        ...CONFIG_DEFAULTS.plugins.execution,
        ...overrides.plugins?.execution
      },
      environment: {
        ...CONFIG_DEFAULTS.plugins.environment,
        ...overrides.plugins?.environment
      },
      quality: {
        ...CONFIG_DEFAULTS.plugins.quality,
        ...overrides.plugins?.quality
      },
      observabilityGovernance: {
        ...CONFIG_DEFAULTS.plugins.observabilityGovernance,
        ...overrides.plugins?.observabilityGovernance
      },
      log: {
        ...CONFIG_DEFAULTS.plugins.log,
        ...overrides.plugins?.log
      },
      meegle: {
        ...CONFIG_DEFAULTS.plugins.meegle,
        ...overrides.plugins?.meegle
      }
    },
    governance: {
      ...CONFIG_DEFAULTS.governance,
      ...overrides.governance
    }
  };
}
