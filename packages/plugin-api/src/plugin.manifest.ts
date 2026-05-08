import { Abstract, Type } from "@nestjs/common";
import { EntitySchema } from "typeorm";

export type PluginEntityClass = Function | EntitySchema;
export type PluginProviderToken = string | symbol | Type<unknown> | Abstract<unknown>;
export type PluginProvides = {
  taskStore?: PluginProviderToken;
  agentStore?: PluginProviderToken;
  executionLogStore?: PluginProviderToken;
  settingsStore?: PluginProviderToken;
  eventBus?: PluginProviderToken;
  executionEngine?: PluginProviderToken;
  agentRuntime?: PluginProviderToken;
};

export type ServerPluginManifest = {
  id: string;
  priority?: number;
  kind:
    | "task-source"
    | "result-reporter"
    | "execution-engine"
    | "agent-runtime"
    | "ui-backend"
    | "composite";
  module?: Type<unknown>;
  provides?: PluginProvides;
  entities?: PluginEntityClass[];
  migrations?: Function[];
  taskSources?: PluginProviderToken[];
  resultReporters?: PluginProviderToken[];
  web?: Array<{
    id: string;
    title: string;
    entryPath: string;
  }>;
};
