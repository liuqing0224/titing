import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn
} from "typeorm";

export type TaskSource = "meegle" | "manual";
export type TaskType = "feature" | "bug" | "chore" | "docs";
export type TaskPriority = "low" | "medium" | "high";
export type TaskStatus = "pending" | "queued" | "running" | "done" | "failed";

@Entity({ name: "tasks" })
export class Task {
  @PrimaryColumn({ type: "varchar" })
  id: string;

  @Column({ type: "varchar", length: 20, default: "meegle" })
  source: TaskSource;

  @Index({ unique: true })
  @Column({ name: "external_id", type: "varchar", length: 100, nullable: true })
  externalId: string | null;

  @Column({ type: "varchar", length: 500 })
  title: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({ type: "varchar", length: 200 })
  repo: string;

  @Column({ type: "varchar", length: 200, default: "main" })
  branch: string;

  @Column({ name: "task_type", type: "varchar", length: 20, default: "chore" })
  taskType: TaskType;

  @Column({ type: "varchar", length: 20, default: "medium" })
  priority: TaskPriority;

  @Column({ type: "varchar", length: 20, default: "pending" })
  status: TaskStatus;

  @Column({ type: "text", nullable: true })
  instruction: string | null;

  @Column({ type: "jsonb", default: () => "'[]'" })
  constraints: unknown[];

  @Column({ name: "retry_count", type: "integer", default: 0 })
  retryCount: number;

  @Column({ name: "claimed_at", type: "timestamp", nullable: true })
  claimedAt: Date | null;

  @Column({ name: "started_at", type: "timestamp", nullable: true })
  startedAt: Date | null;

  @Column({ name: "completed_at", type: "timestamp", nullable: true })
  completedAt: Date | null;

  @Column({ name: "agent_id", type: "varchar", nullable: true })
  agentId: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamp" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamp" })
  updatedAt: Date;
}
