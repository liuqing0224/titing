import { DynamicModule, Global, Module, Provider } from "@nestjs/common";
import { ServerPluginManifest } from "./plugin.manifest";
import {
  AGENT_RUNTIME_PLUGIN,
  AGENT_STORE_PLUGIN,
  APP_PLUGIN_MANIFESTS,
  EVENT_BUS_PLUGIN,
  EXECUTION_ENGINE_PLUGIN,
  EXECUTION_LOG_STORE_PLUGIN,
  SETTINGS_STORE_PLUGIN,
  TASK_RESULT_REPORTER_PLUGINS,
  TASK_SOURCE_PLUGINS,
  TASK_STORE_PLUGIN
} from "./plugin.tokens";
import { PluginRegistryService } from "./plugin-registry.service";

@Global()
@Module({})
export class PluginHostModule {
  static register(manifests: ServerPluginManifest[] = []): DynamicModule {
    const imports = manifests.flatMap((manifest) => (manifest.module ? [manifest.module] : []));
    const providers: Provider[] = [
      {
        provide: APP_PLUGIN_MANIFESTS,
        useValue: manifests
      },
      this.createArrayProvider(
        TASK_SOURCE_PLUGINS,
        manifests.flatMap((manifest) => manifest.taskSources ?? [])
      ),
      this.createArrayProvider(
        TASK_RESULT_REPORTER_PLUGINS,
        manifests.flatMap((manifest) => manifest.resultReporters ?? [])
      ),
      this.createSelectedProvider(
        TASK_STORE_PLUGIN,
        manifests,
        (manifest) => manifest.provides?.taskStore,
        "task store"
      ),
      this.createSelectedProvider(
        AGENT_STORE_PLUGIN,
        manifests,
        (manifest) => manifest.provides?.agentStore,
        "agent store"
      ),
      this.createSelectedProvider(
        EXECUTION_LOG_STORE_PLUGIN,
        manifests,
        (manifest) => manifest.provides?.executionLogStore,
        "execution log store"
      ),
      this.createSelectedProvider(
        EVENT_BUS_PLUGIN,
        manifests,
        (manifest) => manifest.provides?.eventBus,
        "event bus"
      ),
      this.createSelectedProvider(
        EXECUTION_ENGINE_PLUGIN,
        manifests,
        (manifest) => manifest.provides?.executionEngine,
        "execution engine"
      ),
      this.createSelectedProvider(
        AGENT_RUNTIME_PLUGIN,
        manifests,
        (manifest) => manifest.provides?.agentRuntime,
        "agent runtime"
      ),
      ...this.createOptionalSelectedProviders(manifests),
      PluginRegistryService
    ];

    return {
      module: PluginHostModule,
      imports,
      providers,
      exports: [
        PluginRegistryService,
        TASK_SOURCE_PLUGINS,
        TASK_RESULT_REPORTER_PLUGINS,
        TASK_STORE_PLUGIN,
        AGENT_STORE_PLUGIN,
        EXECUTION_LOG_STORE_PLUGIN,
        SETTINGS_STORE_PLUGIN,
        EVENT_BUS_PLUGIN,
        EXECUTION_ENGINE_PLUGIN,
        AGENT_RUNTIME_PLUGIN
      ]
    };
  }

  private static createArrayProvider(provide: symbol, inject: Array<string | symbol | Function>): Provider {
    return {
      provide,
      useFactory: (...instances: unknown[]) => instances,
      inject
    };
  }

  private static createOptionalSelectedProviders(manifests: ServerPluginManifest[]): Provider[] {
    const selected = this.selectProvider(manifests, (manifest) => manifest.provides?.settingsStore, "settings store");
    if (!selected) {
      return [];
    }

    return [
      {
        provide: SETTINGS_STORE_PLUGIN,
        useExisting: selected.token
      }
    ];
  }

  private static createSelectedProvider(
    provide: symbol,
    manifests: ServerPluginManifest[],
    pick: (manifest: ServerPluginManifest) => string | symbol | Function | undefined,
    label: string
  ): Provider {
    const selected = this.selectProvider(manifests, pick, label);
    if (!selected) {
      throw new Error(`No ${label} plugin is registered`);
    }

    return {
      provide,
      useExisting: selected.token
    };
  }

  private static selectProvider(
    manifests: ServerPluginManifest[],
    pick: (manifest: ServerPluginManifest) => string | symbol | Function | undefined,
    label: string
  ): { token: string | symbol | Function; priority: number } | null {
    const candidates = manifests
      .map((manifest) => ({
        id: manifest.id,
        priority: manifest.priority ?? 0,
        token: pick(manifest)
      }))
      .filter((candidate): candidate is { id: string; priority: number; token: string | symbol | Function } =>
        candidate.token !== undefined
      )
      .sort((left, right) => right.priority - left.priority);

    if (candidates.length === 0) {
      return null;
    }

    const [selected, next] = candidates;
    if (next && next.priority === selected.priority) {
      throw new Error(
        `Plugin priority conflict for ${label}: ${selected.id} and ${next.id} both use priority ${selected.priority}`
      );
    }

    return {
      token: selected.token,
      priority: selected.priority
    };
  }
}
