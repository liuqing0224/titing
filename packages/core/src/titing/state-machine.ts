/**
 * 任务状态机：显式允许的状态迁移表。
 *
 * - 终态如 `done` 不再迁出；`failed` / `needs_human` / `blocked` / `cancelled` 等可按业务回到 `queued` 等。
 * - `running` 可进入评测/修复分支或再次入队（多轮执行）。
 *
 * @see assertValidTransition
 */
import { InvalidTransitionError } from "./errors";
import { TaskStatus } from "@titing/plugin-api";

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created: ["validated", "blocked", "cancelled"],
  validated: ["pending", "blocked", "cancelled"],
  pending: ["queued", "blocked", "cancelled", "failed"],
  queued: ["running", "cancelled", "blocked"],
  running: ["evaluating", "repairing", "done", "queued", "failed", "blocked", "cancelled"],
  evaluating: ["done", "repairing", "failed", "needs_human"],
  repairing: ["evaluating", "done", "failed", "needs_human", "cancelled"],
  done: [],
  failed: ["queued"],
  needs_human: ["queued", "cancelled"],
  blocked: ["queued", "cancelled"],
  cancelled: ["queued"]
};

/**
 * 校验 `from -> to` 是否在允许表内；否则抛出 `InvalidTransitionError`。
 * 所有持久化状态变更应通过此类校验，避免仓储与运行时逻辑分叉。
 */
export function assertValidTransition(from: TaskStatus, to: TaskStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new InvalidTransitionError(`Illegal task transition: ${from} -> ${to}`);
  }
}
