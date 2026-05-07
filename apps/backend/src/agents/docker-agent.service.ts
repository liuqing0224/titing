import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AgentRuntimePlugin, RuntimeCommand, RuntimeCommandResult } from "../plugins/agent-runtime.plugin";
import type { ProcessRunOptions } from "../orchestrator/codex-runner";
import { Agent } from "./agent.entity";

const execFileAsync = promisify(execFile);

export type DockerRunResult = {
  stdout: string;
  stderr: string;
};

export type DockerRunner = {
  run(command: string, args: string[], options?: ProcessRunOptions): Promise<DockerRunResult>;
};

export type DockerContainerState = {
  containerId: string;
  running: boolean;
};

type ContainerInspection = DockerContainerState & {
  mounts: Array<{
    source: string;
    destination: string;
    readOnly: boolean;
  }>;
};

class ExecFileDockerRunner implements DockerRunner {
  async run(command: string, args: string[], options?: ProcessRunOptions): Promise<DockerRunResult> {
    const result = await execFileAsync(command, args, options);
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr)
    };
  }
}

@Injectable()
export class DockerAgentService implements AgentRuntimePlugin {
  readonly runtime = "docker";
  private readonly logger = new Logger(DockerAgentService.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly dockerRunner: DockerRunner = new ExecFileDockerRunner()
  ) {}

  async ensureContainer(agent: Agent): Promise<DockerContainerState> {
    const dockerBin = this.getDockerBin();
    const expectedMounts = this.getExpectedMounts();
    this.logExpectedMountSummary(agent, expectedMounts);
    try {
      const inspected = await this.inspectContainer(dockerBin, agent.containerName);
      if (!this.hasExpectedMounts(inspected, expectedMounts)) {
        this.logger.warn(
          `Container ${agent.containerName} is missing required mounts; recreating to refresh auth/config mounts`
        );
        await this.dockerRunner.run(dockerBin, ["rm", "-f", agent.containerName]);
        return this.createContainer(dockerBin, agent, expectedMounts);
      }
      if (!inspected.running) {
        this.logger.log(`Starting existing container ${agent.containerName} with verified mount set`);
        await this.dockerRunner.run(dockerBin, ["start", agent.containerName]);
        return { containerId: inspected.containerId, running: true };
      }
      this.logger.log(`Reusing running container ${agent.containerName} with verified mount set`);
      return { containerId: inspected.containerId, running: inspected.running };
    } catch {
      this.logger.log(`Creating container ${agent.containerName} with configured mount set`);
      return this.createContainer(dockerBin, agent, expectedMounts);
    }
  }

  ensureRuntime(agent: Agent): Promise<DockerContainerState> {
    return this.ensureContainer(agent);
  }

  async runCommand(agent: Agent, command: RuntimeCommand): Promise<RuntimeCommandResult> {
    return this.dockerRunner.run(this.getDockerBin(), [
      "exec",
      "-w",
      command.cwd,
      agent.containerName,
      command.command,
      ...command.args
    ], command.options);
  }

  async restartContainer(agent: Agent): Promise<void> {
    await this.dockerRunner.run(this.getDockerBin(), ["restart", agent.containerName]);
  }

  private async inspectContainer(command: string, containerName: string): Promise<ContainerInspection> {
    const { stdout } = await this.dockerRunner.run(command, [
      "inspect",
      containerName
    ]);
    const inspection = JSON.parse(stdout) as Array<{
      Id: string;
      State: { Running: boolean };
      Mounts?: Array<{
        Source: string;
        Destination: string;
        RW: boolean;
      }>;
    }>;
    const [container] = inspection;
    return {
      containerId: container.Id,
      running: container.State.Running,
      mounts: (container.Mounts ?? []).map((mount) => ({
        source: mount.Source,
        destination: mount.Destination,
        readOnly: !mount.RW
      }))
    };
  }

  private getDockerBin(): string {
    return this.configService.get<string>("DOCKER_BIN", "/usr/bin/docker");
  }

  private getAgentImage(): string {
    return this.configService.get<string>("AGENT_IMAGE", "autodev-agent-runner:local");
  }

  private getWorkspaceRoot(): string {
    return this.configService.get<string>("CODEX_WORKDIR", "/tmp/autodev-agent/workspaces");
  }

  private getContainerTimezone(): string {
    return this.configService.get<string>("TZ", "Asia/Shanghai");
  }

  private async createContainer(
    dockerBin: string,
    agent: Agent,
    mounts: Array<{ source: string; destination: string; readOnly: boolean }>
  ): Promise<DockerContainerState> {
    const args = [
      "run",
      "-d",
      "--name",
      agent.containerName,
      "-e",
      `TZ=${this.getContainerTimezone()}`,
      ...mounts.flatMap((mount) => ["-v", this.toDockerMountArg(mount)]),
      this.getAgentImage(),
      "sleep",
      "infinity"
    ];
    const { stdout } = await this.dockerRunner.run(dockerBin, args);
    return {
      containerId: stdout.trim(),
      running: true
    };
  }

  private getExpectedMounts(): Array<{ source: string; destination: string; readOnly: boolean }> {
    const mounts = [
      {
        source: this.getWorkspaceRoot(),
        destination: "/workspace",
        readOnly: false
      }
    ];
    const codexHome = this.configService.get<string>("HOST_CODEX_HOME", "").trim();
    const gitConfig = this.configService.get<string>("HOST_GITCONFIG", "").trim();
    const sshDir = this.configService.get<string>("HOST_SSH_DIR", "").trim();
    const projectsRoot = this.configService.get<string>("HOST_PROJECTS_ROOT", "").trim();

    if (codexHome) {
      mounts.push({ source: codexHome, destination: "/root/.codex", readOnly: false });
    }
    if (gitConfig) {
      mounts.push({ source: gitConfig, destination: "/root/.gitconfig", readOnly: true });
    }
    if (sshDir) {
      mounts.push({ source: sshDir, destination: "/root/.ssh", readOnly: true });
    }
    if (projectsRoot) {
      mounts.push({ source: projectsRoot, destination: projectsRoot, readOnly: false });
    }

    return mounts;
  }

  private hasExpectedMounts(
    inspection: ContainerInspection,
    expectedMounts: Array<{ source: string; destination: string; readOnly: boolean }>
  ): boolean {
    return expectedMounts.every((expected) =>
      inspection.mounts.some(
        (actual) =>
          actual.source === expected.source &&
          actual.destination === expected.destination &&
          actual.readOnly === expected.readOnly
      )
    );
  }

  private toDockerMountArg(mount: { source: string; destination: string; readOnly: boolean }): string {
    return `${mount.source}:${mount.destination}${mount.readOnly ? ":ro" : ""}`;
  }

  private logExpectedMountSummary(
    agent: Agent,
    mounts: Array<{ source: string; destination: string; readOnly: boolean }>
  ): void {
    const codexMount = mounts.find((mount) => mount.destination === "/root/.codex");
    this.logger.log(
      `Container ${agent.containerName} mount check: codexConfigMounted=${String(Boolean(codexMount))}, mounts=${mounts
        .map((mount) => `${mount.source}->${mount.destination}${mount.readOnly ? ":ro" : ""}`)
        .join(", ")}`
    );
  }
}
