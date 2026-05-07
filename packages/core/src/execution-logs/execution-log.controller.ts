import { Controller, Get, Param } from "@nestjs/common";
import { ExecutionLog } from "./execution-log.entity";
import { ExecutionLogService } from "./execution-log.service";

@Controller("tasks/:taskId/logs")
export class ExecutionLogController {
  constructor(private readonly executionLogService: ExecutionLogService) {}

  @Get()
  listByTask(@Param("taskId") taskId: string): Promise<ExecutionLog[]> {
    return this.executionLogService.listByTask(taskId);
  }
}
