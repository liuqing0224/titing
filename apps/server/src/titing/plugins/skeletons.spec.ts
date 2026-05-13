import { createSkeletonPlugins } from "./skeletons";

describe("plugin skeletons", () => {
  it("provides a minimal executable skeleton for each target plugin kind", async () => {
    const plugins = createSkeletonPlugins();

    expect(plugins.map((plugin) => plugin.kind)).toEqual([
      "task-source",
      "workspace",
      "executor",
      "quality-check",
      "governance",
      "log-store",
      "observability",
      "notification",
      "intelligence",
      "platform"
    ]);

    await expect(Promise.all(plugins.map((plugin) => plugin.health()))).resolves.toEqual(
      Array.from({ length: plugins.length }, () => ({ healthy: true, message: "ok" }))
    );
  });
});
