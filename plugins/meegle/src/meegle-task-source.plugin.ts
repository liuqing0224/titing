import { Injectable } from "@nestjs/common";
import { AuthenticatedTaskSourcePlugin } from "@autodev-agent/plugin-api";
import {
  MeegleAdapter,
  MeegleAuthStatus,
  MeegleLoginInit,
  MeegleLoginPollInput,
  MeegleLoginPollResult
} from "./meegle.adapter";
import { RawMeegleTask } from "./task-mapper";

@Injectable()
export class MeegleTaskSourcePlugin
  implements AuthenticatedTaskSourcePlugin<MeegleLoginInit, MeegleLoginPollInput, MeegleLoginPollResult>
{
  readonly source = "meegle";

  constructor(private readonly meegleAdapter: MeegleAdapter) {}

  listOpenTasks(): Promise<RawMeegleTask[]> {
    return this.meegleAdapter.listOpenTasks();
  }

  getAuthStatus(): Promise<MeegleAuthStatus> {
    return this.meegleAdapter.getAuthStatus();
  }

  beginLogin(): Promise<MeegleLoginInit> {
    return this.meegleAdapter.beginLogin();
  }

  pollLogin(input: MeegleLoginPollInput): Promise<MeegleLoginPollResult> {
    return this.meegleAdapter.pollLogin(input);
  }
}
