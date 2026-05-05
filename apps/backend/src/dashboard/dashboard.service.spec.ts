import { DashboardService } from "./dashboard.service";

describe("DashboardService", () => {
  it("returns aggregate task counts grouped by status", async () => {
    const repository = {
      count: jest
        .fn()
        .mockResolvedValueOnce(6)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1)
    };
    const service = new DashboardService(repository as never);

    const stats = await service.getStats();

    expect(stats).toEqual({
      total: 6,
      pending: 1,
      queued: 2,
      running: 1,
      done: 1,
      failed: 1
    });
    expect(repository.count).toHaveBeenCalledWith();
    expect(repository.count).toHaveBeenCalledWith({ where: { status: "pending" } });
    expect(repository.count).toHaveBeenCalledWith({ where: { status: "queued" } });
    expect(repository.count).toHaveBeenCalledWith({ where: { status: "running" } });
    expect(repository.count).toHaveBeenCalledWith({ where: { status: "done" } });
    expect(repository.count).toHaveBeenCalledWith({ where: { status: "failed" } });
  });
});
