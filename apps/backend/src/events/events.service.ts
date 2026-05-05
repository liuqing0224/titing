import { Injectable, MessageEvent } from "@nestjs/common";
import { Observable, Subject } from "rxjs";

export type AgentStatusEvent = {
  agentId: string;
  status: string;
  timestamp: string;
};

export type TaskLifecycleEvent = {
  taskId: string;
  status: string;
  agentId?: string | null;
  timestamp: string;
};

@Injectable()
export class EventsService {
  private readonly events$ = new Subject<MessageEvent>();
  private readonly agentStatusEvents: AgentStatusEvent[] = [];
  private readonly taskLifecycleEvents: TaskLifecycleEvent[] = [];

  stream(): Observable<MessageEvent> {
    return this.events$.asObservable();
  }

  publishAgentStatus(agentId: string, status: string): void {
    const event = {
      agentId,
      status,
      timestamp: new Date().toISOString()
    };
    this.agentStatusEvents.push(event);
    this.events$.next({
      type: "agent.status",
      data: event
    });
  }

  publishTaskLifecycle(taskId: string, status: string, agentId?: string | null): void {
    const event = {
      taskId,
      status,
      agentId,
      timestamp: new Date().toISOString()
    };
    this.taskLifecycleEvents.push(event);
    this.events$.next({
      type: "task.lifecycle",
      data: event
    });
  }

  getAgentStatusEvents(): AgentStatusEvent[] {
    return this.agentStatusEvents;
  }

  getTaskLifecycleEvents(): TaskLifecycleEvent[] {
    return this.taskLifecycleEvents;
  }
}
