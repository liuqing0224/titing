import { Controller, Get } from "@nestjs/common";
import { DashboardService, DashboardStats } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("stats")
  getStats(): Promise<DashboardStats> {
    return this.dashboardService.getStats();
  }
}
