import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { TASK_RESULT_REPORTER_PLUGINS } from "../plugins/plugin.tokens";
import { TaskResultReporterPlugin } from "../plugins/result-reporter.plugin";
import { Task } from "../tasks/task.entity";
import { CodexRunResult } from "./codex-runner";

@Injectable()
export class ResultReporterService {
  private readonly logger = new Logger(ResultReporterService.name);

  constructor(
    @Optional()
    @Inject(TASK_RESULT_REPORTER_PLUGINS)
    private readonly reporters: TaskResultReporterPlugin[] = []
  ) {}

  async reportSuccess(task: Task, result: CodexRunResult): Promise<void> {
    const reporter = this.findReporter(task);
    if (!reporter) {
      return;
    }
    await reporter.reportSuccess(task, result);
  }

  async reportFailure(task: Task, result: CodexRunResult): Promise<void> {
    const reporter = this.findReporter(task);
    if (!reporter) {
      return;
    }
    await reporter.reportFailure(task, result);
  }

  private findReporter(task: Task): TaskResultReporterPlugin | null {
    const reporter = this.reporters.find((candidate) => candidate.source === task.source);
    if (!reporter) {
      this.logger.debug(`No result reporter registered for task source ${task.source}`);
      return null;
    }
    return reporter;
  }
}
