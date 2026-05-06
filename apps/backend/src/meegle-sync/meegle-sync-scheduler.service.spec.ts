import { MeegleSyncSchedulerService } from "./meegle-sync-scheduler.service";

describe("MeegleSyncSchedulerService", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("schedules sync with the configured interval and runs adapter sync", async () => {
    jest.useFakeTimers();
    const adapterService = {
      sync: jest.fn(async () => ({
        summary: { created: 0, updated: 0, failed: 0, recovered: 0, resetToPending: 0 },
        items: []
      }))
    };
    const settingsService = {
      getMeegleSyncSettings: jest.fn(async () => ({ enabled: true, intervalMinutes: 10 }))
    };
    const intervals = new Map<string, NodeJS.Timeout>();
    const schedulerRegistry = {
      addInterval: jest.fn((name: string, interval: NodeJS.Timeout) => {
        intervals.set(name, interval);
      }),
      getInterval: jest.fn((name: string) => {
        const interval = intervals.get(name);
        if (!interval) {
          throw new Error("missing interval");
        }
        return interval;
      }),
      deleteInterval: jest.fn((name: string) => {
        intervals.delete(name);
      })
    };
    const service = new MeegleSyncSchedulerService(
      adapterService as never,
      settingsService as never,
      schedulerRegistry as never
    );

    await service.refreshSchedule();
    await jest.advanceTimersByTimeAsync(600_000);

    expect(schedulerRegistry.addInterval).toHaveBeenCalled();
    expect(adapterService.sync).toHaveBeenCalledTimes(1);
  });

  it("removes the interval when sync is disabled", async () => {
    const adapterService = {
      sync: jest.fn(async () => ({
        summary: { created: 0, updated: 0, failed: 0, recovered: 0, resetToPending: 0 },
        items: []
      }))
    };
    const settingsService = {
      getMeegleSyncSettings: jest.fn(async () => ({ enabled: false, intervalMinutes: 5 }))
    };
    const schedulerRegistry = {
      addInterval: jest.fn(),
      getInterval: jest.fn(() => {
        throw new Error("missing interval");
      }),
      deleteInterval: jest.fn()
    };
    const service = new MeegleSyncSchedulerService(
      adapterService as never,
      settingsService as never,
      schedulerRegistry as never
    );

    await service.refreshSchedule();

    expect(schedulerRegistry.addInterval).not.toHaveBeenCalled();
    expect(adapterService.sync).not.toHaveBeenCalled();
  });
});
