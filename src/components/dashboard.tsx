"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Loader2,
  RefreshCw,
  Search,
  Download,
  MapPin,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  X,
} from "lucide-react";
import type { Session, Facility } from "@/app/page";

/* ── Types ── */

interface PlannedOrder {
  orderNumber: string;
  customer: string;
  customerId: string;
  status: string;
  reference: string;
  created: string;
  shipMethod: string;
  carrier: string;
  scheduleDate: string;
  mabd: string;
  orderType: string;
  source: string;
  loadNo: string;
  appointmentTime: string;
  stagingLocation: string;
  baseQty: number;
  palletQty: number;
}

interface InYardEquipment {
  equipmentNumber: string;
  entryTicket: string;
  checkIn: string;
  timeInYard: string;
  customer: string;
}

interface PivotRow {
  kind: "customer" | "status" | "date";
  level: number;
  label: string;
  orderCount: number;
  baseQty: number;
  children?: PivotRow[];
}

interface Bay2ExpandedPivot {
  supported: boolean;
  rows: PivotRow[];
  metrics: { label: string; value: string; sub: string }[];
  totalOrderCount: number;
  totalBaseQty: number;
  unavailableReason?: string;
}

interface DashboardData {
  title: string;
  siteLabel: string;
  source: string;
  refreshedAt: string;
  generatedAt: string;
  customer: { name: string };
  customerSet: { name: string }[];
  plannedOrders: {
    supported: boolean;
    rows: PlannedOrder[];
    unavailableReason?: string;
  };
  inYardFullEquipment: {
    supported: boolean;
    rows: InYardEquipment[];
    candidateCount?: number;
    unavailableReason?: string;
  };
  bay2?: Bay2ExpandedPivot;
  bay?: string;
  reportType?: string;
  bpWorkload?: {
    supported: boolean;
    facilityId: string;
    newOrdersWindow: string;
    rows: {
      customer: string;
      unloadedYesterday: { supported: boolean; value: number };
      containersFull: { supported: boolean; value: number };
      ordersPickedYesterday: { supported: boolean; value: number };
      newOrders: { supported: boolean; value: number };
      fillableOrders: { supported: boolean; value: number };
    }[];
    totals: Record<string, { supported: boolean; value: number }>;
    definitions: Record<string, string>;
  };
}

/* ── Helpers ── */

const UNIS_LOGO =
  "https://unisco.sfo3.digitaloceanspaces.com/design-unisco-com/svg/unis-logo.svg";

function fmtDate(v: string): string {
  if (!v) return "Pending";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
}

function fmtNum(v: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(v));
}

