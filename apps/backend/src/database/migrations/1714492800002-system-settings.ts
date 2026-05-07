import { MigrationInterface, QueryRunner } from "typeorm";

export class SystemSettings1714492800002 implements MigrationInterface {
  name = "SystemSettings1714492800002";

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable("system_settings")) {
      return;
    }

    await queryRunner.query(`
      CREATE TABLE "system_settings" (
        "key" varchar(100) NOT NULL,
        "value" jsonb NOT NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_system_settings_key" PRIMARY KEY ("key")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "system_settings"`);
  }
}
