import { createDatabase } from "./database";
import { RootLogsPlugin } from "./plugins";

/**
 * CLI：按 task id 或外部来源 id 拉取任务及周边数据（transition、execution、日志、评测、repair goal）。
 */
type DiagnosisArgs = {
  taskId?: string;
  externalId?: string;
  source?: string;
  json: boolean;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.taskId && !args.externalId) {
    throw new Error("Usage: diagnose-task --task-id <id> | --external-id <id> [--source meegle] [--json]");
  }

  const database = createDatabase();
  const logsPlugin = new RootLogsPlugin();
  try {
    await logsPlugin.init();
    const task = await loadTask(database.pool, args);
    if (!task) {
      throw new Error(args.taskId
        ? `Task ${args.taskId} not found`
        : `Task source=${args.source ?? "meegle"} externalId=${args.externalId} not found`);
    }

    const [transitions, executions, logs, evalResults, repairGoal] = await Promise.all([
      database.pool.query(
        "select * from task_transitions where task_id = $1 order by created_at desc limit 10",
        [task.id]
      ),
      database.pool.query(
        "select * from executions where task_id = $1 order by started_at desc limit 5",
        [task.id]
      ),
      logsPlugin.listByTask(String(task.id), 20).then((items) => ({
        rows: items.map((item) => ({
          id: item.id,
          task_id: item.taskId,
          execution_id: item.executionId,
          event_type: item.eventType,
          message: item.message,
          created_at: item.createdAt.toISOString(),
          data_json: JSON.stringify(item.data)
        }))
      })),
      database.pool.query(
        "select * from eval_results where task_id = $1 order by created_at desc limit 5",
        [task.id]
      ),
      database.pool.query("select * from repair_goals where task_id = $1", [task.id])
    ]);

    const diagnosis = buildDiagnosis({
      task: task as Record<string, unknown>,
      transitions: transitions.rows as Array<Record<string, unknown>>,
      executions: executions.rows as Array<Record<string, unknown>>,
      logs: logs.rows as Array<Record<string, unknown>>,
      evalResults: evalResults.rows as Array<Record<string, unknown>>,
      repairGoal: repairGoal.rows[0] as Record<string, unknown> | undefined
    });

    if (args.json) {
      console.log(JSON.stringify(diagnosis, null, 2));
      return;
    }

    printDiagnosis(diagnosis);
  } finally {
    await database.pool.end();
  }
}

type DiagnosisInput = {
  task: Record<string, unknown>;
  transitions: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
  evalResults: Array<Record<string, unknown>>;
  repairGoal?: Record<string, unknown>;
};

export function buildDiagnosis(input: DiagnosisInput) {
  const latestExecution = input.executions[0];
  const latestEval = input.evalResults[0];
  const latestTransition = input.transitions[0];
  const latestLog = input.logs[0];
  const latestChecks = readChecks(latestEval?.report_json);
  const failedChecks = latestChecks.filter((check) => !check.passed);
  const logTail = input.logs.slice(0, 5).map((log) => ({
    at: toIso(log.created_at),
    eventType: String(log.event_type),
    message: String(log.message)
  }));
  const transitionTail = input.transitions.slice(0, 5).map((transition) => ({
    at: toIso(transition.created_at),
    from: String(transition.from_status),
    to: String(transition.to_status),
    reason: String(transition.reason)
  }));
  const stopReason = inferStopReason(input.logs, input.evalResults, input.repairGoal);

  return {
    summary: {
      taskId: String(input.task.id),
      externalId: input.task.external_id ? String(input.task.external_id) : null,
      source: String(input.task.source),
      status: String(input.task.status),
      executor: String(input.task.executor),
      traceId: String(input.task.trace_id),
      retryCount: Number(input.task.retry_count),
      repairCount: Number(input.task.repair_count),
      createdAt: toIso(input.task.created_at),
      updatedAt: toIso(input.task.updated_at),
      startedAt: toIso(input.task.started_at),
      completedAt: toIso(input.task.completed_at)
    },
    latestExecution: latestExecution ? {
      id: String(latestExecution.id),
      status: String(latestExecution.status),
      summary: latestExecution.summary ? String(latestExecution.summary) : null,
      agentId: latestExecution.agent_id ? String(latestExecution.agent_id) : null,
      startedAt: toIso(latestExecution.started_at),
      endedAt: toIso(latestExecution.ended_at)
    } : null,
    latestEvaluation: latestEval ? {
      id: String(latestEval.id),
      passed: Boolean(latestEval.passed),
      score: Number(latestEval.score),
      riskLevel: String(latestEval.risk_level),
      failedChecks,
      createdAt: toIso(latestEval.created_at)
    } : null,
    repairGoal: input.repairGoal ? {
      status: String(input.repairGoal.status),
      iteration: Number(input.repairGoal.iteration),
      maxIterations: Number(input.repairGoal.max_iterations),
      objective: String(input.repairGoal.objective),
      lastFailureHash: input.repairGoal.last_failure_hash ? String(input.repairGoal.last_failure_hash) : null
    } : null,
    inferredFailureMode: {
      stopReason,
      latestTransition: latestTransition ? {
        from: String(latestTransition.from_status),
        to: String(latestTransition.to_status),
        reason: String(latestTransition.reason),
        at: toIso(latestTransition.created_at)
      } : null,
      latestLog: latestLog ? {
        eventType: String(latestLog.event_type),
        message: String(latestLog.message),
        at: toIso(latestLog.created_at)
      } : null
    },
    recentTransitions: transitionTail,
    recentLogs: logTail
  };
}

