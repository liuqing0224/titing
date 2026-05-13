export type Principal = {
  id: string;
  type: "human" | "agent" | "system" | "integration";
  displayName: string;
  permissions: Permission[];
};

export type Permission =
  | "task:create"
  | "task:update"
  | "task:execute"
  | "task:review"
  | "plugin:read"
  | "plugin:write"
  | "agent:operate"
  | "audit:read";

export type AuditEvent = {
  id: string;
  schemaVersion: string;
  actor: Principal;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: "allowed" | "blocked" | "observed";
  occurredAt: string;
  metadata: Record<string, unknown>;
};
