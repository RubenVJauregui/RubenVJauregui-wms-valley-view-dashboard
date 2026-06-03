"use client";

import { useState, useEffect, useCallback } from "react";
import { AuthState } from "@/lib/auth";
import { DockLocation, LoadTaskRecord, fetchDockLocations, fetchLoadTasks, fetchUserNames } from "@/lib/api";
import DockCards from "@/components/DockCards";
import AssignmentHistory from "@/components/AssignmentHistory";

interface DashboardProps {
  auth: AuthState;
  onLogout: () => void;
}

export default function Dashboard({ auth, onLogout }: DashboardProps) {
  const [docks, setDocks] = useState<DockLocation[]>([]);
  const [tasks, setTasks] = useState<LoadTaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [dockData, taskData] = await Promise.all([
        fetchDockLocations(auth),
        fetchLoadTasks(auth),
      ]);
      setDocks(dockData);

      const assigneeIds = [...new Set(taskData.map((t) => t.assigneeUserId).filter(Boolean))];
      const nameMap = await fetchUserNames(auth, assigneeIds);
      const enriched = taskData.map((t) => ({
        ...t,
        assigneeName: nameMap.get(t.assigneeUserId) || t.assigneeUserId,
      }));

      setTasks(enriched);
      setLastRefresh(new Date());
    } catch {
      // silent - data shows empty state
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, [loadData]);

  const occupied = docks.filter((d) => d.dockStatus === "OCCUPIED").length;
  const reserved = docks.filter((d) => d.dockStatus === "RESERVED").length;
  const available = docks.filter((d) => d.dockStatus === "AVAILABLE").length;

  const assigneeCounts = tasks.reduce<Record<string, number>>((acc, t) => {
    const name = t.assigneeName || t.assigneeUserId || "Unassigned";
    acc[name] = (acc[name] || 0) + 1;
    return acc;
  }, {});
  const topAssignees = Object.entries(assigneeCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  const guruTasks = tasks.filter(
    (t) =>
      t.customerName?.toUpperCase().includes("GURU") ||
      t.shipToName?.toUpperCase().includes("GURU")
  );

  return (
    <div className="h-full flex flex-col bg-[var(--color-surface)] overflow-hidden">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-3">
          <svg width="24" height="24" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="6" fill="#3b82f6" />
            <path d="M7 14h4l3-6 4 12 3-6h4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <h1 className="text-base font-bold text-[var(--color-text-primary)] tracking-tight leading-tight">Bay 4 Assignments</h1>
            <p className="text-[11px] text-[var(--color-text-muted)]">Valley View &middot; DOCK50–DOCK72</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {lastRefresh && (
            <span className="text-[11px] text-[var(--color-text-muted)]">
              {lastRefresh.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          <button
            onClick={loadData}
            disabled={loading}
            className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-40"
            aria-label="Refresh data"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24L10 6h6V0l-2.35 2.35z" />
            </svg>
          </button>
          <button
            onClick={onLogout}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Status Summary Bar */}
      <div className="flex-shrink-0 flex items-center gap-6 px-5 py-3 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-occupied)]" />
          <span className="text-xs text-[var(--color-text-secondary)]">Occupied</span>
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{occupied}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-reserved)]" />
          <span className="text-xs text-[var(--color-text-secondary)]">Reserved</span>
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{reserved}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-available)]" />
          <span className="text-xs text-[var(--color-text-secondary)]">Available</span>
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{available}</span>
        </div>
        <div className="ml-auto flex items-center gap-4">
          {guruTasks.length > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--color-accent-dim)] border border-[var(--color-accent)]/30">
              <span className="text-[11px] font-medium text-[var(--color-accent)]">GURU</span>
              <span className="text-xs font-bold text-[var(--color-text-primary)]">{guruTasks.length}</span>
            </div>
          )}
          <div className="text-[11px] text-[var(--color-text-muted)]">
            {tasks.length} tasks today
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Dock Cards */}
        <div className="flex-shrink-0 px-5 py-4">
          <DockCards docks={docks} loading={loading} />
        </div>

        {/* Assignee Distribution */}
        {topAssignees.length > 0 && (
          <div className="flex-shrink-0 px-5 pb-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[11px] text-[var(--color-text-muted)] uppercase tracking-wider">Assignees</span>
              {topAssignees.map(([name, count]) => (
                <div key={name} className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[var(--color-surface-overlay)]">
                  <span className="text-[11px] text-[var(--color-text-secondary)] truncate max-w-[100px]">{name}</span>
                  <span className="text-[11px] font-semibold text-[var(--color-text-primary)]">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Assignment History */}
        <div className="flex-1 overflow-hidden border-t border-[var(--color-border-subtle)]">
          <AssignmentHistory tasks={tasks} loading={loading} />
        </div>
      </div>
    </div>
  );
}
