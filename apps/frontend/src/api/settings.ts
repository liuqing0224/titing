import { apiRequest } from "./client";
import { MeegleLoginState, MeegleSyncSettings } from "./types";

export function getMeegleSyncSettings(): Promise<MeegleSyncSettings> {
  return apiRequest<MeegleSyncSettings>("/settings/meegle-sync");
}

export function updateMeegleSyncSettings(input: MeegleSyncSettings): Promise<MeegleSyncSettings> {
  return apiRequest<MeegleSyncSettings>("/settings/meegle-sync", {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function getMeegleLoginState(): Promise<MeegleLoginState> {
  return apiRequest<MeegleLoginState>("/settings/meegle-sync/login-state");
}
