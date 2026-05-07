import { MigrationInterface, QueryRunner } from "typeorm";

export class TaskLifecycle1714406400001 implements MigrationInterface {
  name = "TaskLifecycle1714406400001";

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable("tasks"))) {
      await queryRunner.query(`
        CREATE TABLE "tasks" (
          "id" varchar NOT NULL,
          "source" varchar(20) NOT NULL DEFAULT 'meegle',
          "external_id" varchar(100),
          "title" varchar(500) NOT NULL,
          "description" text,
          "repo" varchar(200) NOT NULL,
          "branch" varchar(200) NOT NULL DEFAULT 'main',
          "task_type" varchar(20) NOT NULL DEFAULT 'chore',
          "priority" varchar(20) NOT NULL DEFAULT 'medium',
          "status" varchar(20) NOT NULL DEFAULT 'pending',
          "instruction" text,
          "constraints" jsonb NOT NULL DEFAULT '[]',
          "retry_count" integer NOT NULL DEFAULT 0,
          "claimed_at" timestamp,
          "started_at" timestamp,
          "completed_at" timestamp,
          "agent_id" varchar,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now(),
          CONSTRAINT "PK_tasks_id" PRIMARY KEY ("id")
        )
      `);
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tasks_external_id" ON "tasks" ("external_id") WHERE "external_id" IS NOT NULL`
    );

    if (!(await queryRunner.hasTable("agents"))) {
      await queryRunner.query(`
        CREATE TABLE "agents" (
          "id" varchar NOT NULL,
          "task_id" varchar,
          "container_id" varchar(100),
          "container_name" varchar(100) NOT NULL,
          "status" varchar(20) NOT NULL DEFAULT 'idle',
          "started_at" timestamp,
          "heartbeat_at" timestamp NOT NULL,
          "created_at" timestamp NOT NULL DEFAULT now(),
          "updated_at" timestamp NOT NULL DEFAULT now(),
          CONSTRAINT "PK_agents_id" PRIMARY KEY ("id")
        )
      `);
    }

  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "agents"`);
    await queryRunner.query(`DROP INDEX "IDX_tasks_external_id"`);
    await queryRunner.query(`DROP TABLE "tasks"`);
  }
}
