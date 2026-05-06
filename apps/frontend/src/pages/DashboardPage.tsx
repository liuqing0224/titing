import { beginMeegleLogin, pollMeegleLogin, syncMeegle } from "../api/adapter";
import { Agent, DashboardStats, Task } from "../api/types";
import { AgentCard } from "../components/AgentCard";
import { StatsCards } from "../components/StatsCards";
import { formatShanghaiTime } from "../utils/time";

type DashboardPageProps = {
  stats: DashboardStats | null;
  agents: Agent[];
  tasks: Task[];
  refreshAll: () => Promise<void>;
  onOpenTask: (taskId: string) => void;
};

export function DashboardPage({ stats, agents, tasks, refreshAll, onOpenTask }: DashboardPageProps) {
  const recentTasks = tasks.slice(0, 5);
  const runningTasks = tasks.filter((task) => task.status === "running");
  const failedTasks = tasks.filter((task) => task.status === "failed");

  const handleSync = async () => {
    try {
      const result = await syncMeegle();
      window.alert(
        `sync: created ${result.summary.created}, updated ${result.summary.updated}, failed ${result.summary.failed}, recovered ${result.summary.recovered}`
      );
      await refreshAll();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Meegle login required/i.test(message)) {
        const login = await beginMeegleLogin();
        window.open(login.verificationUriComplete || login.verificationUri, "_blank", "noopener,noreferrer");
        window.alert(`已打开 Meegle 登录页面，系统会自动等待授权完成。验证码：${login.userCode}`);
        const deadline = Date.now() + login.expiresIn * 1000;
        while (Date.now() < deadline) {
          await sleep(login.interval * 1000);
          const status = await pollMeegleLogin({
            clientId: login.clientId,
            deviceCode: login.deviceCode,
            interval: login.interval,
            expiresIn: login.expiresIn
          });
          if (!status.authenticated) {
            continue;
          }

          const result = await syncMeegle();
          window.alert(
            `sync: created ${result.summary.created}, updated ${result.summary.updated}, failed ${result.summary.failed}, recovered ${result.summary.recovered}`
          );
          await refreshAll();
          return;
        }
        window.alert("Meegle 授权等待超时，请重新点击“同步 Meegle”发起登录。");
        return;
      }
      throw error;
    }
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
          <button className="ghost-button" onClick={() => void refreshAll()} type="button">
            刷新面板
          </button>
        </div>
      </section>

      <StatsCards stats={stats} />

      <section className="feature-grid">
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
            <div className="signal-list">
              {runningTasks.slice(0, 3).map((task) => (
                <article className="signal-item" key={task.id}>
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
            <div className="signal-list">
              {failedTasks.slice(0, 3).map((task) => (
                <article className="signal-item" key={task.id}>
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
    </div>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
