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
        priority: "high",
        projectKey: null
      },
      {
        id: "MEEGLE-2",
        title: "Fix runner",
        description: null,
        repo: "demo/runner",
        branch: "main",
        instruction: "Fix Codex runner",
        priority: null,
        projectKey: null
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
      "--work-item-id",
      "MEEGLE-1",
      "--content",
      "AutoDev Agent completed task auto-1"
    ]);
  });

  it("falls back to the modern workitem CLI when task subcommands are unavailable", async () => {
    const configService = {
      get: jest.fn((key: string, fallback: string) => {
        if (key === "MEEGLE_PROJECT_KEY") {
          return "demo-project";
        }
        if (key === "MEEGLE_QUERY_MQL") {
          return "SELECT `工作项ID` FROM `Demo`.`需求`";
        }
        if (key === "MEEGLE_DETAIL_FIELDS") {
          return "repo,branch,instruction";
        }
        return fallback;
      })
    };
    const run = jest
      .fn()
      .mockRejectedValueOnce(
        new MeegleCliError("unknown command: task", "meegle", ["task", "list", "--status", "open"], "unknown command")
      )
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: [{ work_item_id: "MEEGLE-9", name: "Runner task" }]
        }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            work_item_id: "MEEGLE-9",
            fields: {
              repo: "demo/repo",
              branch: "main",
              instruction: "Implement runner"
            }
          }
        }),
        stderr: ""
      });
    const adapter = new MeegleAdapter(configService as never, { run });

    const tasks = await adapter.listOpenTasks();

    expect(run).toHaveBeenNthCalledWith(2, "meegle", [
      "workitem",
      "query",
      "--project-key",
      "demo-project",
      "--mql",
      "SELECT `工作项ID` FROM `Demo`.`需求`"
    ]);
    expect(run).toHaveBeenNthCalledWith(3, "meegle", [
      "workitem",
      "get",
      "--work-item-id",
      "MEEGLE-9",
      "--project-key",
      "demo-project",
      "--fields",
      "repo",
      "--fields",
      "branch",
      "--fields",
      "instruction"
    ]);
    expect(tasks).toEqual([
      {
        id: "MEEGLE-9",
        title: "Runner task",
        description: null,
        repo: "demo/repo",
        branch: "main",
        instruction: "Implement runner",
        priority: null,
        projectKey: "demo-project"
      }
    ]);
  });

  it("parses modern workitem get payloads with work_item_attribute", async () => {
    const run = jest
      .fn()
      .mockRejectedValueOnce(
        new MeegleCliError("unknown command: task", "meegle", ["task", "list", "--status", "open"], "unknown command")
      )
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: [{ work_item_id: "MEEGLE-10", name: "Demand title" }]
        }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          work_item_attribute: {
            work_item_id: "MEEGLE-10",
            work_item_name: "Demand title",
            work_item_status: { name: "开发中" },
            owned_project: { simple_name: "demo-project" }
          }
        }),
        stderr: ""
      });
    const configService = {
      get: jest.fn((key: string, fallback: string) => {
        if (key === "MEEGLE_PROJECT_KEY") {
          return "demo-project";
        }
        if (key === "MEEGLE_QUERY_MQL") {
          return "SELECT `工作项ID` FROM `Demo`.`需求`";
        }
        return fallback;
      })
    };
    const adapter = new MeegleAdapter(configService as never, { run });

    const tasks = await adapter.listOpenTasks();

    expect(tasks).toEqual([
      {
        id: "MEEGLE-10",
        title: "Demand title",
        description: null,
        repo: null,
        branch: null,
        instruction: null,
        priority: "开发中",
        projectKey: "demo-project"
      }
    ]);
  });

  it("parses grouped MOQL query payloads returned by meegle workitem query", async () => {
    const configService = {
      get: jest.fn((key: string, fallback: string) => {
        if (key === "MEEGLE_SOURCE_MODE") {
          return "latest_sprint";
        }
        if (key === "MEEGLE_PROJECT_KEY") {
          return "demo-project";
        }
        if (key === "MEEGLE_PROJECT_SCOPE_NAME") {
          return "Demo";
        }
        if (key === "MEEGLE_SPRINT_TYPE_NAME") {
          return "迭代";
        }
        if (key === "MEEGLE_DEMAND_TYPE_NAME") {
          return "需求";
        }
        if (key === "MEEGLE_SPRINT_LINK_FIELD") {
          return "规划迭代";
        }
        if (key === "MEEGLE_NODE_NAME") {
          return "开发中";
        }
        if (key === "MEEGLE_LATEST_SPRINT_DETAIL_FIELDS") {
          return "description";
        }
        return fallback;
      })
    };
    const run = jest
      .fn()
      .mockRejectedValueOnce(
        new MeegleCliError("unknown command: task", "meegle", ["task", "list", "--status", "open"], "unknown command")
      )
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            "1": [
              {
                moql_field_list: [
                  {
                    key: "work_item_id",
                    name: "工作项id",
                    value: { long_value: 6979659808 }
                  },
                  {
                    key: "name",
                    name: "名称",
                    value: { string_value: "95" }
                  },
                  {
                    key: "work_item_status",
                    name: "状态",
                    value: {
                      key_label_value_list: [{ key: "In Progress", label: "进行中" }]
                    }
                  }
                ]
              }
            ]
          }
        }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            "1": [
              {
                moql_field_list: [
                  {
                    key: "work_item_id",
                    name: "工作项id",
                    value: { long_value: 6980235313 }
                  },
                  {
                    key: "name",
                    name: "名称",
                    value: { string_value: "Demand title" }
                  }
                ]
              }
            ]
          }
        }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          work_item_attribute: {
            work_item_id: "6980235313",
            work_item_name: "Demand title",
            work_item_status: { name: "开发中" },
            owned_project: { simple_name: "demo-project" }
          },
          work_item_fields: [
            {
              key: "description",
              value: {
                string_value:
                  "Repo: demo/repo\nBranch: main\nLocalPath: /tmp/demo/repo\n---\nImplement grouped parser"
              }
            }
          ]
        }),
        stderr: ""
      });
    const adapter = new MeegleAdapter(configService as never, { run });

    const tasks = await adapter.listOpenTasks();

    expect(tasks).toEqual([
      {
        id: "6980235313",
        title: "Demand title",
        description:
          "Repo: demo/repo\nBranch: main\nLocalPath: /tmp/demo/repo\n---\nImplement grouped parser",
        repo: "/tmp/demo/repo",
        branch: "main",
        instruction: "Implement grouped parser",
        priority: "开发中",
        projectKey: "demo-project"
      }
    ]);
  });

  it("does not synthesize a timestamp branch from description fallback when branch is missing", async () => {
    const adapter = new MeegleAdapter(createConfigService() as never, { run: jest.fn() });

    const task = (adapter as unknown as {
      applyDescriptionFallback: (task: {
        id: string;
        title: string;
        description: string;
        repo: null;
        branch: null;
        instruction: null;
      }) => {
        repo: string | null;
        branch: string | null;
        instruction: string | null;
      };
    }).applyDescriptionFallback({
      id: "MEEGLE-1",
      title: "Task",
      description: [
        "Repo: demo/repo",
        "Branch: feature/existing-branch",
        "",
        "---",
        "",
        "## 任务目标",
        "实现配置改造"
      ].join("\n"),
      repo: null,
      branch: null,
      instruction: null
    });

    expect(task.repo).toBe("demo/repo");
    expect(task.branch).toBe("feature/existing-branch");
    expect(task.instruction).toContain("实现配置改造");
  });

  it("returns meegle auth status", async () => {
    const run = jest.fn().mockResolvedValue({
      stdout: JSON.stringify({
        authenticated: true,
        host: "project.feishu.cn"
      }),
      stderr: ""
    });
    const adapter = new MeegleAdapter(createConfigService() as never, { run });

    await expect(adapter.getAuthStatus()).resolves.toEqual({
      authenticated: true,
      host: "project.feishu.cn"
    });
    expect(run).toHaveBeenCalledWith("meegle", ["auth", "status"]);
  });

  it("parses meegle auth status from stdout even when the CLI exits non-zero for unauthenticated state", async () => {
    const run = jest.fn().mockRejectedValue(
      new MeegleCliError(
        "not authenticated",
        "meegle",
        ["auth", "status"],
        "",
        JSON.stringify({
          authenticated: false,
          host: "project.feishu.cn"
        })
      )
    );
    const adapter = new MeegleAdapter(createConfigService() as never, { run });

    await expect(adapter.getAuthStatus()).resolves.toEqual({
      authenticated: false,
      host: "project.feishu.cn"
    });
  });

  it("starts device-code login", async () => {
    const run = jest.fn().mockResolvedValue({
      stdout: JSON.stringify({
        client_id: "client",
        device_code: "device",
        expires_in: 1800,
        interval: 5,
        user_code: "ABC-123",
        verification_uri: "https://project.feishu.cn/b/auth/mcp",
        verification_uri_complete: "https://project.feishu.cn/b/auth/mcp?usercode=ABC-123"
      }),
      stderr: ""
    });
    const adapter = new MeegleAdapter(createConfigService() as never, { run });

    await expect(adapter.beginLogin()).resolves.toEqual({
      clientId: "client",
      deviceCode: "device",
      expiresIn: 1800,
      interval: 5,
      userCode: "ABC-123",
      verificationUri: "https://project.feishu.cn/b/auth/mcp",
      verificationUriComplete: "https://project.feishu.cn/b/auth/mcp?usercode=ABC-123"
    });
    expect(run).toHaveBeenCalledWith("meegle", [
      "auth",
      "login",
      "--device-code",
      "--phase",
      "init",
      "--host",
      "project.feishu.cn",
      "--format",
      "json"
    ]);
  });

  it("polls device-code login and returns authenticated state", async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ status: "authorized" }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          authenticated: true,
          host: "project.feishu.cn"
        }),
        stderr: ""
      });
    const adapter = new MeegleAdapter(createConfigService() as never, { run });

    await expect(
      adapter.pollLogin({
        clientId: "client",
        deviceCode: "device",
        interval: 5,
        expiresIn: 600
      })
    ).resolves.toEqual({
      authenticated: true,
      host: "project.feishu.cn"
    });
  });
});
