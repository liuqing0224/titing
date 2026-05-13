import { HumanReply, TitingTask } from "@titing/plugin-api";

/**
 * 人工介入：**ingestReply** 在进程内做 `replyId` 去重（与集成侧 `seenReplyIds` 互补，防双投）；
 * **recoverTask** / **markNeedsHuman** 委托 `TitingServices`。
 */
type HumanHost = {
  recoverTask(id: string, operator?: string, reason?: string): Promise<TitingTask>;
  markNeedsHuman(id: string, reason?: string, operator?: string): Promise<TitingTask>;
};

export class HumanInterventionService {
  private readonly seenReplyIds = new Set<string>();

  constructor(private readonly host: HumanHost) {}

  /** @returns 首次见到的 `replyId` 为 `true`，重复为 `false`。 */
  ingestReply(reply: HumanReply): boolean {
    if (this.seenReplyIds.has(reply.replyId)) {
      return false;
    }
    this.seenReplyIds.add(reply.replyId);
    return true;
  }

  recoverTask(taskId: string, operator?: string, reason?: string): Promise<TitingTask> {
    return this.host.recoverTask(taskId, operator, reason);
  }

  markNeedsHuman(taskId: string, reason?: string, operator?: string): Promise<TitingTask> {
    return this.host.markNeedsHuman(taskId, reason, operator);
  }
}
