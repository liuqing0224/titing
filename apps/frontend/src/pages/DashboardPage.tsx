import { beginMeegleLogin, pollMeegleLogin, syncMeegle } from "../api/adapter";
import { Agent, DashboardStats, Task } from "../api/types";
import { AgentCard } from "../components/AgentCard";
import { StatsCards } from "../components/StatsCards";

type DashboardPageProps = {
  stats: DashboardStats | null;
  agents: Agent[];
  tasks: Task[];
  refreshAll: () => Promise<void>;
};

export function DashboardPage({ stats, agents, tasks, refreshAll }: DashboardPageProps) {
  const recentTasks = tasks.slice(0, 5);

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
    <main>
      <div className="row">
        <h2>运维总览</h2>
        <button onClick={handleSync}>同步 Meegle</button>
      </div>
      <StatsCards stats={stats} />
      <section>
        <h2>Agent 概览</h2>
        <div className="grid">
          {agents.slice(0, 2).map((agent) => (
            <AgentCard agent={agent} key={agent.id} />
          ))}
        </div>
      </section>
      <section>
        <h2>最近任务</h2>
        {recentTasks.length === 0 ? <p>暂无任务</p> : recentTasks.map((task) => <p key={task.id}>{task.title}</p>)}
      </section>
    </main>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
