import { Module } from "@nestjs/common";
import { SseEventBusService } from "./sse-event-bus.service";

@Module({
  providers: [SseEventBusService],
  exports: [SseEventBusService]
})
export class SseEventBusModule {}
