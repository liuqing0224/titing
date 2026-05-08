import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from "@nestjs/common";
import { TaskPriority, TaskStatus } from "@autodev-agent/plugin-api";
import { Task } from "./task.entity";
import { TaskService } from "./task.service";
import { UpdateTaskDto } from "./dto/update-task.dto";

@Controller("tasks")
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Get()
  list(
    @Query("status") status?: TaskStatus,
    @Query("priority") priority?: TaskPriority
  ): Promise<Task[]> {
    return this.taskService.listTasks({ status, priority });
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<Task> {
    return this.taskService.getTask(id);
  }

  @Patch(":id")
  updateExecutionFields(@Param("id") id: string, @Body() body: UpdateTaskDto): Promise<Task> {
    return this.taskService.updateExecutionFields(id, body);
  }

  @Post(":id/enqueue")
  enqueue(@Param("id") id: string): Promise<Task> {
    return this.taskService.enqueue(id);
  }

  @Post(":id/claim")
  claim(@Param("id") id: string, @Headers("x-agent-id") agentId: string): Promise<Task> {
    return this.taskService.claim(id, agentId);
  }

  @Post(":id/retry")
  retry(@Param("id") id: string): Promise<Task> {
    return this.taskService.retryFailed(id);
  }
}
