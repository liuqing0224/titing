import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ListTasksQuery, TaskStorePlugin } from "../../../packages/core/src/plugins/task-store.plugin";
import { Task } from "../../../packages/core/src/tasks/task.entity";

@Injectable()
export class TypeOrmTaskStoreService implements TaskStorePlugin {
  constructor(
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>
  ) {}

  async listTasks(query: ListTasksQuery = {}): Promise<Task[]> {
    return this.taskRepository.find({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.priority ? { priority: query.priority } : {})
      },
      order: {
        priority: "DESC",
        createdAt: "ASC"
      }
    });
  }

  async getTask(id: string): Promise<Task | null> {
    return this.taskRepository.findOne({ where: { id } });
  }

  async findTaskByExternalId(externalId: string): Promise<Task | null> {
    return this.taskRepository.findOne({ where: { externalId } });
  }

  createTask(input: Partial<Task>): Task {
    return this.taskRepository.create(input);
  }

  async saveTask(task: Task): Promise<Task> {
    return this.taskRepository.save(task);
  }
}
