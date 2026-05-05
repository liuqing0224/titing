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
        DOCKER_BIN: "docker",
        AGENT_IMAGE: "autodev-agent-runner:local",
        CODEX_WORKDIR: "/tmp/workspaces"
      }) as never,
      runner
    );

    const result = await service.ensureContainer(createAgent());

    expect(runner.run).toHaveBeenNthCalledWith(1, "docker", [
      "inspect",
      "--format",
      "{{.Id}} {{.State.Running}}",
      "agent-1"
    ]);
    expect(runner.run).toHaveBeenNthCalledWith(2, "docker", [
      "run",
      "-d",
      "--name",
      "agent-1",
      "-v",
      "/tmp/workspaces:/workspace",
      "autodev-agent-runner:local",
      "sleep",
      "infinity"
    ]);
    expect(result).toEqual({ containerId: "container-1", running: true });
  });

  it("starts an existing stopped container", async () => {
    const runner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ stdout: "container-1 false\n", stderr: "" })
        .mockResolvedValueOnce({ stdout: "container-1\n", stderr: "" })
    };
    const service = new DockerAgentService(createConfigService({}) as never, runner);

    const result = await service.ensureContainer(createAgent());

    expect(runner.run).toHaveBeenNthCalledWith(2, "docker", ["start", "agent-1"]);
    expect(result).toEqual({ containerId: "container-1", running: true });
  });

  it("restarts an existing container", async () => {
    const runner = {
      run: jest.fn().mockResolvedValue({ stdout: "agent-1\n", stderr: "" })
    };
    const service = new DockerAgentService(createConfigService({}) as never, runner);

    await service.restartContainer(createAgent());

    expect(runner.run).toHaveBeenCalledWith("docker", ["restart", "agent-1"]);
  });
});
