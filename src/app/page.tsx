"use client";

const DOCKS: Array<{ name: string; status: "OCCUPIED" | "RESERVED" | "AVAILABLE" }> = [
  { name: "DOCK50", status: "AVAILABLE" },
  { name: "DOCK51", status: "OCCUPIED" },
  { name: "DOCK52", status: "OCCUPIED" },
  { name: "DOCK53", status: "OCCUPIED" },
  { name: "DOCK54", status: "RESERVED" },
  { name: "DOCK55", status: "AVAILABLE" },
  { name: "DOCK56", status: "AVAILABLE" },
  { name: "DOCK57", status: "RESERVED" },
  { name: "DOCK58", status: "AVAILABLE" },
  { name: "DOCK59", status: "AVAILABLE" },
  { name: "DOCK60", status: "AVAILABLE" },
  { name: "DOCK61", status: "AVAILABLE" },
  { name: "DOCK62", status: "AVAILABLE" },
  { name: "DOCK63", status: "OCCUPIED" },
  { name: "DOCK64", status: "AVAILABLE" },
  { name: "DOCK65", status: "AVAILABLE" },
  { name: "DOCK66", status: "AVAILABLE" },
  { name: "DOCK67", status: "AVAILABLE" },
  { name: "DOCK68", status: "AVAILABLE" },
  { name: "DOCK69", status: "AVAILABLE" },
  { name: "DOCK70", status: "AVAILABLE" },
  { name: "DOCK71", status: "AVAILABLE" },
  { name: "DOCK72", status: "OCCUPIED" },
];


interface GrazaRow {
  planId: string;
  planType: "Batch" | "Wave";
  orderId: string;
  assignee: string;
  status: "BUILDING" | "RELEASED" | "COMPLETED";
  notes: string;
}

const GRAZA_ROWS: GrazaRow[] = [];

interface HistoryRow {
  dock: string;
  taskId: string;
  assignee: string;
  customer: string;
  dn: string;
  pieces: string;
  status: "IN_PROGRESS" | "NEW" | "CLOSED";
}

const HISTORY: HistoryRow[] = [
  { dock: "DOCK51", taskId: "TASK-5281858", assignee: "ARNULFO MUNGUIA", customer: "GURUNANDA, LLC", dn: "DN-3190540", pieces: "—", status: "IN_PROGRESS" },
  { dock: "DOCK51", taskId: "TASK-5281858", assignee: "ARNULFO MUNGUIA", customer: "GURUNANDA, LLC", dn: "DN-3190269", pieces: "—", status: "IN_PROGRESS" },
  { dock: "DOCK51", taskId: "TASK-5281858", assignee: "ARNULFO MUNGUIA", customer: "GURUNANDA, LLC", dn: "DN-3193451", pieces: "—", status: "IN_PROGRESS" },
  { dock: "DOCK52", taskId: "TASK-5282260", assignee: "George LC Brown", customer: "GURUNANDA, LLC", dn: "DN-3190484", pieces: "—", status: "IN_PROGRESS" },
  { dock: "DOCK52", taskId: "TASK-5282260", assignee: "George LC Brown", customer: "GURUNANDA, LLC", dn: "DN-3190180", pieces: "—", status: "IN_PROGRESS" },
  { dock: "DOCK52", taskId: "TASK-5281747", assignee: "ARNULFO MUNGUIA", customer: "GURUNANDA, LLC", dn: "DN-3190424", pieces: "—", status: "CLOSED" },
  { dock: "DOCK53", taskId: "TASK-5282315", assignee: "ARNULFO MUNGUIA", customer: "GURUNANDA, LLC", dn: "DN-3192751", pieces: "—", status: "IN_PROGRESS" },
  { dock: "DOCK53", taskId: "TASK-5282315", assignee: "ARNULFO MUNGUIA", customer: "GURUNANDA, LLC", dn: "DN-3193700", pieces: "—", status: "IN_PROGRESS" },
  { dock: "DOCK53", taskId: "TASK-5282315", assignee: "ARNULFO MUNGUIA", customer: "GURUNANDA, LLC", dn: "DN-3193631", pieces: "—", status: "IN_PROGRESS" },
  { dock: "DOCK53", taskId: "TASK-5280242", assignee: "LUIS VELAZQUEZ", customer: "GURUNANDA, LLC", dn: "DN-3189539", pieces: "—", status: "CLOSED" },
  { dock: "DOCK54", taskId: "TASK-5282323", assignee: "ARNULFO MUNGUIA", customer: "GURUNANDA, LLC", dn: "DN-3192740", pieces: "—", status: "NEW" },
  { dock: "DOCK54", taskId: "TASK-5282323", assignee: "ARNULFO MUNGUIA", customer: "GURUNANDA, LLC", dn: "DN-3193409", pieces: "—", status: "NEW" },
];

