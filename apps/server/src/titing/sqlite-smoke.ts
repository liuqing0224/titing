/**
 * 集成烟测：临时目录中建库、`run-migrations`、短时拉起 server 并对 health/readiness 做探测。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile as execFileCallback, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createDatabase } from "./database";

const execFile = promisify(execFileCallback);

async function main(): Promise<void> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "titing-sqlite-smoke-"));
  const migrationDatabaseFile = join(workspaceDir, "migration.sqlite");
  const serverDatabaseFile = join(workspaceDir, "server.sqlite");
  const serverPort = String(3050 + Math.floor(Math.random() * 100));
  let serverProcess: ChildProcess | null = null;

  try {
    await runNodeScript("src/run-migrations.ts", { DATABASE_FILE: migrationDatabaseFile });
    await assertSchemaMigrations(migrationDatabaseFile);

    serverProcess = spawn(
      "node",
      ["--require", "ts-node/register", "src/main.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BACKEND_PORT: serverPort,
          DATABASE_FILE: serverDatabaseFile,
          TITING_SCHEDULER_INTERVAL_MS: "600000"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    const startupLogs = captureProcessOutput(serverProcess);
    await waitForHttp(`http://127.0.0.1:${serverPort}/api/health`);

    const healthResponse = await fetchJson(`http://127.0.0.1:${serverPort}/api/health`);
    const readinessResponse = await fetchJson(`http://127.0.0.1:${serverPort}/api/readiness`);
    const dashboardResponse = await fetchJson(`http://127.0.0.1:${serverPort}/api/dashboard`);

    if (healthResponse.ok !== true) {
      throw new Error(`Health response invalid: ${JSON.stringify(healthResponse)}`);
    }
    if (readinessResponse.ok !== true || readinessResponse.status !== "ready") {
      throw new Error(`Readiness response invalid: ${JSON.stringify(readinessResponse)}`);
    }
    if (typeof dashboardResponse?.tasks?.total !== "number") {
      throw new Error(`Dashboard response invalid: ${JSON.stringify(dashboardResponse)}`);
    }

    await assertSchemaMigrations(serverDatabaseFile);

    console.log(JSON.stringify({
      ok: true,
      migrationDatabaseFile,
      serverDatabaseFile,
      serverPort,
      startupLogs
    }));
  } finally {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
      await waitForExit(serverProcess).catch(() => undefined);
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function runNodeScript(scriptPath: string, env: Record<string, string>): Promise<void> {
  await execFile("node", ["--require", "ts-node/register", scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env
    }
  });
}

async function assertSchemaMigrations(databaseFile: string): Promise<void> {
  const database = withDatabaseFile(databaseFile, () => createDatabase());
  try {
    const result = await database.pool.query("select count(*) as count from schema_migrations");
    if (!result.rows[0] || Number(result.rows[0].count) < 1) {
      throw new Error(`No schema migrations applied in ${databaseFile}`);
    }
  } finally {
    await database.pool.end();
  }
}

function withDatabaseFile<T>(databaseFile: string, factory: () => T): T {
  const previous = process.env.DATABASE_FILE;
  process.env.DATABASE_FILE = databaseFile;
  try {
    return factory();
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_FILE;
    } else {
      process.env.DATABASE_FILE = previous;
    }
  }
}

function captureProcessOutput(child: ChildProcess): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk) => {
    stdout.push(String(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk));
  });
  return { stdout, stderr };
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      await sleep(1_000);
      continue;
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
