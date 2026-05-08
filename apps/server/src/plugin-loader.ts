import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ServerPluginManifest } from "@autodev-agent/plugin-api";

function isServerPluginManifest(value: unknown): value is ServerPluginManifest {
  return typeof value === "object" && value !== null && "id" in value && "kind" in value;
}

function getPluginRoot(): string {
  const candidates = [
    resolve(process.cwd(), "plugins"),
    resolve(process.cwd(), "../../plugins"),
    resolve(__dirname, "../../../plugins")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to locate plugins directory");
}

function getManifestExtension(): ".ts" | ".js" {
  return __filename.endsWith(".ts") ? ".ts" : ".js";
}

export function discoverServerPluginManifests(): ServerPluginManifest[] {
  const pluginRoot = getPluginRoot();
  const extension = getManifestExtension();

  return readdirSync(pluginRoot)
    .map((pluginDir) => join(pluginRoot, pluginDir, "src", `plugin.manifest${extension}`))
    .filter((manifestPath) => existsSync(manifestPath))
    .map((manifestPath) => {
      const loaded = require(manifestPath) as Record<string, unknown>;
      const manifest = Object.values(loaded).find(isServerPluginManifest);
      if (!manifest) {
        throw new Error(`No server plugin manifest export found in ${manifestPath}`);
      }
      return manifest;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
