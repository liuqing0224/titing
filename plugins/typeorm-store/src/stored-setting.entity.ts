import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn
} from "typeorm";

@Entity({ name: "system_settings" })
export class StoredSetting {
  @PrimaryColumn({ type: "varchar", length: 100 })
  key: string;

  @Column({ type: "jsonb" })
  value: Record<string, unknown>;

  @CreateDateColumn({ name: "created_at", type: "timestamp" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamp" })
  updatedAt: Date;
}
