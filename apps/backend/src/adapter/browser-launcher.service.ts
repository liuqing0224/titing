import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Injectable } from "@nestjs/common";

const execFileAsync = promisify(execFile);

export type BrowserOpenRunner = {
  run(command: string, args: string[]): Promise<void>;
};

class ExecFileBrowserOpenRunner implements BrowserOpenRunner {
  async run(command: string, args: string[]): Promise<void> {
    await execFileAsync(command, args);
  }
}

@Injectable()
export class BrowserLauncherService {
  private readonly runner: BrowserOpenRunner;

  constructor() {
    this.runner = new ExecFileBrowserOpenRunner();
  }

  async open(url: string): Promise<void> {
    const { command, args } = this.getOpenCommand(url);
    await this.runner.run(command, args);
  }

  private getOpenCommand(url: string): { command: string; args: string[] } {
    if (process.platform === "darwin") {
      return { command: "open", args: [url] };
    }
    if (process.platform === "win32") {
      return { command: "cmd", args: ["/c", "start", "", url] };
    }
    return { command: "xdg-open", args: [url] };
  }
}
