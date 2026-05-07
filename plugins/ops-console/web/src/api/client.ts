export type ApiResponse<T> = {
  code: number;
  data: T;
  message: string;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api";

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers
    }
  });

  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok) {
    throw new Error(payload.message || `HTTP ${response.status}`);
  }

  if (payload.code !== 0) {
    throw new Error(payload.message);
  }

  return payload.data;
}
