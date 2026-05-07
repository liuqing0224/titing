import { apiRequest } from "./client";
import { DashboardStats } from "./types";

export function getDashboardStats(): Promise<DashboardStats> {
  return apiRequest<DashboardStats>("/dashboard/stats");
}
