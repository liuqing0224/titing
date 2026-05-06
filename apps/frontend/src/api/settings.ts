import { apiRequest } from "./client";
import { MeegleSyncSettings } from "./types";

export function getMeegleSyncSettings(): Promise<MeegleSyncSettings> {
  return apiRequest<MeegleSyncSettings>("/settings/meegle-sync");
}

export function updateMeegleSyncSettings(input: MeegleSyncSettings): Promise<MeegleSyncSettings> {
  return apiRequest<MeegleSyncSettings>("/settings/meegle-sync", {
    method: "PUT",
    body: JSON.stringify(input)
  });
}
