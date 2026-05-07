import { Inject, Injectable } from "@nestjs/common";
import { EXECUTION_LOG_STORE_PLUGIN } from "../plugins/plugin.tokens";
import { AppendExecutionLogInput, ExecutionLogStorePlugin } from "../plugins/execution-log-store.plugin";
import { ExecutionLog } from "./execution-log.entity";

@Injectable()
export class ExecutionLogService {
  constructor(
    @Inject(EXECUTION_LOG_STORE_PLUGIN)
    private readonly executionLogStore: ExecutionLogStorePlugin
  ) {}

  async append(input: AppendExecutionLogInput): Promise<ExecutionLog> {
    return this.executionLogStore.append(input);
  }

  async listByTask(taskId: string): Promise<ExecutionLog[]> {
    return this.executionLogStore.listByTask(taskId);
  }
}