function normalizeCustomerNameForCount(value: string): string {
  return String(value || "")
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function fmtTimeAgo(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m ago`;
}

function pivotRowKey(row: PivotRow): string {
  return `${row.kind}:${row.label}`;
}

/** Flatten a pivot tree into visible rows, honouring expanded state. */
function flattenPivotRows(
  rows: PivotRow[],
  expanded: Set<string>,
): {
  row: PivotRow;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}[] {
  const result: {
    row: PivotRow;
    depth: number;
    hasChildren: boolean;
    isExpanded: boolean;
  }[] = [];
  const walk = (row: PivotRow, depth: number) => {
    const key = pivotRowKey(row);
    const hasChildren = !!(row.children && row.children.length > 0);
    const isExpanded = expanded.has(key);
    result.push({ row, depth, hasChildren, isExpanded });
    if (hasChildren && isExpanded) {
      for (const child of row.children!) {
        walk(child, depth + 1);
      }
    }
  };
  for (const row of rows) {
    walk(row, 0);
  }
  return result;
}

const TABS = [
  { key: "bay1", label: "Team 1" },
  { key: "bay2", label: "Team 2" },
  { key: "bay3", label: "Team 3" },
  { key: "bay4", label: "Team 4" },
  { key: "bay5", label: "Team 5" },
  { key: "evelyn", label: "Team 2 LTL" },
  { key: "crateBarrel", label: "Crate & Barrel" },
  { key: "bpWorkload", label: "B.P. Workload" },
  { key: "nightShift", label: "Night Shift" },
  { key: "bay4AutoAssign", label: "Rear Guard Shack" },
  { key: "frontGuardShack", label: "Front Guard Shack" },
  { key: "bay2AutoAssign", label: "Team 2 Auto Assign" },
];

const SPEAK_TABS = new Set(["bay1", "bay4", "bay5"]);

const CUSTOMER_FILTER_TABS = new Set([
  "bay1",
  "bay3",
  "bay4",
  "bay5",
  "nightShift",
]);

const ALESSANDRO_FACILITY_ID = "LT_F11";

const ALESSANDRO_TEAM3_LAYOUT_TABS = new Set([
  "bpWorkload",
  "bay1",
  "bay3",
]);

const FONTANA_FACILITY_ID = "LT_ORG-7759";

const FONTANA_VISIBLE_TABS = new Set([
  "bay1",
  "bay2",
  "bay3",
  "evelyn",
  "bay4",
  "bay5",
  "nightShift",
]);

const FONTANA_TAB_LABELS: Record<string, string> = {
  bay2: "E-comm",
  evelyn: "E-com LTL",
};

// Dedicated endpoints per tab used by Fontana (bay4 uses standard /api/dashboard)
const FONTANA_TAB_ENDPOINTS: Record<string, string> = {
  bay1: "/api/dashboard/bay1",
  bay2: "/api/dashboard/bay2",
  bay3: "/api/dashboard/bay3",
  evelyn: "/api/dashboard/evelyn",
  bay5: "/api/dashboard/bay5",
};

/* ── Dashboard ── */

interface DashboardProps {
  session: Session;
  facility: Facility;
  activeTab: string;
  onLogout: () => void;
  onChangeFacility: (f: Facility) => void;
  onChangeTab: (tab: string) => void;
}

export function Dashboard({
  session,
  facility,
  activeTab,
  onLogout,
  onChangeFacility,
  onChangeTab,
}: DashboardProps) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [customerFilter, setCustomerFilter] = useState<string | null>(
    null,
  );
  const [countdown, setCountdown] = useState(300);
  const [sortKey, setSortKey] = useState<string>("created");
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedPivotRows, setExpandedPivotRows] = useState<Set<string>>(
    () => new Set()
  );
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevDataRef = useRef<DashboardData | null>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);

  /* ── Voice helpers ── */
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);

  const loadVoices = useCallback(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const v = window.speechSynthesis.getVoices();
    if (v.length) voicesRef.current = v;
  }, []);

  const pickEnglishFemale = useCallback((): SpeechSynthesisVoice | null => {
    const lower = (s: string) => s.toLowerCase();
    const voices = voicesRef.current;
    if (!voices.length) return null;
    // Prefer an English female voice by name or lang
    const byName = voices.find(
      (v) =>
        (lower(v.name).includes("female") ||
         lower(v.name).includes("woman") ||
         lower(v.name).includes("samantha") ||
         lower(v.name).includes("susan") ||
         lower(v.name).includes("lisa") ||
         lower(v.name).includes("karen") ||
         lower(v.name).includes("moira") ||
         lower(v.name).includes("fiona")) &&
        !lower(v.name).includes("male")
    );
    if (byName) return byName;
    // Fallback: any English voice that isn't obviously male
    const enVoice = voices.find(
      (v) =>
        lower(v.lang).startsWith("en") &&
        !lower(v.name).includes("male")
    );
    return enVoice ?? voices[0];
  }, []);

  const pickSpanishFemale = useCallback((): SpeechSynthesisVoice | null => {
    const lower = (s: string) => s.toLowerCase();
    const voices = voicesRef.current;
    if (!voices.length) return null;
    const spanishFemaleNames = [
      "paulina", "monica", "marisol", "soledad", "esperanza",
      "lucia", "carmen", "conchita", "helena", "laura", "maria",
      "sabina", "spanish", "español",
    ];
    const spanishFemale = voices.find((v) => {
      const name = lower(v.name);
      const lang = lower(v.lang);
      return (
        (lang.startsWith("es") || spanishFemaleNames.some((n) => name.includes(n))) &&
        !name.includes("male") &&
        !name.includes("hombre")
      );
    });
    if (spanishFemale) return spanishFemale;
    // Fallback to any Spanish voice
    const anySpanish = voices.find((v) => lower(v.lang).startsWith("es"));
    return anySpanish ?? pickEnglishFemale();
  }, [pickEnglishFemale]);

  const speakTabData = useCallback(
    (d: DashboardData) => {
      if (typeof window === "undefined") return;
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      synthRef.current = synth;

      const yardCount = d.inYardFullEquipment?.supported
        ? d.inYardFullEquipment.rows.length
        : "pending";
      const plannedCount = d.plannedOrders?.supported
        ? d.plannedOrders.rows.length
        : "pending";
      const tabLabel = d.title || activeTab;

      // English first
      const enText = `${tabLabel}. In-yard full equipment: ${yardCount}. Planned orders: ${plannedCount}.`;
      const enUtterance = new SpeechSynthesisUtterance(enText);
      enUtterance.rate = 0.85;
      enUtterance.pitch = 1.1;
      enUtterance.volume = 0.9;
      enUtterance.lang = "en-US";
      const enVoice = pickEnglishFemale();
      if (enVoice) enUtterance.voice = enVoice;

      // Spanish after English
      const esText = `${tabLabel}. Equipo completo en patio: ${yardCount}. Órdenes planificadas: ${plannedCount}.`;
      const esUtterance = new SpeechSynthesisUtterance(esText);
      esUtterance.rate = 0.82;
      esUtterance.pitch = 1.05;
      esUtterance.volume = 0.9;
      esUtterance.lang = "es-US";
      const esVoice = pickSpanishFemale();
      if (esVoice) esUtterance.voice = esVoice;

      // Chain: English → Spanish
      enUtterance.onend = () => {
        synth.speak(esUtterance);
      };

      synth.speak(enUtterance);
    },
    [activeTab, pickEnglishFemale, pickSpanishFemale]
  );

  /* ── Speak KPIs when voice-enabled tab data loads ── */
  useEffect(() => {
    if (!SPEAK_TABS.has(activeTab)) return;
    if (loading) return;
    if (!data) return;
    if (data === prevDataRef.current) return;
    prevDataRef.current = data;
    speakTabData(data);
  }, [activeTab, data, loading, speakTabData]);

  // Load voices on mount
  useEffect(() => {
    loadVoices();
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, [loadVoices]);

  // Cancel speech when leaving a voice-enabled tab or unmounting
  useEffect(() => {
    return () => {
      if (synthRef.current) {
        synthRef.current.cancel();
        synthRef.current = null;
      }
    };
  }, [activeTab]);

  const fetchData = useCallback(async () => {
    if (!session || !facility) return;
    setLoading(true);
    setError("");

    try {
      let token = session.accessToken;
      const now = Date.now();
      if (now > session.expiresAt - 60000) {
        const refRes = await fetch("/api/auth/refresh", {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
        if (refRes.ok) {
          const refJson = await refRes.json();
          token = refJson.accessToken;
          session.accessToken = refJson.accessToken;
          session.refreshToken = refJson.refreshToken;
          session.expiresAt = now + 1000 * Number(refJson.expiresIn ?? 3600);
          localStorage.setItem(
            "bay4-wms-session",
            JSON.stringify(session)
          );
        }
      }

      // ── Dedicated tab endpoints with AbortController + 30s timeout ──
      const fontanaEndpoint = isFontana
        ? FONTANA_TAB_ENDPOINTS[activeTab]
        : undefined;

      if (
        activeTab === "bpWorkload" ||
        (isAlessandro && (activeTab === "bay1" || activeTab === "bay3")) ||
        (isFontana && fontanaEndpoint)
      ) {
        const endpoint =
          activeTab === "bpWorkload"
            ? "/api/dashboard/bp-workload"
            : fontanaEndpoint
              ? fontanaEndpoint
              : activeTab === "bay1"
                ? "/api/dashboard/bay1"
                : "/api/dashboard/bay3";

        const tabLabel =
          activeTab === "bpWorkload"
            ? "BP Workload"
            : TABS.find((t) => t.key === activeTab)?.label ||
              activeTab;

        const needAllCustomers =
          isFontana || isAlessandro || activeTab === "bpWorkload";

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);

        try {
          const body: Record<string, unknown> = {
            facilityId: facility.id,
            facilityName: facility.name,
            timeZone: facility.timeZone,
            tab: activeTab,
          };
          if (needAllCustomers) {
            body.includeAllCustomers = true;
          }

          const res = await fetch(endpoint, {
            method: "POST",
            cache: "no-store",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
              "x-tenant-id": session.identity.tenant_id,
              "x-facility-id": facility.id,
            },
            body: JSON.stringify(body),
          });

          if (res.status === 401) {
            onLogout();
            return;
          }

          const payload = await res.json().catch(() => ({}));
          if (res.ok) {
            setData(payload);
          } else {
            setError(
              String(
                payload.message ||
                  `${tabLabel} data is unavailable.`,
              ),
            );
          }
        } catch (err) {
          if (
            err instanceof DOMException &&
            err.name === "AbortError"
          ) {
            setError(
              `${tabLabel} timed out after 30 seconds.`,
            );
          } else {
            setError(`${tabLabel} data is unavailable.`);
          }
        } finally {
          clearTimeout(timeoutId);
          setLoading(false);
        }
        return;
      }

      // ── All other tabs ─────────────────────────────────────────────────
      const standardBody: Record<string, unknown> = {
        facilityId: facility.id,
        facilityName: facility.name,
        timeZone: facility.timeZone,
        tab: activeTab,
      };
      if (isFontana || isAlessandro) {
        standardBody.includeAllCustomers = true;
      }

      const res = await fetch("/api/dashboard", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-tenant-id": session.identity.tenant_id,
          "x-facility-id": facility.id,
        },
        body: JSON.stringify(standardBody),
      });

      if (res.status === 401) {
        onLogout();
        return;
      }

      const json = await res.json();
      if (res.ok) {
        setData(json);
      } else {
        setError(json.message || "Could not load dashboard data.");
      }
    } catch {
      setError("Unable to load dashboard data.");
    } finally {
      setLoading(false);
    }
  }, [session, facility, activeTab, onLogout]);

  useEffect(() => {
    fetchData();
    setCountdown(300);

    // Clear customer filter when switching to a non-filterable tab
    if (!CUSTOMER_FILTER_TABS.has(activeTab)) {
      setCustomerFilter(null);
    }

    // Fontana: redirect to first allowed tab if current tab is hidden
    if (isFontana && !FONTANA_VISIBLE_TABS.has(activeTab)) {
      onChangeTab("bay1");
      return;
    }

    if (activeTab === "bpWorkload") return;

    intervalRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          fetchData();
          return 300;
        }
        return c - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData, activeTab]);

  /* ── Computed ── */
  const plannedRows: PlannedOrder[] = data?.plannedOrders?.rows ?? [];
  const searchLower = search.trim().toLowerCase();
  const filteredPlanned = useMemo(() => {
    const rows = searchLower
      ? plannedRows.filter((r) =>
          Object.values(r).join(" ").toLowerCase().includes(searchLower)
        )
      : plannedRows;
    return [...rows].sort((a, b) => {
      const av = String(a[sortKey as keyof PlannedOrder] ?? "");
      const bv = String(b[sortKey as keyof PlannedOrder] ?? "");
      return (sortAsc ? 1 : -1) * av.localeCompare(bv);
    });
  }, [plannedRows, searchLower, sortKey, sortAsc]);

  const customerSet: { name: string; count: number }[] = useMemo(() => {
    const set = data?.customerSet?.length
      ? data.customerSet
      : [{ name: data?.customer?.name ?? facility.name }];
    return set.map((c) => ({
      name: c.name,
      count:
        plannedRows.filter((r) => normalizeCustomerNameForCount(r.customer) === normalizeCustomerNameForCount(c.name)).length,
    }));
  }, [data, plannedRows, facility.name]);

  const customerOrderCountMap = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of plannedRows) {
      const key = normalizeCustomerNameForCount(row.customer || "Pending");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [plannedRows]);

  const getCustomerOrderCount = useCallback(
    (customerName: string) => customerOrderCountMap.get(normalizeCustomerNameForCount(customerName || "Pending")) ?? 0,
    [customerOrderCountMap]
  );

  const inYardRows = data?.inYardFullEquipment?.rows ?? [];
  const yardSupported = data?.inYardFullEquipment?.supported ?? false;

  // Per-tab customer filter — derived rows (Teams 1,3,4,5 + Night Shift)
  const isAlessandro = facility.id === ALESSANDRO_FACILITY_ID;
  const isFontana = facility.id === FONTANA_FACILITY_ID;
  const useTeam3Layout =
    (isAlessandro && ALESSANDRO_TEAM3_LAYOUT_TABS.has(activeTab)) ||
    (isFontana && FONTANA_VISIBLE_TABS.has(activeTab));

  const customerFilterActive = CUSTOMER_FILTER_TABS.has(activeTab);
  const customerFilteredYardRows = useMemo(() => {
    if (!customerFilterActive || !customerFilter) return inYardRows;
    return inYardRows.filter(
      (r) =>
        normalizeCustomerNameForCount(r.customer) ===
        normalizeCustomerNameForCount(customerFilter),
    );
  }, [inYardRows, customerFilter, customerFilterActive]);

  const customerFilteredPlannedRows = useMemo(() => {
    if (!customerFilterActive || !customerFilter) return filteredPlanned;
    return filteredPlanned.filter(
      (r) =>
        normalizeCustomerNameForCount(r.customer) ===
        normalizeCustomerNameForCount(customerFilter),
    );
  }, [filteredPlanned, customerFilter, customerFilterActive]);

  // Which rows to actually render per section
  const displayYardRows = customerFilterActive
    ? customerFilteredYardRows
    : inYardRows;
  const displayPlannedRows = customerFilterActive
    ? customerFilteredPlannedRows
    : filteredPlanned;

  const customerFilterSet = useMemo(() => {
    if (!customerFilterActive) return [];
    const seen = new Set<string>();
    const result: { name: string; count: number }[] = [];
    for (const r of inYardRows) {
      const key = normalizeCustomerNameForCount(r.customer);
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ name: r.customer, count: 0 });
      }
    }
    for (const r of plannedRows) {
      const key = normalizeCustomerNameForCount(r.customer);
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ name: r.customer, count: 0 });
      }
    }
    // Count from planned rows
    for (const c of result) {
      c.count = plannedRows.filter(
        (r) =>
          normalizeCustomerNameForCount(r.customer) ===
          normalizeCustomerNameForCount(c.name),
      ).length;
    }
    return result.sort((a, b) => b.count - a.count);
  }, [customerFilterActive, inYardRows, plannedRows]);

  const handleCustomerFilterClick = useCallback(
    (customerName: string) => {
      if (!customerFilterActive) return;
      setCustomerFilter((prev) =>
        prev === customerName ? null : customerName,
      );
    },
    [customerFilterActive],
  );

  const clearCustomerFilter = useCallback(() => {
    setCustomerFilter(null);
  }, []);

  // ── Pivot expand / collapse ──────────────────────────────────────────────
  const togglePivotRow = useCallback((row: PivotRow) => {
    const key = pivotRowKey(row);
    setExpandedPivotRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expandAllPivotRows = useCallback(() => {
    if (!data?.bay2?.rows) return;
    const keys = new Set<string>();
    const collect = (rows: PivotRow[]) => {
      for (const r of rows) {
        if (r.children && r.children.length > 0) {
          keys.add(pivotRowKey(r));
          collect(r.children);
        }
      }
    };
    collect(data.bay2.rows);
    setExpandedPivotRows(keys);
  }, [data]);

  const collapseAllPivotRows = useCallback(() => {
    setExpandedPivotRows(new Set());
  }, []);

  // Auto-expand first level on data load
  useEffect(() => {
    const rows = data?.bay2?.rows;
    if (!rows?.length) return;
    setExpandedPivotRows((prev) => {
      if (prev.size > 0) return prev; // preserve user state on refresh
      const keys = new Set<string>();
      for (const r of rows) {
        if (r.children && r.children.length > 0) {
          keys.add(pivotRowKey(r));
        }
      }
      return keys;
    });
  }, [data?.bay2?.rows]);

  const flattenedPivot = useMemo(() => {
    if (!data?.bay2?.rows) return [];
    return flattenPivotRows(data.bay2.rows, expandedPivotRows);
  }, [data?.bay2?.rows, expandedPivotRows]);

  const handleSort = (key: string) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const exportCSV = () => {
    const rows = displayPlannedRows;
    if (!rows.length) return;
    const cols = useTeam3Layout
      ? [
          ["customer", "Customer"],
          ["orderNumber", "Order Number"],
          ["loadNo", "Load #"],
          ["status", "Order Status"],
          ["appointmentTime", "Appointment Date"],
          ["scheduleDate", "Schedule Date"],
          ["stagingLocation", "Staging Location"],
          ["baseQty", "Total Base QTY"],
          ["palletQty", "Pallet Qty"],
        ]
      : [
          ["orderNumber", "Order #"],
          ["customer", "Customer"],
          ["status", "Status"],
          ["reference", "PO / Reference"],
          ["created", "Created (PDT)"],
          ["shipMethod", "Ship Method"],
          ["carrier", "Carrier"],
          ["scheduleDate", "Schedule Date"],
          ["mabd", "MABD"],
        ];
    const lines = [
      cols.map(([, h]) => h),
      ...rows.map((r) =>
        cols.map(([k]) =>
          k === "created" ||
          k === "scheduleDate" ||
          k === "mabd" ||
          k === "appointmentTime"
            ? fmtDate(String(r[k as keyof PlannedOrder] ?? ""))
            : String(r[k as keyof PlannedOrder] ?? "")
        )
      ),
    ];
    const csv = lines
      .map((l) =>
        l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeTab}_Planned_Orders.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ── Render ── */
  const mins = Math.floor(countdown / 60);
  const secs = countdown % 60;
  const countdownLabel = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

  return (
    <main className="dashboard-shell">
      {/* Brand bar */}
      <header className="brand-bar">
        <div className="brand-left">
          <img className="brand-logo" src={UNIS_LOGO} alt="UNIS" />
          <span className="brand-title">{data?.title ?? facility.name}</span>
        </div>
        <div className="brand-right">
          <div className="facility-select">
            <MapPin size={13} color="var(--muted-2)" />
            <select
              value={facility.id}
              onChange={(e) => {
                const f = session.facilities.find(
                  (x) => x.id === e.target.value
                );
                if (f) onChangeFacility(f);
              }}
            >
              {session.facilities.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({f.id})
                </option>
              ))}
            </select>
          </div>
          <span className="user-tag">{session.identity.user_name}</span>
          <button className="sign-out-btn" onClick={onLogout} type="button">
            Sign out
          </button>
          <button
            className="ghost-button"
            onClick={fetchData}
            disabled={loading}
            type="button"
            title="Refresh"
          >
            {loading ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Refresh
          </button>
        </div>
      </header>

      {/* Tab bar */}
      <nav className="tab-bar">
        {TABS.filter(
          (t) => !isFontana || FONTANA_VISIBLE_TABS.has(t.key),
        ).map((t) => (
          <button
            key={t.key}
            className={`report-tab${activeTab === t.key ? " active" : ""}`}
            type="button"
            onClick={() => onChangeTab(t.key)}
          >
            {isFontana
              ? FONTANA_TAB_LABELS[t.key] || t.label
              : t.label}
          </button>
        ))}
      </nav>

      {error && <div className="banner">{error}</div>}

      {loading && !data ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={32} className="spin" color="var(--accent)" />
        </div>
      ) : (
        <div className="dashboard-body">
          {/* Stats */}
          <div className="stat-row">
            <div className="stat-card">
              <span>Planned Orders</span>
              <strong>
                {data?.plannedOrders.supported
                  ? fmtNum(plannedRows.length)
                  : "Pending"}
              </strong>
              <small>{data?.customer.name ?? facility.name}</small>
            </div>
            <div className="stat-card">
              <span>In-Yard Equipment</span>
              <strong>
                {yardSupported ? fmtNum(inYardRows.length) : "Pending"}
              </strong>
              <small>FULL equipment not yet devanned</small>
            </div>
            <div className="stat-card">
              <span>Customers</span>
              <strong>{fmtNum(customerSet.length)}</strong>
              <small>Active in planned orders</small>
            </div>
            <div className="stat-card">
              <span>Next Refresh</span>
              <strong>{countdownLabel}</strong>
              <small>
                {data?.refreshedAt ? fmtTimeAgo(data.refreshedAt) : ""}
              </small>
            </div>
          </div>

          {/* Team 2 Expanded Pivot */}
          {activeTab === "bay2" && data?.bay2?.supported ? (
            <section className="report-section">
              <div className="section-heading">
                <h2>
                  Team 2 Order Pivot{" "}
                  <span style={{ fontWeight: 400, color: "var(--muted-2)" }}>
                    Customer · Status · Date
                  </span>
                </h2>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="ghost-button"
                    onClick={expandAllPivotRows}
                    type="button"
                    style={{ fontSize: "0.75rem", padding: "2px 10px" }}
                  >
                    Expand All
                  </button>
                  <button
                    className="ghost-button"
                    onClick={collapseAllPivotRows}
                    type="button"
                    style={{ fontSize: "0.75rem", padding: "2px 10px" }}
                  >
                    Collapse All
                  </button>
                </div>
              </div>

              {/* Pivot metrics chips */}
              <div className="chips">
                {data.bay2.metrics.map((m) => (
                  <button key={m.label} className="chip active" type="button">
                    {m.label}{" "}
                    <span className="chip-count">({m.value})</span>
                  </button>
                ))}
              </div>

              <div className="table-frame" style={{ maxHeight: "70vh" }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: "60%" }}>Row Labels</th>
                      <th style={{ width: "20%", textAlign: "right" }}>
                        Count of Order #
                      </th>
                      <th style={{ width: "20%", textAlign: "right" }}>
                        Sum of BASE QTY
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {flattenedPivot.map(({ row, depth, hasChildren, isExpanded }) => (
                      <tr
                        key={pivotRowKey(row)}
                        className={
                          row.kind === "customer"
                            ? "pivot-customer-row"
                            : row.kind === "status"
                              ? "pivot-status-row"
                              : "pivot-date-row"
                        }
                        style={{ cursor: hasChildren ? "pointer" : "default" }}
                        onClick={() => hasChildren && togglePivotRow(row)}
                      >
                        <td
                          style={{
                            paddingLeft: `${12 + depth * 24}px`,
                            fontWeight:
                              row.kind === "customer" ? 600 : row.kind === "status" ? 500 : 400,
                            fontSize:
                              row.kind === "customer"
                                ? "0.875rem"
                                : row.kind === "status"
                                  ? "0.8125rem"
                                  : "0.75rem",
                            color:
                              row.kind === "customer"
                                ? "var(--foreground)"
                                : row.kind === "status"
                                  ? "var(--muted-1)"
                                  : "var(--muted-2)",
                          }}
                        >
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            {hasChildren ? (
                              isExpanded ? (
                                <ChevronDown size={14} />
                              ) : (
                                <ChevronRight size={14} />
                              )
                            ) : (
                              <span style={{ width: 14, display: "inline-block" }} />
                            )}
                            {row.label}
                          </span>
                        </td>
                        <td
                          style={{
                            textAlign: "right",
                            fontWeight: row.kind === "customer" ? 600 : 400,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {fmtNum(row.orderCount)}
                        </td>
                        <td
                          style={{
                            textAlign: "right",
                            fontWeight: row.kind === "customer" ? 600 : 400,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {fmtNum(row.baseQty)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr
                      style={{
                        borderTop: "2px solid var(--border)",
                        fontWeight: 700,
                      }}
                    >
                      <td style={{ fontWeight: 700 }}>Grand Total</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {fmtNum(data.bay2.totalOrderCount)}
                      </td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {fmtNum(data.bay2.totalBaseQty)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="meta-row">
                <span className="meta-label">
                  {data?.source ?? "Pivot"} · {flattenedPivot.length} rows shown
                </span>
                <strong>
                  {data.bay2.rows.length} customers ·{" "}
                  {fmtNum(data.bay2.totalOrderCount)} orders ·{" "}
                  {fmtNum(data.bay2.totalBaseQty)} total qty
                </strong>
              </div>
            </section>
          ) : activeTab === "bay2" && data?.bay2 && !data.bay2.supported ? (
            <section className="report-section">
              <div className="section-heading">
                <h2>Team 2 Order Pivot</h2>
              </div>
              <div className="empty-state blocked">
                <AlertTriangle size={18} />
                <span>
                  {data.bay2.unavailableReason ||
                    "Expanded pivot data is currently unavailable."}
                </span>
              </div>
            </section>
          ) : null}

          {/* Customer filter indicator (Teams 1,3,4,5 + Night Shift) */}
          {customerFilterActive && customerFilter && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 18px",
                background: "rgba(139, 92, 246, 0.12)",
                border: "1px solid rgba(139, 92, 246, 0.3)",
                borderRadius: "var(--radius-sm)",
                marginBottom: 4,
              }}
            >
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  color: "var(--accent-2)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                Filtered by customer:
              </span>
              <span
                style={{
                  fontSize: "0.8125rem",
                  fontWeight: 700,
                  color: "#fff",
                  background: "rgba(139, 92, 246, 0.22)",
                  padding: "2px 12px",
                  borderRadius: 999,
                }}
              >
                {customerFilter}
              </span>
              <button
                className="ghost-button"
                onClick={clearCustomerFilter}
                type="button"
                style={{
                  fontSize: "0.7rem",
                  padding: "2px 10px",
                  marginLeft: "auto",
                }}
              >
                <X size={12} /> Clear filter
              </button>
            </div>
          )}

          {/* Customer filter chips (Teams 1,3,4,5 + Night Shift) */}
          {customerFilterActive && customerFilterSet.length > 0 && (
            <div className="chips" style={{ paddingBottom: 0 }}>
              {customerFilterSet.map((c) => {
                const isActive =
                  customerFilter === c.name;
                return (
                  <button
                    key={c.name}
                    className={`chip${isActive ? " active" : ""}`}
                    type="button"
                    onClick={() =>
                      setCustomerFilter(
                        isActive ? null : c.name,
                      )
                    }
                    style={{
                      cursor: "pointer",
                      borderColor: isActive
                        ? "var(--accent-2)"
                        : undefined,
                    }}
                  >
                    {c.name}{" "}
                    <span className="chip-count">
                      ({c.count})
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Section 1: In-Yard FULL Equipment */}
          <section className="report-section">
            <div className="section-heading">
              <h2>
                Section 1 - In-Yard FULL Equipment{" "}
                <span style={{ fontWeight: 400, color: "var(--muted-2)" }}>
                  (not yet devanned)
                </span>
              </h2>
            </div>

            {!data || (!yardSupported && !displayYardRows.length) ? (
              data?.inYardFullEquipment?.unavailableReason ? (
                <div className="empty-state blocked">
                  <AlertTriangle size={18} />
                  <span>
                    {data.inYardFullEquipment.unavailableReason}
                  </span>
                </div>
              ) : (
                <div className="empty-state">
                  No in-yard FULL equipment matched this report in the latest
                  WISE read.
                </div>
              )
            ) : (
              <div className="table-frame section1-scroll-wrap">
                <table>
                  <thead>
                    <tr>
                      {[
                        ["equipmentNumber", "Equipment #"],
                        ["entryTicket", "Entry Ticket"],
                        ["checkIn", "Check In"],
                        ["timeInYard", "Time in Yard"],
                        ["customer", "Customer"],
                      ].map(([k, label]) => (
                        <th key={k}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayYardRows.map((r) => (
                      <tr
                        key={`${r.equipmentNumber}-${r.entryTicket}`}
                      >
                        <td className="strong">{r.equipmentNumber}</td>
                        <td>{r.entryTicket || "Pending"}</td>
                        <td>{fmtDate(r.checkIn)}</td>
                        <td>{r.timeInYard || "Pending"}</td>
                        <td>
                          {customerFilterActive ? (
                            <button
                              type="button"
                              className="customer-link"
                              onClick={() =>
                                handleCustomerFilterClick(
                                  r.customer,
                                )
                              }
                            >
                              {r.customer || "Pending"}
                            </button>
                          ) : (
                            r.customer || "Pending"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Section 2: PLANNED Outbound Orders */}
          <section className="report-section">
            <div className="section-heading">
              <h2>Section 2 - PLANNED Outbound Orders</h2>
              <div className="search-box">
                <Search size={14} />
                <input
                  placeholder="Search order, PO, carrier..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            {/* Customer chips with counts */}
            <div className="chips">
              {customerSet.map((c) => {
                const isFilterActive =
                  customerFilterActive && customerFilter === c.name;
                return (
                  <button
                    key={c.name}
                    className={`chip${isFilterActive ? " active" : customerFilterActive ? "" : " active"}`}
                    type="button"
                    onClick={() =>
                      customerFilterActive &&
                      handleCustomerFilterClick(c.name)
                    }
                    style={{
                      cursor: customerFilterActive ? "pointer" : "default",
                      borderColor: isFilterActive
                        ? "var(--accent-2)"
                        : undefined,
                    }}
                  >
                    {c.name}{" "}
                    <span className="chip-count">({c.count})</span>
                  </button>
                );
              })}
            </div>

            {data?.plannedOrders.supported && displayPlannedRows.length === 0 ? (
              search ? (
                <div className="empty-state">
                  No planned orders match the current filters.
                </div>
              ) : (
                <div className="empty-state">
                  No planned orders were returned by WISE.
                </div>
              )
            ) : !data || !data.plannedOrders.supported ? (
              <div className="empty-state blocked">
                <AlertTriangle size={18} />
                <span>
                  {data?.plannedOrders.unavailableReason ||
                    "This report data is currently unavailable."}
                </span>
              </div>
            ) : (
              <>
                <div className="action-bar">
                  <button
                    className="download-button"
                    disabled={!displayPlannedRows.length}
                    onClick={exportCSV}
                    type="button"
                  >
                    <Download size={13} /> Download CSV
                  </button>
                </div>
                <div className="table-frame">
                  <table>
                    {useTeam3Layout ? (
                      <>
                        <thead>
                          <tr>
                            {[
                              ["customer", "Customer"],
                              ["orderNumber", "Order Number"],
                              ["loadNo", "Load #"],
                              ["status", "Order Status"],
                              ["appointmentTime", "Appt Date"],
                              ["appointmentTime", "Appt Time"],
                              ["scheduleDate", "Schedule Date"],
                              ["stagingLocation", "Staging Location"],
                              ["baseQty", "Total Base QTY"],
                              ["palletQty", "Pallet Qty"],
                            ].map(([k, label]) => (
                              <th key={k}>
                                <button
                                  type="button"
                                  onClick={() => handleSort(k)}
                                >
                                  {label}
                                  {sortKey === k
                                    ? sortAsc
                                      ? " ↑"
                                      : " ↓"
                                    : ""}
                                </button>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {displayPlannedRows.map((r) => (
                            <tr key={r.orderNumber}>
                              <td>
                                {customerFilterActive ? (
                                  <button
                                    type="button"
                                    className="customer-link"
                                    onClick={() =>
                                      handleCustomerFilterClick(
                                        r.customer,
                                      )
                                    }
                                  >
                                    {r.customer}
                                  </button>
                                ) : (
                                  r.customer
                                )}
                              </td>
                              <td className="strong">
                                {r.orderNumber}
                              </td>
                              <td>{r.loadNo || "—"}</td>
                              <td>{r.status}</td>
                              <td>
                                {fmtDate(r.appointmentTime)}
                              </td>
                              <td>
                                {r.appointmentTime
                                  ? (() => {
                                      const d = new Date(
                                        r.appointmentTime,
                                      );
                                      return Number.isNaN(
                                        d.getTime(),
                                      )
                                        ? r.appointmentTime
                                        : new Intl.DateTimeFormat(
                                            "en-US",
                                            {
                                              timeZone:
                                                facility.timeZone ||
                                                "America/Los_Angeles",
                                              hour: "2-digit",
                                              minute: "2-digit",
                                              hour12: false,
                                            },
                                          ).format(d);
                                    })()
                                  : "—"}
                              </td>
                              <td>
                                {fmtDate(r.scheduleDate)}
                              </td>
                              <td>
                                {r.stagingLocation || "—"}
                              </td>
                              <td
                                style={{
                                  textAlign: "right",
                                  fontVariantNumeric:
                                    "tabular-nums",
                                }}
                              >
                                {fmtNum(r.baseQty)}
                              </td>
                              <td
                                style={{
                                  textAlign: "right",
                                  fontVariantNumeric:
                                    "tabular-nums",
                                }}
                              >
                                {fmtNum(r.palletQty)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </>
                    ) : (
                      <>
                        <thead>
                          <tr>
                            {[
                              ["orderNumber", "Order #"],
                              ["customer", "Customer"],
                              ["status", "Status"],
                              [
                                "reference",
                                "PO / Reference",
                              ],
                              [
                                "created",
                                "Created (PDT)",
                              ],
                              [
                                "shipMethod",
                                "Ship Method",
                              ],
                              ["carrier", "Carrier"],
                              [
                                "scheduleDate",
                                "Schedule Date",
                              ],
                              ["mabd", "MABD"],
                            ].map(([k, label]) => (
                              <th key={k}>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleSort(k)
                                  }
                                >
                                  {label}
                                  {sortKey === k
                                    ? sortAsc
                                      ? " ↑"
                                      : " ↓"
                                    : ""}
                                </button>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {displayPlannedRows.map((r) => (
                            <tr key={r.orderNumber}>
                              <td className="strong">
                                {r.orderNumber}
                              </td>
                              <td>
                                {customerFilterActive ? (
                                  <button
                                    type="button"
                                    className="customer-link"
                                    onClick={() =>
                                      handleCustomerFilterClick(
                                        r.customer,
                                      )
                                    }
                                  >
                                    {r.customer}
                                  </button>
                                ) : (
                                  r.customer
                                )}{" "}
                                <span className="customer-order-count">
                                  (
                                  {getCustomerOrderCount(
                                    r.customer,
                                  )}
                                  )
                                </span>
                              </td>
                              <td>{r.status}</td>
                              <td>{r.reference}</td>
                              <td>
                                {fmtDate(r.created)}
                              </td>
                              <td>{r.shipMethod}</td>
                              <td>{r.carrier}</td>
                              <td>
                                {fmtDate(
                                  r.scheduleDate,
                                )}
                              </td>
                              <td>{fmtDate(r.mabd)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </>
                    )}
                  </table>
                </div>
              </>
            )}

            <div className="meta-row">
              <span className="meta-label">
                {data?.source ?? "WISE"} · Last refreshed{" "}
                {data?.refreshedAt ? fmtTimeAgo(data.refreshedAt) : "just now"}
              </span>
              <strong>
                {fmtNum(plannedRows.length)} planned ·{" "}
                {fmtNum(displayPlannedRows.length)} shown
              </strong>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
