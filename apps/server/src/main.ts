/**
 * 进程入口：加载多级 `.env`、读取配置并启动 Fastify（失败时格式化输出后退出）。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildServer } from "./titing/server";
import { readConfig } from "./titing/config";
import { formatStartupError, wrapBootstrapError } from "./titing/startup-errors";

/** 极简 KEY=VALUE 解析，不解析 export、不展开变量；与 dotenv 行为接近即可。 */
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
    if (!key) {
      continue;
    }

    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

/** cwd、上级、再上级各尝试 `.env`，便于在 monorepo 子包里启动服务。 */
function loadProjectEnv(): void {
  const cwd = process.cwd();
  loadEnvFile(resolve(cwd, ".env"));
  loadEnvFile(resolve(cwd, "..", ".env"));
  loadEnvFile(resolve(cwd, "..", "..", ".env"));
}

/** 失败时包装为可读 `Error`，写 stderr 并由进程 exit code 反映。 */
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
