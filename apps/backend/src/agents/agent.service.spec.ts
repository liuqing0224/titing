import { Agent } from "./agent.entity";
import { AgentService } from "./agent.service";

const createAgent = (overrides: Partial<Agent> = {}): Agent =>
  ({
    id: "agent-1",
    taskId: null,
    containerId: "container-1",
    containerName: "agent-1",
    status: "idle",
    startedAt: new Date("2026-05-01T00:00:00.000Z"),
    heartbeatAt: new Date("2026-05-01T00:00:00.000Z"),
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides
  }) as Agent;

const createRepository = (initialAgents: Agent[] = []) => {
  const store = new Map<string, Agent>();
  for (const agent of initialAgents) {
    store.set(agent.id, agent);
  }

  return {
    count: jest.fn(async () => store.size),
    find: jest.fn(async () => Array.from(store.values())),
    findOne: jest.fn(async ({ where }: { where: Partial<Agent> }) =>
      Array.from(store.values()).find((agent) =>
        Object.entries(where).every(([key, value]) => agent[key as keyof Agent] === value)
      ) ?? null
    ),
    create: jest.fn((input: Partial<Agent>) => input as Agent),
    save: jest.fn(async (agent: Agent) => {
      store.set(agent.id, agent);
      return agent;
    }),
    store
  };
};

const createEventsService = () => ({
  publishAgentStatus: jest.fn()
});

const createDockerAgentService = () => ({
  ensureContainer: jest.fn(async (agent: Agent) => ({
    containerId: `${agent.id}-container`,
    running: true
  })),
  restartContainer: jest.fn(async () => undefined)
});

describe("AgentService", () => {
  it("precreates an idle agent pool up to the configured size", async () => {
    const repository = createRepository();
    const dockerAgentService = createDockerAgentService();
    const service = new AgentService(
      repository as never,
      createEventsService() as never,
      undefined,
      dockerAgentService as never
    );

    await service.ensurePool(2);

    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(Array.from(repository.store.values())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "agent-1", status: "idle", containerName: "agent-1" }),
        expect.objectContaining({ id: "agent-2", status: "idle", containerName: "agent-2" })
      ])
    );
    expect(dockerAgentService.ensureContainer).toHaveBeenCalledTimes(2);
    expect(repository.store.get("agent-1")?.containerId).toBe("agent-1-container");
  });

  it("ensures containers for existing idle agents when refreshing the pool", async () => {
    const repository = createRepository([createAgent({ id: "agent-1", containerId: null })]);
    const dockerAgentService = createDockerAgentService();
    const service = new AgentService(
      repository as never,
      createEventsService() as never,
      undefined,
      dockerAgentService as never
    );

    await service.ensurePool(1);

    expect(dockerAgentService.ensureContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" })
    );
    expect(repository.store.get("agent-1")?.containerId).toBe("agent-1-container");
  });

  it("finds the first idle agent", async () => {
    const repository = createRepository([
      createAgent({ id: "agent-1", status: "running" }),
      createAgent({ id: "agent-2", status: "idle" })
    ]);
    const service = new AgentService(repository as never, createEventsService() as never);

    const agent = await service.findIdleAgent();

    expect(agent?.id).toBe("agent-2");
  });

  it("marks an agent running and publishes status", async () => {
    const repository = createRepository([createAgent()]);
    const eventsService = createEventsService();
    const service = new AgentService(repository as never, eventsService as never);

    const agent = await service.markRunning("agent-1", "auto-1");

    expect(agent.status).toBe("running");
    expect(agent.taskId).toBe("auto-1");
    expect(eventsService.publishAgentStatus).toHaveBeenCalledWith("agent-1", "running");
  });

  it("restores heartbeat on offline agent with task as running instead of idle", async () => {
    const repository = createRepository([
      createAgent({ status: "offline", taskId: "auto-1" })
    ]);
    const eventsService = createEventsService();
    const service = new AgentService(repository as never, eventsService as never);

    const agent = await service.refreshHeartbeat("agent-1");

    expect(agent.status).toBe("running");
    expect(agent.taskId).toBe("auto-1");
    expect(eventsService.publishAgentStatus).toHaveBeenCalledWith("agent-1", "running");
  });

  it("marks agents offline after heartbeat timeout and publishes status", async () => {
    const repository = createRepository([
      createAgent({
        id: "agent-1",
        heartbeatAt: new Date("2026-05-01T00:00:00.000Z"),
        status: "idle"
      }),
      createAgent({
        id: "agent-2",
        heartbeatAt: new Date("2026-05-01T00:01:30.000Z"),
        status: "idle"
      })
    ]);
    const eventsService = createEventsService();
    const service = new AgentService(repository as never, eventsService as never);

    const offlineAgents = await service.detectOfflineAgents(
      60,
      new Date("2026-05-01T00:02:00.000Z")
    );

    expect(offlineAgents.map((agent: Agent) => agent.id)).toEqual(["agent-1"]);
    expect(repository.store.get("agent-1")?.status).toBe("offline");
    expect(eventsService.publishAgentStatus).toHaveBeenCalledWith("agent-1", "offline");
  });
});
