import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Task, TaskStatus } from "../tasks/task.entity";

export type DashboardStats = Record<"total" | TaskStatus, number>;

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>
  ) {}

  async getStats(): Promise<DashboardStats> {
    const [total, pending, queued, running, done, failed] = await Promise.all([
      this.taskRepository.count(),
      this.taskRepository.count({ where: { status: "pending" } }),
      this.taskRepository.count({ where: { status: "queued" } }),
      this.taskRepository.count({ where: { status: "running" } }),
      this.taskRepository.count({ where: { status: "done" } }),
      this.taskRepository.count({ where: { status: "failed" } })
    ]);

    return {
      total,
      pending,
      queued,
      running,
      done,
      failed
    };
  }
}
