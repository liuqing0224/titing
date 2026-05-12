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

export function assertValidTransition(from: TaskStatus, to: TaskStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new InvalidTransitionError(`Illegal task transition: ${from} -> ${to}`);
  }
}
