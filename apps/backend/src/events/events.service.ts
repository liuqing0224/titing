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

export type MeegleLoginRequiredEvent = {
  verificationUri: string;
  userCode: string;
  timestamp: string;
};

@Injectable()
export class EventsService {
  private readonly events$ = new Subject<MessageEvent>();
  private readonly agentStatusEvents: AgentStatusEvent[] = [];
  private readonly taskLifecycleEvents: TaskLifecycleEvent[] = [];
  private readonly meegleLoginRequiredEvents: MeegleLoginRequiredEvent[] = [];
  private subscriberCount = 0;

  stream(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      this.subscriberCount += 1;
      const subscription = this.events$.subscribe(subscriber);
      return () => {
        this.subscriberCount -= 1;
        subscription.unsubscribe();
      };
    });
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

  publishMeegleLoginRequired(verificationUri: string, userCode: string): void {
    const event = {
      verificationUri,
      userCode,
      timestamp: new Date().toISOString()
    };
    this.meegleLoginRequiredEvents.push(event);
    this.events$.next({
      type: "meegle.login_required",
      data: event
    });
  }

  getAgentStatusEvents(): AgentStatusEvent[] {
    return this.agentStatusEvents;
  }

  getTaskLifecycleEvents(): TaskLifecycleEvent[] {
    return this.taskLifecycleEvents;
  }

  getMeegleLoginRequiredEvents(): MeegleLoginRequiredEvent[] {
    return this.meegleLoginRequiredEvents;
  }

  hasSubscribers(): boolean {
    return this.subscriberCount > 0;
  }
}
