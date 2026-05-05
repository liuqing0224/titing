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

export type MeegleLoginInit = {
  clientId: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
};

export type MeegleLoginPollInput = {
  clientId: string;
  deviceCode: string;
  interval?: number;
  expiresIn?: number;
};

export type MeegleLoginPollResult = {
  authenticated: boolean;
  host: string;
};

export function syncMeegle(): Promise<SyncResult> {
  return apiRequest<SyncResult>("/adapter/meegle/sync", {
    method: "POST"
  });
}

export function beginMeegleLogin(): Promise<MeegleLoginInit> {
  return apiRequest<MeegleLoginInit>("/adapter/meegle/login", {
    method: "POST"
  });
}

export function pollMeegleLogin(input: MeegleLoginPollInput): Promise<MeegleLoginPollResult> {
  return apiRequest<MeegleLoginPollResult>("/adapter/meegle/login/poll", {
    method: "POST",
    body: JSON.stringify(input)
  });
}
