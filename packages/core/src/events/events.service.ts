import { Inject, Injectable } from "@nestjs/common";
import {
  AgentStatusEvent,
  ExecutionLogEvent,
  MeegleLoginRequiredEvent,
  TaskLifecycleEvent
} from "@autodev-agent/plugin-api";
import { EventBusPlugin } from "../plugins/event-bus.plugin";
import { EVENT_BUS_PLUGIN } from "../plugins/plugin.tokens";

@Injectable()
export class EventsService {
  constructor(
    @Inject(EVENT_BUS_PLUGIN)
    private readonly eventBus: EventBusPlugin
  ) {}

  stream() {
    return this.eventBus.stream();
  }

  publishAgentStatus(agentId: string, status: string): void {
    this.eventBus.publishAgentStatus(agentId, status);
  }

  publishTaskLifecycle(taskId: string, status: string, agentId?: string | null): void {
    this.eventBus.publishTaskLifecycle(taskId, status, agentId);
  }

  publishExecutionLog(logId: string, taskId: string, status: string, agentId?: string | null): void {
    this.eventBus.publishExecutionLog(logId, taskId, status, agentId);
  }

  publishMeegleLoginRequired(verificationUri: string, userCode: string): void {
    this.eventBus.publishMeegleLoginRequired(verificationUri, userCode);
  }

  getAgentStatusEvents(): AgentStatusEvent[] {
    return this.eventBus.getAgentStatusEvents();
  }

  getTaskLifecycleEvents(): TaskLifecycleEvent[] {
    return this.eventBus.getTaskLifecycleEvents();
  }

  getExecutionLogEvents(): ExecutionLogEvent[] {
    return this.eventBus.getExecutionLogEvents();
  }

  getMeegleLoginRequiredEvents(): MeegleLoginRequiredEvent[] {
    return this.eventBus.getMeegleLoginRequiredEvents();
  }

  hasSubscribers(): boolean {
    return this.eventBus.hasSubscribers();
  }
}