async function loadTask(
  pool: ReturnType<typeof createDatabase>["pool"],
  args: DiagnosisArgs
): Promise<Record<string, unknown> | null> {
  if (args.taskId) {
    const result = await pool.query("select * from tasks where id = $1 limit 1", [args.taskId]);
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }
  const result = await pool.query(
    "select * from tasks where source = $1 and external_id = $2 limit 1",
    [args.source ?? "meegle", args.externalId]
  );
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
}

function parseArgs(argv: string[]): DiagnosisArgs {
  const args: DiagnosisArgs = {
    source: "meegle",
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--task-id") {
      args.taskId = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--external-id") {
      args.externalId = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--source") {
      args.source = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--json") {
      args.json = true;
    }
  }
  return args;
}

function readChecks(value: unknown): Array<{ name: string; passed: boolean; detail: string }> {
  const report = decodeJsonObject(value);
  const checks = report.checks;
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks
    .filter((check): check is Record<string, unknown> => typeof check === "object" && check !== null)
    .map((check) => ({
      name: typeof check.name === "string" ? check.name : "unknown",
      passed: check.passed === true,
      detail: typeof check.detail === "string" ? check.detail : ""
    }));
}

function inferStopReason(
  logs: Array<Record<string, unknown>>,
  evalResults: Array<Record<string, unknown>>,
  repairGoal?: Record<string, unknown>
): string {
  const latestEval = evalResults[0];
  if (repairGoal?.status === "budget_limited") {
    return "repair_budget_exhausted";
  }
  if (repairGoal?.status === "needs_human") {
    return "repair_needs_human";
  }
  if (latestEval && String(latestEval.risk_level) === "high") {
    return "high_risk_eval";
  }
  const repeatedFailureLog = logs.find((log) => String(log.message).includes("Repeated failure pattern detected"));
  if (repeatedFailureLog) {
    return "repeated_failure";
  }
  const noDiffLog = logs.find((log) => String(log.message).includes("no effective diff"));
  if (noDiffLog) {
    return "no_effective_diff";
  }
  return "unknown";
}

function decodeJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    try {
      return decodeJsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (typeof value !== "object") {
    return {};
  }
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion && payload.data && typeof payload.data === "object" && payload.data !== null) {
    return payload.data as Record<string, unknown>;
  }
  return payload;
}

function toIso(value: unknown): string | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function printDiagnosis(diagnosis: ReturnType<typeof buildDiagnosis>): void {
  console.log(`Task: ${diagnosis.summary.taskId} [${diagnosis.summary.status}]`);
  console.log(`Source: ${diagnosis.summary.source} externalId=${diagnosis.summary.externalId ?? "-"}`);
  console.log(`Executor: ${diagnosis.summary.executor} traceId=${diagnosis.summary.traceId}`);
  console.log(`Retries: ${diagnosis.summary.retryCount} repairs: ${diagnosis.summary.repairCount}`);
  console.log(`Inferred stop reason: ${diagnosis.inferredFailureMode.stopReason}`);

  if (diagnosis.latestExecution) {
    console.log(`Latest execution: ${diagnosis.latestExecution.id} ${diagnosis.latestExecution.status}`);
    if (diagnosis.latestExecution.summary) {
      console.log(`Execution summary: ${diagnosis.latestExecution.summary}`);
    }
  }

  if (diagnosis.latestEvaluation) {
    console.log(
      `Latest eval: passed=${diagnosis.latestEvaluation.passed} score=${diagnosis.latestEvaluation.score} risk=${diagnosis.latestEvaluation.riskLevel}`
    );
    for (const check of diagnosis.latestEvaluation.failedChecks) {
      console.log(`- failed check ${check.name}: ${check.detail}`);
    }
  }

  if (diagnosis.repairGoal) {
    console.log(
      `Repair goal: ${diagnosis.repairGoal.status} iteration=${diagnosis.repairGoal.iteration}/${diagnosis.repairGoal.maxIterations}`
    );
    console.log(`Objective: ${diagnosis.repairGoal.objective}`);
  }

  console.log("Recent transitions:");
  for (const item of diagnosis.recentTransitions) {
    console.log(`- ${item.at} ${item.from} -> ${item.to}: ${item.reason}`);
  }

  console.log("Recent logs:");
  for (const item of diagnosis.recentLogs) {
    console.log(`- ${item.at} ${item.eventType}: ${item.message}`);
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
