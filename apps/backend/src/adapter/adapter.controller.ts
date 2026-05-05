import { Controller, Get, Post } from "@nestjs/common";
import { AdapterService, SyncResult } from "./adapter.service";
import { RawMeegleTask } from "./task-mapper";

@Controller("adapter/meegle")
export class AdapterController {
  constructor(private readonly adapterService: AdapterService) {}

  @Post("sync")
  sync(): Promise<SyncResult> {
    return this.adapterService.sync();
  }

  @Get("tasks")
  listRawTasks(): Promise<RawMeegleTask[]> {
    return this.adapterService.listRawTasks();
  }
}
