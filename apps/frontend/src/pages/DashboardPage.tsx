import { useEffect, useState } from "react";
import { syncMeegle } from "../api/adapter";
import { Agent, DashboardStats, MeegleLoginState, MeegleSyncSettings, Task } from "../api/types";
import { AgentCard } from "../components/AgentCard";
import { StatsCards } from "../components/StatsCards";
import { formatShanghaiTime } from "../utils/time";

type DashboardPageProps = {
  stats: DashboardStats | null;
  agents: Agent[];
  tasks: Task[];
  meegleSyncSettings: MeegleSyncSettings | null;
  meegleLoginState: MeegleLoginState | null;
  refreshAll: () => Promise<void>;
  onSaveMeegleSyncSettings: (input: MeegleSyncSettings) => Promise<void>;
  onOpenTask: (taskId: string) => void;
};

export function DashboardPage({
  stats,
  agents,
  tasks,
  meegleSyncSettings,
  meegleLoginState,
  refreshAll,
  onSaveMeegleSyncSettings,
  onOpenTask
}: DashboardPageProps) {
  const recentTasks = tasks.slice(0, 5);
  const runningTasks = tasks.filter((task) => task.status === "running");
  const failedTasks = tasks.filter((task) => task.status === "failed");
  const [enabled, setEnabled] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState("5");

  useEffect(() => {
    if (!meegleSyncSettings) {
      return;
    }
    setEnabled(meegleSyncSettings.enabled);
    setIntervalMinutes(String(meegleSyncSettings.intervalMinutes));
  }, [meegleSyncSettings]);

  const handleSync = async () => {
    try {
      const result = await syncMeegle();
      window.alert(
        `sync: created ${result.summary.created}, updated ${result.summary.updated}, failed ${result.summary.failed}, recovered ${result.summary.recovered}`
      );
      await refreshAll();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(message);
    }
  };

  const handleSaveSettings = async () => {
    await onSaveMeegleSyncSettings({
      enabled,
      intervalMinutes: Number(intervalMinutes)
    });
    window.alert("Meegle 自动同步配置已保存并生效。");
  };

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">OPERATIONS OVERVIEW</p>
          <h3>运维总览</h3>
          <p className="hero-copy">
            先看正在执行的任务，再看失败堆积和空闲容量。界面默认把注意力放在系统节奏，而不是单个表单。
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={handleSync} type="button">
            同步 Meegle
          </button>
        </div>
      </section>

      {meegleLoginState?.browserPending && meegleLoginState.verificationUri ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">LOGIN REQUIRED</p>
              <h3>Meegle 需要重新登录</h3>
            </div>
            <span className="terminal-chip">browser pending</span>
          </div>
          <div className="settings-actions">
            <p className="muted-copy">
              自动打开浏览器可能被拦截，或事件发生时前端尚未连接。请直接点击下面的链接完成登录。
              {meegleLoginState.userCode ? ` 验证码：${meegleLoginState.userCode}` : ""}
            </p>
            <a
              className="primary-button"
              href={meegleLoginState.verificationUri}
              rel="noopener noreferrer"
              target="_blank"
            >
              打开 Meegle 登录页
            </a>
          </div>
        </section>
      ) : null}

      <StatsCards stats={stats} />

      <div className="layout-split">
        <div className="layout-main">
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">SYNC CONTROL</p>
                <h3>Meegle 自动同步</h3>
              </div>
              <span className="terminal-chip">
                {meegleSyncSettings?.enabled ? `every ${meegleSyncSettings.intervalMinutes}m` : "disabled"}
              </span>
            </div>
            <div className="settings-grid">
              <label className="field checkbox-field">
                <span>enabled</span>
                <input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />
              </label>
              <label className="field">
                <span>interval minutes</span>
                <input
                  min={1}
                  onChange={(event) => setIntervalMinutes(event.target.value)}
                  type="number"
                  value={intervalMinutes}
                />
              </label>
              <div className="settings-actions">
                <p className="muted-copy">未登录时前端会尝试打开登录页；如果被拦截，控制台会保留可手动点击的登录入口。</p>
                <button className="ghost-button" onClick={() => void handleSaveSettings()} type="button">
                  保存自动同步配置
                </button>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">QUEUE TAIL</p>
                <h3>最近任务</h3>
              </div>
              <span className="terminal-chip">{recentTasks.length} shown</span>
            </div>
            {recentTasks.length === 0 ? (
              <p className="muted-copy">暂无任务。</p>
            ) : (
              <div className="signal-list">
                {recentTasks.map((task) => (
                  <article className="signal-item" key={task.id}>
                    <button className="signal-link" onClick={() => onOpenTask(task.id)} type="button">
                      <strong>{task.title}</strong>
                      <p>
                        ID {task.id} · {task.priority} priority · {formatShanghaiTime(task.createdAt)}
                      </p>
                      <p>
                        {task.repo} · {task.branch}
                      </p>
                    </button>
                    <span className={`badge ${task.status}`}>{task.status}</span>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">AGENT CAPACITY</p>
                <h3>Agent 概览</h3>
              </div>
              <span className="terminal-chip">{agents.length} online slots</span>
            </div>
            <div className="grid">
              {agents.slice(0, 4).map((agent) => (
                <AgentCard agent={agent} key={agent.id} />
              ))}
            </div>
          </section>
        </div>

        <aside className="layout-side">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">FLOW WATCH</p>
                <h3>当前执行流</h3>
              </div>
              <span className="terminal-chip">{runningTasks.length} running</span>
            </div>
            {runningTasks.length === 0 ? (
              <p className="muted-copy">当前没有运行中的任务，Agent 池处于可接单状态。</p>
            ) : (
              <div className="signal-list compact">
                {runningTasks.slice(0, 4).map((task) => (
                  <article className="signal-item stacked" key={task.id}>
                    <div>
                      <strong>{task.title}</strong>
                      <p>
                        {task.repo} · {task.branch}
                      </p>
                    </div>
                    <span className={`badge ${task.status}`}>{task.status}</span>
                  </article>
                ))}
              </div>
            )}
          </article>

          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">RISK SURFACE</p>
                <h3>失败与待处理</h3>
              </div>
              <span className="terminal-chip">{failedTasks.length} failed</span>
            </div>
            {failedTasks.length === 0 ? (
              <p className="muted-copy">最近没有失败任务，工作流没有明显阻塞点。</p>
            ) : (
              <div className="signal-list compact">
                {failedTasks.slice(0, 4).map((task) => (
                  <article className="signal-item stacked" key={task.id}>
                    <div>
                      <strong>{task.title}</strong>
                      <p>{task.description ?? "无描述"}</p>
                    </div>
                    <span className={`badge ${task.status}`}>{task.status}</span>
                  </article>
                ))}
              </div>
            )}
          </article>
        </aside>
      </div>
    </div>
  );
}
