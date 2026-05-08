const BRANCH_PREFIX = "feature";

export function resolveExecutionBranch(branch?: string | null, now = new Date()): string {
  const trimmed = normalizeStoredBranch(branch);
  if (trimmed) {
    return trimmed;
  }

  return `${BRANCH_PREFIX}/${formatBranchTimestamp(now)}`;
}

export function normalizeStoredBranch(branch?: string | null): string {
  return branch?.trim() ?? "";
}

function formatBranchTimestamp(date: Date): string {
  const year = date.getFullYear().toString();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");

  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}
