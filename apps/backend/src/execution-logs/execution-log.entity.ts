import { Column, CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "execution_logs" })
export class ExecutionLog {
  @PrimaryColumn({ type: "varchar" })
  id: string;

  @Column({ name: "task_id", type: "varchar" })
  taskId: string;

  @Column({ name: "agent_id", type: "varchar", nullable: true })
  agentId: string | null;

  @Column({ type: "varchar", length: 20 })
  status: string;

  @Column({ type: "text" })
  message: string;

  @Column({ type: "jsonb", nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: "created_at", type: "timestamp" })
  createdAt: Date;
}
