import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createAppModule } from "./app.module";
import { ApiResponseInterceptor } from "./api-response.interceptor";
import { HttpExceptionFilter } from "./http-exception.filter";
import { discoverServerPluginManifests } from "./plugin-loader";

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
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

for (const candidate of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(__dirname, "../../../.env")
]) {
  loadEnvFile(candidate);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(createAppModule(discoverServerPluginManifests()));
  app.setGlobalPrefix("api");
  app.enableCors({ origin: "*" });
  app.useGlobalInterceptors(new ApiResponseInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true
    })
  );

  const port = Number(process.env.BACKEND_PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
