import { ConsoleLogger, LogLevel } from "@nestjs/common";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

/**
 * 与默认 ConsoleLogger 相同输出到终端，并追加写入 logs 目录下的文件（无 ANSI 颜色）。
 * 通过 NEST_LOG_TO_FILE=false 可关闭写文件。
 */
export class FileTeeConsoleLogger extends ConsoleLogger {
  private readonly fileStream: WriteStream | null;

  constructor() {
    super();
    if (process.env.NEST_LOG_TO_FILE === "false") {
      this.fileStream = null;
      return;
    }
    const logDir = process.env.NEST_LOG_DIR ?? join(process.cwd(), "logs");
    mkdirSync(logDir, { recursive: true });
    const fileName = process.env.NEST_LOG_FILE ?? "server.log";
    this.fileStream = createWriteStream(join(logDir, fileName), { flags: "a" });
  }

  protected printMessages(
    messages: unknown[],
    context = "",
    logLevel: LogLevel = "log",
    writeStreamType?: "stdout" | "stderr",
    errorStack?: unknown
  ): void {
    super.printMessages(messages, context, logLevel, writeStreamType, errorStack);
    if (!this.fileStream || this.options.json) {
      return;
    }
    for (const message of messages) {
      const line = this.formatPlainLine(message, context, logLevel);
      this.fileStream.write(`${line}\n`);
    }
  }

  protected printStackTrace(stack?: string): void {
    super.printStackTrace(stack ?? "");
    if (stack && this.fileStream && !this.options.json) {
      this.fileStream.write(`${stripAnsi(stack)}\n`);
    }
  }

  private formatPlainLine(message: unknown, context: string, logLevel: LogLevel): string {
    const savedColors = this.options.colors;
    this.options.colors = false;
    try {
      const ctx = context ? `[${context}] ` : "";
      const lvl = logLevel.toUpperCase().padStart(7, " ");
      const body = this.stringifyMessage(message, logLevel);
      const raw = `[${this.options.prefix}] ${process.pid}  - ${this.getTimestamp()}   ${lvl} ${ctx}${body}`;
      return stripAnsi(raw);
    } finally {
      this.options.colors = savedColors;
    }
  }
}
