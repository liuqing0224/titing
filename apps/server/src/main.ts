import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildServer } from "./titing/server";
import { readConfig } from "./titing/config";
import { formatStartupError, wrapBootstrapError } from "./titing/startup-errors";

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function loadProjectEnv(): void {
  const cwd = process.cwd();
  loadEnvFile(resolve(cwd, ".env"));
  loadEnvFile(resolve(cwd, "..", ".env"));
  loadEnvFile(resolve(cwd, "..", "..", ".env"));
}

async function bootstrap(): Promise<void> {
  try {
    loadProjectEnv();
    const config = readConfig();
    const server = await buildServer(config);
    await server.listen({ port: config.port, host: "0.0.0.0" });
  } catch (error) {
    const wrapped = wrapBootstrapError(error);
    console.error(formatStartupError(wrapped));
    process.exitCode = 1;
  }
}

void bootstrap();
