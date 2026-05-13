import { PluginKind, RuntimePlugin } from "@titing/plugin-api";
import { PluginPolicyEngine } from "./plugin-policy-engine";

/**
 * 在 **已过滤为同一 `PluginKind`** 的列表上，结合 policy 的排序结果做最终选择：
 *
 * - `list`：返回启用且按 effective priority **降序** 排列的插件（高优先级在前）。
 * - `select`：
 *   - 若传入 `capability`（如 executor 名），在排序结果中找 **第一个** `capabilities` 命中者；
 *   - 若不传，则取排序后的 **第一个**（头插策略）。
 *
 * 异常「No xxx plugin」表示没有任何候选，或 capability 与注册 capabilities 不匹配。
 */
export class PluginCapabilityRouter {
  constructor(private readonly policy: PluginPolicyEngine) {}

  select<T extends RuntimePlugin>(kind: PluginKind, plugins: T[], capability?: string): T {
    const candidates = this.policy.rankPlugins(plugins.filter((plugin) => plugin.kind === kind));
    const selected = capability
      ? candidates.find((plugin) => plugin.capabilities.includes(capability))
      : candidates[0];
    if (!selected) {
      if (capability) {
        throw new Error(`No ${kind} plugin registered for capability ${capability}`);
      }
      throw new Error(`No ${kind} plugin registered`);
    }
    return selected;
  }

  list<T extends RuntimePlugin>(kind: PluginKind, plugins: T[]): T[] {
    return this.policy.rankPlugins(plugins.filter((plugin) => plugin.kind === kind));
  }
}
