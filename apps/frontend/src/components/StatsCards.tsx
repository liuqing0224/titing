import { DashboardStats } from "../api/types";

type StatsCardsProps = {
  stats: DashboardStats | null;
};

export function StatsCards({ stats }: StatsCardsProps) {
  const values = stats ?? {
    total: 0,
    pending: 0,
    queued: 0,
    running: 0,
    done: 0,
    failed: 0
  };

  return (
    <section className="stats-grid" aria-label="任务统计">
      {Object.entries(values).map(([key, value]) => (
        <article className="card stat-card" key={key}>
          <span className="eyebrow">{key}</span>
          <strong>{value}</strong>
        </article>
      ))}
    </section>
  );
}
