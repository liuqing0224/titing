/**
 * HTTP 插件扩展：`RuntimePlugin` 可选实现 `registerRoutes`，在 Fastify 上挂载 Webhook 等路由。
 */
import { FastifyInstance } from "fastify";
import { RuntimePlugin } from "@titing/plugin-api";
import { TitingServices } from "@titing/core";
import { ServerConfig } from "./config";

export type HttpPluginContext = {
  services: Pick<TitingServices, "ingestTaskFromIntegration">;
  config: ServerConfig;
};

export interface HttpRoutePlugin extends RuntimePlugin {
  registerRoutes?(fastify: FastifyInstance, context: HttpPluginContext): void;
}

/** 运行时安全收窄：仅在存在 `registerRoutes` 函数时视为 HTTP 插件。 */
export function isHttpRoutePlugin(plugin: RuntimePlugin): plugin is HttpRoutePlugin {
  return typeof (plugin as HttpRoutePlugin).registerRoutes === "function";
}
