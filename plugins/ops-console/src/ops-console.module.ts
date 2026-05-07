import { Module } from "@nestjs/common";
import { DashboardModule } from "./dashboard.module";

@Module({
  imports: [DashboardModule]
})
export class OpsConsoleModule {}
