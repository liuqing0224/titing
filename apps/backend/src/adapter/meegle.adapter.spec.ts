import { MeegleAdapter, MeegleCliError } from "./meegle.adapter";

const createConfigService = () => ({
  get: jest.fn((_key: string, fallback: string) => fallback)
});

describe("MeegleAdapter", () => {
  it("lists open tasks and fetches task details for each id", async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          tasks: [{ id: "MEEGLE-1" }, { id: "MEEGLE-2" }]
        }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: "MEEGLE-1",
          title: "Feature: build sync",
          description: "Task description",
          repo: "demo/repo",
          branch: "main",
          instruction: "Implement sync",
          priority: "high"
        }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            id: "MEEGLE-2",
            title: "Fix runner",
            repo: "demo/runner",
            branch: "main",
            instruction: "Fix Codex runner"
          }
        }),
        stderr: ""
      });
    const adapter = new MeegleAdapter(createConfigService() as never, { run });

    const tasks = await adapter.listOpenTasks();

    expect(run).toHaveBeenNthCalledWith(1, "meegle", ["task", "list", "--status", "open"]);
    expect(run).toHaveBeenNthCalledWith(2, "meegle", ["task", "get", "MEEGLE-1"]);
    expect(run).toHaveBeenNthCalledWith(3, "meegle", ["task", "get", "MEEGLE-2"]);
    expect(tasks).toEqual([
      {
        id: "MEEGLE-1",
        title: "Feature: build sync",
        description: "Task description",
        repo: "demo/repo",
        branch: "main",
        instruction: "Implement sync",
        priority: "high"
      },
      {
        id: "MEEGLE-2",
        title: "Fix runner",
        description: null,
        repo: "demo/runner",
        branch: "main",
        instruction: "Fix Codex runner",
        priority: null
      }
    ]);
  });

  it("accepts list output that is a direct array and uses item fields as fallback detail", async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ id: "MEEGLE-1", title: "Fallback title" }]),
        stderr: ""
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: "MEEGLE-1" }),
        stderr: ""
      });
    const adapter = new MeegleAdapter(createConfigService() as never, { run });

    const tasks = await adapter.listOpenTasks();

    expect(tasks[0].title).toBe("Fallback title");
  });

  it("throws MeegleCliError with command context when CLI execution fails", async () => {
    const run = jest.fn().mockRejectedValue(new MeegleCliError("meegle task list failed", "meegle", [
      "task",
      "list",
      "--status",
      "open"
    ]));
    const adapter = new MeegleAdapter(createConfigService() as never, { run });

    await expect(adapter.listOpenTasks()).rejects.toMatchObject({
      name: "MeegleCliError",
      command: "meegle",
      args: ["task", "list", "--status", "open"]
    });
  });

  it("adds comments to Meegle tasks", async () => {
    const run = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const adapter = new MeegleAdapter(createConfigService() as never, { run });

    await adapter.addComment("MEEGLE-1", "AutoDev Agent completed task auto-1");

    expect(run).toHaveBeenCalledWith("meegle", [
      "comment",
      "add",
      "MEEGLE-1",
      "AutoDev Agent completed task auto-1"
    ]);
  });
});
