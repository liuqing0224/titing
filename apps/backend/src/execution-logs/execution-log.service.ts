import { randomUUID } from "node:crypto";
import { Injectable, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { EventsService } from "../events/events.service";
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
    private readonly executionLogRepository: Repository<ExecutionLog>,
    @Optional()
    private readonly eventsService?: EventsService
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

    const saved = await this.executionLogRepository.save(log);
    this.eventsService?.publishExecutionLog(saved.id, saved.taskId, saved.status, saved.agentId);
    return saved;
  }

  async listByTask(taskId: string): Promise<ExecutionLog[]> {
    return this.executionLogRepository.find({
      where: { taskId },
      order: { createdAt: "ASC" }
    });
  }
}
