import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn
} from "typeorm";
import { AgentRecord, AgentStatus } from "@autodev-agent/plugin-api";

@Entity({ name: "agents" })
export class Agent implements AgentRecord {
  @PrimaryColumn({ type: "varchar" })
  id: string;

  @Column({ name: "task_id", type: "varchar", nullable: true })
  taskId: string | null;

  @Column({ name: "container_id", type: "varchar", length: 100, nullable: true })
  containerId: string | null;

  @Column({ name: "container_name", type: "varchar", length: 100 })
  containerName: string;

  @Column({ type: "varchar", length: 20, default: "idle" })
  status: AgentStatus;

  @Column({ name: "started_at", type: "timestamp", nullable: true })
  startedAt: Date | null;

  @Column({ name: "heartbeat_at", type: "timestamp" })
  heartbeatAt: Date;

  @CreateDateColumn({ name: "created_at", type: "timestamp" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamp" })
  updatedAt: Date;
}
