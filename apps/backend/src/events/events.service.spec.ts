import { MessageEvent } from "@nestjs/common";
import { EventsService } from "./events.service";

describe("EventsService", () => {
  it("streams task lifecycle events in SSE message format", () => {
    const service = new EventsService();
    const messages: MessageEvent[] = [];
    const subscription = service.stream().subscribe((message: MessageEvent) => messages.push(message));

    service.publishTaskLifecycle("auto-1", "running", "agent-1");

    expect(messages[0]).toEqual({
      type: "task.lifecycle",
      data: expect.objectContaining({
        taskId: "auto-1",
        status: "running",
        agentId: "agent-1"
      })
    });
    subscription.unsubscribe();
  });

  it("streams agent status events in SSE message format", () => {
    const service = new EventsService();
    const messages: MessageEvent[] = [];
    const subscription = service.stream().subscribe((message: MessageEvent) => messages.push(message));

    service.publishAgentStatus("agent-1", "idle");

    expect(messages[0]).toEqual({
      type: "agent.status",
      data: expect.objectContaining({
        agentId: "agent-1",
        status: "idle"
      })
    });
    subscription.unsubscribe();
  });

  it("streams meegle login-required events in SSE message format", () => {
    const service = new EventsService();
    const messages: MessageEvent[] = [];
    const subscription = service.stream().subscribe((message: MessageEvent) => messages.push(message));

    service.publishMeegleLoginRequired("https://project.feishu.cn/b/auth/mcp?usercode=ABC-123", "ABC-123");

    expect(messages[0]).toEqual({
      type: "meegle.login_required",
      data: expect.objectContaining({
        verificationUri: "https://project.feishu.cn/b/auth/mcp?usercode=ABC-123",
        userCode: "ABC-123"
      })
    });
    subscription.unsubscribe();
  });
});
