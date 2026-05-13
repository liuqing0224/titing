/**
 * 外部插件解析与加载：按固定种类顺序从配置读取 npm 包名（或本地路径），
 * 动态 import 后调用 `createPluginPackage` / `createPlugins`，校验 manifest 与运行时契约；
 * 未配置包名时回退到内置插件组。
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ExternalPluginFactory, ExternalPluginPackage, PluginKind, RuntimePlugin } from "@titing/plugin-api";
import { ServerConfig } from "./config";
import { BuiltinPluginGroups, createBuiltinPluginGroups } from "./plugins";

type ExternalPluginKind = keyof BuiltinPluginGroups;

/** 与内置分组一致的装配顺序，保证依赖链（如 log → execution）稳定。 */
const PLUGIN_KIND_ORDER: ExternalPluginKind[] = [
  "log",
  "task-integration",
  "environment",
  "execution",
  "quality",
  "observability-governance"
];

/**
 * 返回最终用于 Server 的插件列表：每一类要么整组使用外部包，要么整组使用内置实现。
 */
export async function createResolvedPlugins(config: ServerConfig): Promise<RuntimePlugin[]> {
  const builtinGroups = createBuiltinPluginGroups(config);
  const resolved: RuntimePlugin[] = [];

  for (const kind of PLUGIN_KIND_ORDER) {
    const packageName = getExternalPluginPackageName(config, kind);
    if (!packageName) {
      resolved.push(...builtinGroups[kind]);
      continue;
    }
    resolved.push(...await loadExternalPlugin(kind, packageName, config));
  }

  return resolved;
}

/**
 * 加载单个种类的外部包：解析入口 → 取工厂 → 实例化包 → 创建插件并统一挂上包的 manifest。
 */
export async function loadExternalPlugin(
  kind: ExternalPluginKind,
  packageName: string,
  serverConfig: ServerConfig
): Promise<RuntimePlugin[]> {
  const specifier = normalizeModuleSpecifier(packageName);
  const module = await import(specifier);
  const createPluginPackage = resolvePluginFactory(module);
  if (!createPluginPackage) {
    throw new Error(`External plugin package ${packageName} must export createPluginPackage()`);
  }
  const pluginPackage = await createPluginPackage({ serverConfig, pluginKind: kind });
  assertPluginPackage(pluginPackage, kind, packageName);
  const plugins = await pluginPackage.createPlugins({ serverConfig, pluginKind: kind });
  if (!Array.isArray(plugins) || plugins.length === 0) {
    throw new Error(`External plugin package ${packageName} must create at least one plugin`);
  }
  for (const plugin of plugins) {
    assertRuntimePlugin(plugin, kind, packageName);
    assertPluginContract(plugin, packageName);
    plugin.manifest = pluginPackage.manifest;
  }
  return plugins;
}

/** 从 `ServerConfig.plugins` 读取该种类配置的 `packageName`；无配置时由调用方使用内置组。 */
export function getExternalPluginPackageName(config: ServerConfig, kind: ExternalPluginKind): string | null {
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
    default:
      return null;
  }
}

/** 兼容 CJS/ESM：`createPluginPackage` 命名导出、`default` 函数或 `default.createPluginPackage`。 */
function resolvePluginFactory(module: Record<string, unknown>): ExternalPluginFactory<ServerConfig> | null {
  if (typeof module.createPluginPackage === "function") {
    return module.createPluginPackage as ExternalPluginFactory<ServerConfig>;
  }
  if (typeof module.default === "function") {
    return module.default as ExternalPluginFactory<ServerConfig>;
  }
  if (
    module.default
    && typeof module.default === "object"
    && typeof (module.default as { createPluginPackage?: unknown }).createPluginPackage === "function"
  ) {
    return (module.default as { createPluginPackage: ExternalPluginFactory<ServerConfig> }).createPluginPackage;
  }
  return null;
}

/** 校验外部包返回对象的 manifest.kind 与 `createPlugins` 存在性。 */
function assertPluginPackage(
  pluginPackage: unknown,
  kind: PluginKind,
  packageName: string
): asserts pluginPackage is ExternalPluginPackage<ServerConfig> {
  if (!pluginPackage || typeof pluginPackage !== "object") {
    throw new Error(`External plugin package ${packageName} returned an invalid plugin package`);
  }
  const candidate = pluginPackage as ExternalPluginPackage<ServerConfig>;
  if (!candidate.manifest || candidate.manifest.kind !== kind) {
    throw new Error(`External plugin package ${packageName} returned manifest kind mismatch for ${kind}`);
  }
  if (typeof candidate.createPlugins !== "function") {
    throw new Error(`External plugin package ${packageName} must define createPlugins()`);
  }
}

/** 校验每个 `RuntimePlugin` 的 kind、id、capabilities、priority、health 等运行时字段。 */
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

/** 按插件种类强制实现对应业务能力方法（observability-governance 暂无统一方法约束）。 */
function assertPluginContract(plugin: RuntimePlugin, packageName: string): void {
  switch (plugin.kind) {
    case "task-integration":
      assertRequiredMethods(plugin, packageName, ["pullTasks", "reportResult"]);
      return;
    case "environment":
      assertRequiredMethods(plugin, packageName, ["prepareWorkspace", "cleanupWorkspace"]);
      return;
    case "execution":
      assertRequiredMethods(plugin, packageName, ["execute"]);
      return;
    case "quality":
      assertRequiredMethods(plugin, packageName, ["evaluate"]);
      return;
    case "log":
      assertRequiredMethods(plugin, packageName, ["append", "listByTask", "listByTrace", "recentEvents", "snapshotEvents", "subscribe"]);
      return;
    case "observability-governance":
      return;
  }
}

/** 按方法名检查插件实例上是否存在可调用实现。 */
function assertRequiredMethods(plugin: RuntimePlugin, packageName: string, methods: string[]): void {
  for (const method of methods) {
    if (typeof (plugin as unknown as Record<string, unknown>)[method] !== "function") {
      throw new Error(`External plugin package ${packageName} is missing required method ${method}() on ${plugin.id}`);
    }
  }
}

/**
 * 包名保持原样供 `import()`；相对/绝对路径则 resolve 后，若存在则转为 `file://`，避免 ESM 对裸路径的限制。
 */
function normalizeModuleSpecifier(packageName: string): string {
  if (packageName.startsWith(".") || packageName.startsWith("/")) {
    const resolved = isAbsolute(packageName) ? packageName : resolve(process.cwd(), packageName);
    // 路径不存在时仍返回字符串，交由 import 报错，便于区分「找不到入口」与文件 URL 规范化
    if (!existsSync(resolved)) {
      return resolved;
    }
    return pathToFileURL(resolved).href;
  }
  return packageName;
}
