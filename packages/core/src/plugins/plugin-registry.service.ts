import { Inject, Injectable, Optional } from "@nestjs/common";
import { APP_PLUGIN_MANIFESTS } from "./plugin.tokens";
import { ServerPluginManifest } from "./plugin.manifest";

@Injectable()
export class PluginRegistryService {
  constructor(
    @Optional()
    @Inject(APP_PLUGIN_MANIFESTS)
    private readonly manifests: ServerPluginManifest[] = []
  ) {}

  list(): ServerPluginManifest[] {
    return this.manifests;
  }

  find(id: string): ServerPluginManifest | undefined {
    return this.manifests.find((manifest) => manifest.id === id);
  }
}
