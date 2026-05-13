/**
 * 领域对象**往返拷贝**：把可能来自 JSON / SQLite 的日期与嵌套数组/对象深拷贝为运行时安全形态，
 * 避免共享引用被下游意外修改。命名 `RoundTrip` 表示「入持久化前/出持久化后」都可调用。
 */
import {
  AgentLease,
  ExecutionRecord,
  HumanReview,
  RepairPlan,
  TitingTask
} from "@titing/plugin-api";

export function mapTaskRoundTrip(task: TitingTask): TitingTask {
  return {
    ...task,
    constraints: [...task.constraints],
    acceptanceCriteria: [...task.acceptanceCriteria],
    metadata: { ...task.metadata },
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
    startedAt: task.startedAt ? new Date(task.startedAt) : null,
    completedAt: task.completedAt ? new Date(task.completedAt) : null
  };
}

export function mapExecutionRoundTrip(execution: ExecutionRecord): ExecutionRecord {
  return {
    ...execution,
    startedAt: new Date(execution.startedAt),
    endedAt: execution.endedAt ? new Date(execution.endedAt) : null
  };
}

export function mapRepairPlanRoundTrip(plan: RepairPlan): RepairPlan {
  return {
    ...plan,
    constraints: [...plan.constraints],
    doneWhen: [...plan.doneWhen],
    createdAt: new Date(plan.createdAt),
    updatedAt: new Date(plan.updatedAt)
  };
}

export function mapHumanReviewRoundTrip(review: HumanReview): HumanReview {
  return {
    ...review,
    createdAt: new Date(review.createdAt),
    updatedAt: new Date(review.updatedAt)
  };
}

export function mapAgentLeaseRoundTrip(lease: AgentLease): AgentLease {
  return {
    ...lease,
    candidateAgents: [...lease.candidateAgents],
    prioritySnapshot: { ...lease.prioritySnapshot },
    leasedAt: new Date(lease.leasedAt),
    leaseExpiresAt: new Date(lease.leaseExpiresAt),
    releasedAt: lease.releasedAt ? new Date(lease.releasedAt) : null
  };
}
