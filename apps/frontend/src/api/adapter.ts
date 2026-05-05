import { apiRequest } from "./client";

export type SyncResult = {
  summary: {
    created: number;
    updated: number;
    failed: number;
    recovered: number;
    resetToPending: number;
  };
  items: Array<{
    externalId: string;
    taskId?: string;
    action: string;
    reason: string;
  }>;
};

export function syncMeegle(): Promise<SyncResult> {
  return apiRequest<SyncResult>("/adapter/meegle/sync", {
    method: "POST"
  });
}
