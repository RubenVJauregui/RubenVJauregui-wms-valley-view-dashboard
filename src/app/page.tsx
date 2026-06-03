export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  identity: { user_id: string; user_name: string; tenant_id: string };
  facilities: { id: string; name: string; timeZone: string }[];
  defaultFacility: { id: string; name: string } | null;
}

export interface Facility {
  id: string;
  name: string;
  timeZone: string;
}

export default function Home() {
  const assignees = ["Gterrazas", "vgutierrez", "maperez", "diasorto"];
  const tabs = [
    "B.P. Workload",
    "Bay 1",
    "Bay 2",
    "Bay 3",
    "Bay 2 LTL",
    "Bay 4",
    "Bay 5",
    "Crate & Barrel",
    "Night Shift",
    "Rear Guard Shack",
    "Front Guard Shack",
    "Bay 2 Auto Assign",
  ];

  return (
    <main className="bay2-screen">
      <nav className="bay2-tabs">
        {tabs.map((tab) => (
          <button key={tab} className={tab === "Bay 2 Auto Assign" ? "active" : ""}>
            {tab}
          </button>
        ))}
      </nav>

      <section className="bay2-shell">
        <header className="bay2-hero">
          <div>
            <h1>Bay 2 Auto Assign</h1>
            <p>Live WISE assignment reads · Last refreshed 05/27/2026, 09:14:50 PDT</p>
          </div>
          <div className="bay2-actions">
            <button>✣ Auto Suggest</button>
            <button>⊙ Auto Assign</button>
            <button className="active">⌁ Autonomous</button>
            <button className="refresh">⟳ Refresh now</button>
          </div>
        </header>

        <div className="bay2-kpis">
          <article><span>Total Assignments</span><strong>0</strong><i>⌁</i></article>
          <article><span>Active Assignees</span><strong>0</strong><i>⌘</i></article>
          <article><span>Tickets Created</span><strong>0</strong><i>□</i></article>
          <article><span>Tickets Resolved</span><strong>0</strong><i>□</i></article>
        </div>

        <section className="bay2-card bay2-active-card">
          <div className="bay2-card-head">
            <div>
              <h2>Active Assigned Tasks</h2>
              <p>Today only. Active queue includes assigned and unassigned receive/load work.</p>
            </div>
            <label className="bay2-search"><span>⌕</span><input placeholder="Search ET, RN, DN, assignee, door..." /></label>
          </div>
          <div className="bay2-chips">
            <span>Today only</span><span>0 tasks in queue</span><span>Autonomous default</span>
          </div>
          <table className="bay2-table">
            <thead><tr><th>Task Number</th><th>Assignee</th><th>Started</th><th>Working Time</th><th>Pieces</th><th>DN</th><th>Ticket</th></tr></thead>
            <tbody><tr><td colSpan={7} className="empty">No active assignments were returned in the latest WISE read.</td></tr></tbody>
          </table>
        </section>

        <section className="bay2-card bay2-history-card">
          <div className="bay2-title-row"><h3>Today's Assignment History</h3><span>DN / CUSTOMER / PIECES / ASSIGNEE</span></div>
          <table className="bay2-table compact">
            <thead><tr><th>Task Number</th><th>Assignee</th><th>Pieces</th><th>DN</th></tr></thead>
            <tbody><tr><td colSpan={4} className="empty">No assignment history was returned for today.</td></tr></tbody>
          </table>
        </section>

        <section className="bay2-card bay2-assignee-card">
          <div className="bay2-title-row"><h3>Assignments by Assignee</h3><span>4 ASSIGNEES</span></div>
          <div className="bay2-assignees">
            {assignees.map((name) => <div key={name}><span>{name}</span><strong>0/0</strong></div>)}
          </div>
        </section>
      </section>
      <footer className="bay2-footer">UNIS WMS · LT_F1 Valley View · Auto-refreshes every 10 minutes</footer>
    </main>
  );
}
