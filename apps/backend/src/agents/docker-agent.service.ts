import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Agent } from "./agent.entity";

const execFileAsync = promisify(execFile);

export type DockerRunResult = {
  stdout: string;
  stderr: string;
};

export type DockerRunner = {
  run(command: string, args: string[]): Promise<DockerRunResult>;
};

export type DockerContainerState = {
  containerId: string;
  running: boolean;
};

class ExecFileDockerRunner implements DockerRunner {
  async run(command: string, args: string[]): Promise<DockerRunResult> {
    return execFileAsync(command, args);
  }
}

@Injectable()
export class DockerAgentService {
  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly dockerRunner: DockerRunner = new ExecFileDockerRunner()
  ) {}

  async ensureContainer(agent: Agent): Promise<DockerContainerState> {
    const dockerBin = this.getDockerBin();
    try {
      const inspected = await this.inspectContainer(dockerBin, agent.containerName);
      if (!inspected.running) {
        await this.dockerRunner.run(dockerBin, ["start", agent.containerName]);
        return { ...inspected, running: true };
      }
      return inspected;
    } catch {
      const args = [
        "run",
        "-d",
        "--name",
        agent.containerName,
        "-v",
        `${this.getWorkspaceRoot()}:/workspace`,
        ...this.getOptionalMountArgs(),
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
  }

  async restartContainer(agent: Agent): Promise<void> {
    await this.dockerRunner.run(this.getDockerBin(), ["restart", agent.containerName]);
  }

  private async inspectContainer(command: string, containerName: string): Promise<DockerContainerState> {
    const { stdout } = await this.dockerRunner.run(command, [
      "inspect",
      "--format",
      "{{.Id}} {{.State.Running}}",
      containerName
    ]);
    const [containerId, running] = stdout.trim().split(/\s+/);
    return {
      containerId,
      running: running === "true"
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

  private getOptionalMountArgs(): string[] {
    const mounts: string[] = [];
    const codexHome = this.configService.get<string>("HOST_CODEX_HOME", "").trim();
    const gitConfig = this.configService.get<string>("HOST_GITCONFIG", "").trim();
    const sshDir = this.configService.get<string>("HOST_SSH_DIR", "").trim();
    const projectsRoot = this.configService.get<string>("HOST_PROJECTS_ROOT", "").trim();

    if (codexHome) {
      mounts.push("-v", `${codexHome}:/root/.codex`);
    }
    if (gitConfig) {
      mounts.push("-v", `${gitConfig}:/root/.gitconfig:ro`);
    }
    if (sshDir) {
      mounts.push("-v", `${sshDir}:/root/.ssh:ro`);
    }
    if (projectsRoot) {
      mounts.push("-v", `${projectsRoot}:${projectsRoot}`);
    }

    return mounts;
  }
}
