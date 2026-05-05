import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ExecutionLog } from "./execution-log.entity";

export type AppendExecutionLogInput = {
  taskId: string;
  agentId?: string | null;
  status: string;
  message: string;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class ExecutionLogService {
  constructor(
    @InjectRepository(ExecutionLog)
    private readonly executionLogRepository: Repository<ExecutionLog>
  ) {}

  async append(input: AppendExecutionLogInput): Promise<ExecutionLog> {
    const log = this.executionLogRepository.create({
      id: `log-${randomUUID()}`,
      taskId: input.taskId,
      agentId: input.agentId ?? null,
      status: input.status,
      message: input.message,
      metadata: input.metadata ?? null
    });

    return this.executionLogRepository.save(log);
  }

  async listByTask(taskId: string): Promise<ExecutionLog[]> {
    return this.executionLogRepository.find({
      where: { taskId },
      order: { createdAt: "ASC" }
    });
  }
}
