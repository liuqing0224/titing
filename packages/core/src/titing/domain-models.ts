/**
 * 领域别名：与 `@titing/plugin-api` 类型一一对应，便于在 core 包内将来抽换实现或加约束。
 */
import { AgentLease, ExecutionRecord, HumanReview, RepairPlan, TitingTask } from "@titing/plugin-api";

export type TaskModel = TitingTask;
export type ExecutionModel = ExecutionRecord;
export type RepairPlanModel = RepairPlan;
export type HumanReviewModel = HumanReview;
export type AgentLeaseModel = AgentLease;