const ASSIGNEES = [
  { name: "ARNULFO MUNGUIA", count: 4 },
  { name: "George LC Brown", count: 1 },
  { name: "LUIS VELAZQUEZ", count: 1 },
  { name: "molvera", count: GRAZA_ROWS.length },
];

export default function Home() {
  const occupied = DOCKS.filter((d) => d.status === "OCCUPIED").length;
  const reserved = DOCKS.filter((d) => d.status === "RESERVED").length;
  const available = DOCKS.filter((d) => d.status === "AVAILABLE").length;

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

  const statusBadge = (status: string) => {
    switch (status) {
      case "IN_PROGRESS":
        return "bg-[var(--color-accent-dim)] text-[var(--color-accent)] border border-[var(--color-accent)]/30";
      case "NEW":
        return "bg-[var(--color-warning-dim)] text-[var(--color-warning)] border border-[var(--color-warning)]/30";
      case "CLOSED":
        return "bg-[var(--color-surface-overlay)] text-[var(--color-text-muted)] border border-[var(--color-border)]";
      default:
        return "bg-[var(--color-surface-overlay)] text-[var(--color-text-secondary)] border border-[var(--color-border)]";
    }
  };

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
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--color-accent-dim)] border border-[var(--color-accent)]/30">
            <span className="text-[11px] font-medium text-[var(--color-accent)]">GURU</span>
            <span className="text-xs font-bold text-[var(--color-text-primary)]">6</span>
          </div>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            6 outbound &middot; 5 inbound
          </span>
        </div>
      </header>

      {/* Status Summary */}
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
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-[var(--color-text-muted)] uppercase tracking-wider">Assignees</span>
          {ASSIGNEES.map((a) => (
            <div key={a.name} className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[var(--color-surface-overlay)]">
              <span className="text-[11px] text-[var(--color-text-secondary)]">{a.name}</span>
              <span className="text-[11px] font-semibold text-[var(--color-text-primary)]">{a.count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Dock Strip */}
      <div className="flex-shrink-0 px-5 py-3">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {DOCKS.map((dock) => (
            <div
              key={dock.name}
              className={`flex-shrink-0 flex flex-col items-center justify-center w-[52px] h-[44px] rounded-md border ${statusColor(dock.status)}`}
            >
              <span className="text-[10px] font-bold leading-tight">
                {dock.name.replace("DOCK", "")}
              </span>
              <span className="text-[8px] opacity-70 uppercase leading-tight">
                {dock.status === "OCCUPIED" ? "OCC" : dock.status === "RESERVED" ? "RSV" : "AVL"}
              </span>
            </div>
          ))}
        </div>
      </div>


      {/* Team 2 Auto Assign - Graza */}
      <div className="flex-shrink-0 px-5 py-3 border-t border-[var(--color-border-subtle)]">
        <div className="flex items-center justify-between mb-2.5">
          <div>
            <h2 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Team 2 Auto Assign — Graza</h2>
            <p className="text-[11px] text-[var(--color-text-muted)]">Confirmed WISE search: 0 eligible orders · 0 batches · 0 waves · 0 orders assigned to molvera</p>
          </div>
          <span className="text-[11px] text-[var(--color-text-muted)]">No plans created</span>
        </div>
        <div className="max-h-[180px] overflow-auto rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-[var(--color-surface)]">
              <tr className="border-b border-[var(--color-border-subtle)]">
                <th className="p-2 text-[10px] font-medium text-[var(--color-text-muted)] uppercase">Order / DN</th>
                <th className="p-2 text-[10px] font-medium text-[var(--color-text-muted)] uppercase">Customer</th>
                <th className="p-2 text-[10px] font-medium text-[var(--color-text-muted)] uppercase">Plan</th>
                <th className="p-2 text-[10px] font-medium text-[var(--color-text-muted)] uppercase">Type</th>
                <th className="p-2 text-[10px] font-medium text-[var(--color-text-muted)] uppercase">Assignee</th>
                <th className="p-2 text-[10px] font-medium text-[var(--color-text-muted)] uppercase">Status</th>
                <th className="p-2 text-[10px] font-medium text-[var(--color-text-muted)] uppercase">Notes</th>
              </tr>
            </thead>
            <tbody>
              {GRAZA_ROWS.map((row) => (
                <tr key={`${row.planId}-${row.orderId}`} className="border-b border-[var(--color-border-subtle)]/50">
                  <td className="p-2 text-xs font-mono text-[var(--color-text-primary)]">{row.orderId}</td>
                  <td className="p-2 text-xs text-[var(--color-text-secondary)]">Drupley Inc / DBA Graza</td>
                  <td className="p-2 text-xs font-mono text-[var(--color-text-primary)]">{row.planId}</td>
                  <td className="p-2 text-xs text-[var(--color-text-secondary)]">{row.planType}</td>
                  <td className="p-2 text-xs text-[var(--color-text-secondary)]">{row.assignee}</td>
                  <td className="p-2"><span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-medium uppercase ${statusBadge(row.status)}`}>{row.status}</span></td>
                  <td className="p-2 text-xs text-[var(--color-text-secondary)]">{row.notes}</td>
                </tr>
              ))}

              {GRAZA_ROWS.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-3 text-xs text-[var(--color-text-muted)]">No current Drupley Inc / DBA Graza dropship orders matched import/open/committed status. No batches or waves were created.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* Assignment History Today */}
      <div className="flex-1 flex flex-col overflow-hidden border-t border-[var(--color-border-subtle)]">
        <div className="flex-shrink-0 px-5 py-2.5 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
            Assignment History Today
          </h2>
          <span className="text-[11px] text-[var(--color-text-muted)]">{HISTORY.length} records</span>
        </div>

        <div className="flex-1 overflow-y-auto px-5">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-[var(--color-surface)]">
              <tr className="border-b border-[var(--color-border-subtle)]">
                <th className="pb-2 pr-3 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">DN</th>
                <th className="pb-2 pr-3 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Customer</th>
                <th className="pb-2 pr-3 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Pieces</th>
                <th className="pb-2 pr-3 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Assignee</th>
                <th className="pb-2 text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody>
              {HISTORY.map((row, i) => (
                <tr
                  key={`${row.taskId}-${row.dn}-${i}`}
                  className="border-b border-[var(--color-border-subtle)]/50 hover:bg-[var(--color-surface-raised)] transition-colors"
                >
                  <td className="py-2 pr-3 text-xs font-mono text-[var(--color-text-primary)] whitespace-nowrap">
                    {row.dn}
                  </td>
                  <td className="py-2 pr-3 text-xs text-[var(--color-text-secondary)]">
                    {row.customer}
                  </td>
                  <td className="py-2 pr-3 text-xs text-[var(--color-text-secondary)] tabular-nums">
                    {row.pieces}
                  </td>
                  <td className="py-2 pr-3 text-xs text-[var(--color-text-secondary)]">
                    {row.assignee}
                  </td>
                  <td className="py-2">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-medium uppercase ${statusBadge(row.status)}`}>
                      {row.status === "IN_PROGRESS" ? "Active" : row.status === "NEW" ? "New" : "Done"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
