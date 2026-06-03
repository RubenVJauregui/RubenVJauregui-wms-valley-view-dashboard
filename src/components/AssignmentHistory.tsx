"use client";

import { LoadTaskRecord } from "@/lib/api";

interface AssignmentHistoryProps {
  tasks: LoadTaskRecord[];
  loading: boolean;
}

export default function AssignmentHistory({ tasks, loading }: AssignmentHistoryProps) {
  if (loading && tasks.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-xs text-[var(--color-text-muted)]">Loading assignments...</div>
      </div>
    );
  }

  const statusBadge = (status: string) => {
    switch (status) {
      case "IN_PROGRESS":
        return "bg-[var(--color-accent-dim)] text-[var(--color-accent)] border border-[var(--color-accent)]/30";
      case "NEW":
        return "bg-[var(--color-warning-dim)] text-[var(--color-warning)] border border-[var(--color-warning)]/30";
      case "CLOSED":
        return "bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] border border-[var(--color-border)]";
      case "CANCELLED":
        return "bg-[var(--color-danger-dim)] text-[var(--color-danger)] border border-[var(--color-danger)]/30";
      default:
        return "bg-[var(--color-surface-overlay)] text-[var(--color-text-secondary)] border border-[var(--color-border)]";
    }
  };

  const sorted = [...tasks].sort((a, b) => {
    const statusOrder: Record<string, number> = { IN_PROGRESS: 0, NEW: 1, CLOSED: 2, CANCELLED: 3 };
    const sa = statusOrder[a.status] ?? 2;
    const sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    return b.createdTime.localeCompare(a.createdTime);
  });

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-5 py-2.5 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
          Assignment History Today
        </h2>
        <span className="text-[11px] text-[var(--color-text-muted)]">{tasks.length} records</span>
      </div>

      <div className="flex-1 overflow-y-auto px-5">
        {tasks.length === 0 ? (
          <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">
            No Bay 4 assignments today
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-[var(--color-surface)]">
              <tr className="border-b border-[var(--color-border-subtle)]">
                <th className="pb-2 pr-3 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">DN</th>
                <th className="pb-2 pr-3 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Customer</th>
                <th className="pb-2 pr-3 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Pieces</th>
                <th className="pb-2 pr-3 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Assignee</th>
                <th className="pb-2 pr-3 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Dock</th>
                <th className="pb-2 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((task) => (
                <tr
                  key={task.id}
                  className="border-b border-[var(--color-border-subtle)]/50 hover:bg-[var(--color-surface-raised)] transition-colors"
                >
                  <td className="py-2 pr-3 text-xs font-mono text-[var(--color-text-primary)] whitespace-nowrap">
                    {task.loadNo || "—"}
                  </td>
                  <td className="py-2 pr-3 text-xs text-[var(--color-text-secondary)] max-w-[200px] truncate">
                    {task.shipToName || task.customerName || "—"}
                  </td>
                  <td className="py-2 pr-3 text-xs text-[var(--color-text-secondary)] tabular-nums">
                    {task.pieces || "—"}
                  </td>
                  <td className="py-2 pr-3 text-xs text-[var(--color-text-secondary)] max-w-[120px] truncate">
                    {task.assigneeName || "—"}
                  </td>
                  <td className="py-2 pr-3 text-[11px] font-mono text-[var(--color-text-muted)]">
                    {task.dockName || "—"}
                  </td>
                  <td className="py-2">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-medium uppercase ${statusBadge(task.status)}`}>
                      {task.status === "IN_PROGRESS" ? "Active" : task.status === "NEW" ? "New" : task.status === "CLOSED" ? "Done" : task.status.toLowerCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
