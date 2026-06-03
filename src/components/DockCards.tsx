"use client";

import { DockLocation } from "@/lib/api";

interface DockCardsProps {
  docks: DockLocation[];
  loading: boolean;
}

export default function DockCards({ docks, loading }: DockCardsProps) {
  if (loading && docks.length === 0) {
    return (
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {Array.from({ length: 23 }).map((_, i) => (
          <div
            key={i}
            className="flex-shrink-0 w-[52px] h-[44px] rounded-md bg-[var(--color-surface-overlay)] animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (docks.length === 0) {
    return (
      <div className="text-xs text-[var(--color-text-muted)] py-2">No dock data available</div>
    );
  }

  const statusColor = (status: string) => {
    switch (status) {
      case "OCCUPIED":
        return "bg-[var(--color-occupied)]/15 border-[var(--color-occupied)]/40 text-[var(--color-occupied)]";
      case "RESERVED":
        return "bg-[var(--color-reserved)]/15 border-[var(--color-reserved)]/40 text-[var(--color-reserved)]";
      default:
        return "bg-[var(--color-available)]/10 border-[var(--color-available)]/25 text-[var(--color-available)]";
    }
  };

  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1">
      {docks.map((dock) => (
        <div
          key={dock.id}
          className={`flex-shrink-0 flex flex-col items-center justify-center w-[52px] h-[44px] rounded-md border ${statusColor(dock.dockStatus)} transition-all`}
        >
          <span className="text-[10px] font-bold leading-tight">
            {dock.name.replace("DOCK", "")}
          </span>
          <span className="text-[8px] opacity-70 uppercase leading-tight">
            {dock.dockStatus === "OCCUPIED" ? "OCC" : dock.dockStatus === "RESERVED" ? "RSV" : "AVL"}
          </span>
        </div>
      ))}
    </div>
  );
}
