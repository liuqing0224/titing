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

export function isHttpRoutePlugin(plugin: RuntimePlugin): plugin is HttpRoutePlugin {
  return typeof (plugin as HttpRoutePlugin).registerRoutes === "function";
}
