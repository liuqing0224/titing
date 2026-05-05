import { Controller, MessageEvent, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import { EventsService } from "./events.service";

@Controller("events")
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Sse()
  stream(): Observable<MessageEvent> {
    return this.eventsService.stream();
  }
}
