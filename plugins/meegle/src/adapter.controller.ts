import { Body, Controller, Get, Post } from "@nestjs/common";
import { AdapterService, SyncResult } from "./adapter.service";
import { MeegleLoginInit, MeegleLoginPollInput, MeegleLoginPollResult } from "./meegle.adapter";
import { RawMeegleTask } from "./task-mapper";

@Controller("adapter/meegle")
export class AdapterController {
  constructor(private readonly adapterService: AdapterService) {}

  @Post("sync")
  sync(): Promise<SyncResult> {
    return this.adapterService.sync();
  }

  @Post("login")
  beginLogin(): Promise<MeegleLoginInit> {
    return this.adapterService.beginLogin();
  }

  @Post("login/poll")
  pollLogin(@Body() body: MeegleLoginPollInput): Promise<MeegleLoginPollResult> {
    return this.adapterService.pollLogin(body);
  }

  @Get("tasks")
  listRawTasks(): Promise<RawMeegleTask[]> {
    return this.adapterService.listRawTasks();
  }
}
