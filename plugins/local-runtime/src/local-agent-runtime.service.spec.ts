import { LocalAgentRuntimeService } from "./local-agent-runtime.service";

describe("LocalAgentRuntimeService", () => {
  it("streams stdout and stderr chunks while collecting final output", async () => {
    const service = new LocalAgentRuntimeService();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const result = await service.runCommand({} as never, {
      cwd: process.cwd(),
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('hello\\n'); process.stderr.write('warn\\n'); process.stdout.write('done\\n');"
      ],
      options: {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
        timeout: 5000
      },
      onStdoutChunk: (chunk) => {
        stdoutChunks.push(chunk);
      },
      onStderrChunk: (chunk) => {
        stderrChunks.push(chunk);
      }
    });

    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("done");
    expect(result.stderr).toContain("warn");
    expect(stdoutChunks.join("")).toBe(result.stdout);
    expect(stderrChunks.join("")).toBe(result.stderr);
  });
});
