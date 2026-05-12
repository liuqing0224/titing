import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ExternalPluginFactory, PluginKind, RuntimePlugin } from "@titing/plugin-api";
import { ServerConfig } from "./config";
import { createBuiltinPluginGroups } from "./plugins";

const PLUGIN_KIND_ORDER: PluginKind[] = [
  "log",
  "task-integration",
  "environment",
  "execution",
  "quality",
  "observability-governance"
];

export async function createResolvedPlugins(config: ServerConfig): Promise<RuntimePlugin[]> {
  const builtinGroups = createBuiltinPluginGroups(config);
  const resolved: RuntimePlugin[] = [];

  for (const kind of PLUGIN_KIND_ORDER) {
    const packageName = getExternalPluginPackageName(config, kind);
    if (!packageName) {
      resolved.push(...builtinGroups[kind]);
      continue;
    }
    resolved.push(await loadExternalPlugin(kind, packageName, config));
  }

  return resolved;
}

export async function loadExternalPlugin(
  kind: PluginKind,
  packageName: string,
  serverConfig: ServerConfig
): Promise<RuntimePlugin> {
  const specifier = normalizeModuleSpecifier(packageName);
  const module = await import(specifier);
  const createPlugin = resolvePluginFactory(module);
  if (!createPlugin) {
    throw new Error(`External plugin package ${packageName} must export createPlugin()`);
  }
  const plugin = await createPlugin({ serverConfig, pluginKind: kind });
  assertRuntimePlugin(plugin, kind, packageName);
  return plugin;
}

export function getExternalPluginPackageName(config: ServerConfig, kind: PluginKind): string | null {
  switch (kind) {
    case "task-integration":
      return config.plugins.taskIntegration.packageName;
    case "execution":
      return config.plugins.execution.packageName;
    case "environment":
      return config.plugins.environment.packageName;
    case "quality":
      return config.plugins.quality.packageName;
    case "observability-governance":
      return config.plugins.observabilityGovernance.packageName;
    case "log":
      return config.plugins.log.packageName;
  }
}

function resolvePluginFactory(module: Record<string, unknown>): ExternalPluginFactory<ServerConfig> | null {
  if (typeof module.createPlugin === "function") {
    return module.createPlugin as ExternalPluginFactory<ServerConfig>;
  }
  if (typeof module.default === "function") {
    return module.default as ExternalPluginFactory<ServerConfig>;
  }
  if (module.default && typeof module.default === "object" && typeof (module.default as { createPlugin?: unknown }).createPlugin === "function") {
    return (module.default as { createPlugin: ExternalPluginFactory<ServerConfig> }).createPlugin;
  }
  return null;
}

function assertRuntimePlugin(plugin: unknown, kind: PluginKind, packageName: string): asserts plugin is RuntimePlugin {
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`External plugin package ${packageName} returned an invalid plugin`);
  }
  const candidate = plugin as RuntimePlugin;
  if (candidate.kind !== kind) {
    throw new Error(`External plugin package ${packageName} returned kind ${candidate.kind}, expected ${kind}`);
  }
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    throw new Error(`External plugin package ${packageName} returned a plugin without a valid id`);
  }
  if (!Array.isArray(candidate.capabilities) || typeof candidate.priority !== "number" || typeof candidate.health !== "function") {
    throw new Error(`External plugin package ${packageName} returned an invalid runtime plugin`);
  }
}

function normalizeModuleSpecifier(packageName: string): string {
  if (packageName.startsWith(".") || packageName.startsWith("/")) {
    const resolved = isAbsolute(packageName) ? packageName : resolve(process.cwd(), packageName);
    if (!existsSync(resolved)) {
      return resolved;
    }
    return pathToFileURL(resolved).href;
  }
  return packageName;
}
