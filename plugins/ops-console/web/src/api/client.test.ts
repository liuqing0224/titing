import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "./client";

describe("apiRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns data from the global API response wrapper", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: [{ id: "auto-1", status: "pending" }],
          message: "success"
        })
      }))
    );

    const data = await apiRequest<Array<{ id: string; status: string }>>("/tasks");

    expect(data).toEqual([{ id: "auto-1", status: "pending" }]);
    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/tasks", {
      headers: { "Content-Type": "application/json" }
    });
  });

  it("throws the API message when backend response code is non-zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 400,
          data: null,
          message: "Only pending tasks can be enqueued"
        })
      }))
    );

    await expect(apiRequest("/tasks/auto-1/enqueue", { method: "POST" })).rejects.toThrow(
      "Only pending tasks can be enqueued"
    );
  });

  it("throws backend error message from non-2xx global error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          code: 400,
          data: null,
          message: "Only failed tasks can be retried"
        })
      }))
    );

    await expect(apiRequest("/tasks/auto-1/retry", { method: "POST" })).rejects.toThrow(
      "Only failed tasks can be retried"
    );
  });
});
