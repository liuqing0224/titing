const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api";

export function connectEvents(refreshAll: () => void): () => void {
  const eventSource = new EventSource(`${API_BASE_URL}/events`);
  eventSource.addEventListener("task.lifecycle", refreshAll);
  eventSource.addEventListener("agent.status", refreshAll);

  return () => eventSource.close();
}
