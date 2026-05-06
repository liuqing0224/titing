import { Agent } from "./agent.entity";
import { DockerAgentService } from "./docker-agent.service";

const createConfigService = (values: Record<string, string>) => ({
  get: jest.fn((key: string, fallback: string) => values[key] ?? fallback)
});

const createAgent = (overrides: Partial<Agent> = {}): Agent =>
  ({
    id: "agent-1",
    containerName: "agent-1",
    containerId: null,
    ...overrides
  }) as Agent;

describe("DockerAgentService", () => {
  it("creates a missing agent container with configured image and workspace mount", async () => {
    const runner = {
      run: jest
        .fn()
        .mockRejectedValueOnce(new Error("No such object"))
        .mockResolvedValueOnce({ stdout: "container-1\n", stderr: "" })
    };
    const service = new DockerAgentService(
      createConfigService({
        DOCKER_BIN: "/usr/bin/docker",
        AGENT_IMAGE: "autodev-agent-runner:local",
        CODEX_WORKDIR: "/tmp/workspaces"
      }) as never,
      runner
    );

    const result = await service.ensureContainer(createAgent());

    expect(runner.run).toHaveBeenNthCalledWith(1, "/usr/bin/docker", [
      "inspect",
      "agent-1"
    ]);
    expect(runner.run).toHaveBeenNthCalledWith(2, "/usr/bin/docker", [
      "run",
      "-d",
      "--name",
      "agent-1",
      "-e",
      "TZ=Asia/Shanghai",
      "-v",
      "/tmp/workspaces:/workspace",
      "autodev-agent-runner:local",
      "sleep",
      "infinity"
    ]);
    expect(result).toEqual({ containerId: "container-1", running: true });
  });

  it("mounts optional host auth and git paths into new agent containers", async () => {
    const runner = {
      run: jest
        .fn()
        .mockRejectedValueOnce(new Error("No such object"))
        .mockResolvedValueOnce({ stdout: "container-2\n", stderr: "" })
    };
    const service = new DockerAgentService(
      createConfigService({
        CODEX_WORKDIR: "/tmp/workspaces",
        HOST_CODEX_HOME: "/Users/l/.codex",
        HOST_GITCONFIG: "/Users/l/.gitconfig",
        HOST_SSH_DIR: "/Users/l/.ssh",
        HOST_PROJECTS_ROOT: "/Users/l/Documents/work/code/demo"
      }) as never,
      runner
    );

    await service.ensureContainer(createAgent({ containerName: "agent-2" }));

    expect(runner.run).toHaveBeenNthCalledWith(2, "/usr/bin/docker", [
      "run",
      "-d",
      "--name",
      "agent-2",
      "-e",
      "TZ=Asia/Shanghai",
      "-v",
      "/tmp/workspaces:/workspace",
      "-v",
      "/Users/l/.codex:/root/.codex",
      "-v",
      "/Users/l/.gitconfig:/root/.gitconfig:ro",
      "-v",
      "/Users/l/.ssh:/root/.ssh:ro",
      "-v",
      "/Users/l/Documents/work/code/demo:/Users/l/Documents/work/code/demo",
      "autodev-agent-runner:local",
      "sleep",
      "infinity"
    ]);
  });

  it("starts an existing stopped container", async () => {
    const runner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              Id: "container-1",
              State: { Running: false },
              Mounts: [{ Source: "/tmp/autodev-agent/workspaces", Destination: "/workspace", RW: true }]
            }
          ]),
          stderr: ""
        })
        .mockResolvedValueOnce({ stdout: "container-1\n", stderr: "" })
    };
    const service = new DockerAgentService(createConfigService({}) as never, runner);

    const result = await service.ensureContainer(createAgent());

    expect(runner.run).toHaveBeenNthCalledWith(2, "/usr/bin/docker", ["start", "agent-1"]);
    expect(result).toEqual({ containerId: "container-1", running: true });
  });

  it("recreates an existing container when required mounts are missing", async () => {
    const runner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              Id: "container-old",
              State: { Running: true },
              Mounts: [{ Source: "/tmp/workspaces", Destination: "/workspace", RW: true }]
            }
          ]),
          stderr: ""
        })
        .mockResolvedValueOnce({ stdout: "agent-2\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "container-new\n", stderr: "" })
    };
    const service = new DockerAgentService(
      createConfigService({
        CODEX_WORKDIR: "/tmp/workspaces",
        HOST_CODEX_HOME: "/Users/l/.codex"
      }) as never,
      runner
    );

    const result = await service.ensureContainer(createAgent({ containerName: "agent-2" }));

    expect(runner.run).toHaveBeenNthCalledWith(2, "/usr/bin/docker", ["rm", "-f", "agent-2"]);
    expect(runner.run).toHaveBeenNthCalledWith(3, "/usr/bin/docker", [
      "run",
      "-d",
      "--name",
      "agent-2",
      "-e",
      "TZ=Asia/Shanghai",
      "-v",
      "/tmp/workspaces:/workspace",
      "-v",
      "/Users/l/.codex:/root/.codex",
      "autodev-agent-runner:local",
      "sleep",
      "infinity"
    ]);
    expect(result).toEqual({ containerId: "container-new", running: true });
  });

  it("restarts an existing container", async () => {
    const runner = {
      run: jest.fn().mockResolvedValue({ stdout: "agent-1\n", stderr: "" })
    };
    const service = new DockerAgentService(createConfigService({}) as never, runner);

    await service.restartContainer(createAgent());

    expect(runner.run).toHaveBeenCalledWith("/usr/bin/docker", ["restart", "agent-1"]);
  });
});
