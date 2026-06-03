import { AuthState } from "./auth";

const WMS_API_BASE_URL = process.env.NEXT_PUBLIC_WMS_API_BASE_URL || "https://unis.item.com/api";

function headers(auth: AuthState, includeFacility = true): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.accessToken}`,
    "x-tenant-id": auth.tenantId,
  };
  if (includeFacility && auth.facilityId) {
    h["x-facility-id"] = auth.facilityId;
  }
  return h;
}

export interface DockLocation {
  id: string;
  name: string;
  dockStatus: "AVAILABLE" | "RESERVED" | "OCCUPIED";
  entryId?: string;
}

export interface LoadTaskRecord {
  id: string;
  dockId: string;
  dockName?: string;
  status: string;
  customerId: string;
  customerName?: string;
  assigneeUserId: string;
  assigneeName?: string;
  createdTime: string;
  loadNo: string;
  shipToName: string;
  pieces?: number;
  loadMode?: string;
}

const BAY4_DOCK_RANGE = { min: 50, max: 72 };

export async function fetchDockLocations(auth: AuthState): Promise<DockLocation[]> {
  const res = await fetch(`${WMS_API_BASE_URL}/wms-bam/wms-location/search`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({ type: "DOCK" }),
  });
  const json = await res.json();
  const allDocks: DockLocation[] = (Array.isArray(json.data) ? json.data : json.data?.list || []);

  return allDocks
    .filter((d) => {
      const match = d.name?.match(/^DOCK(\d+)$/);
      if (!match) return false;
      const num = parseInt(match[1], 10);
      return num >= BAY4_DOCK_RANGE.min && num <= BAY4_DOCK_RANGE.max;
    })
    .sort((a, b) => {
      const na = parseInt(a.name.replace("DOCK", ""), 10);
      const nb = parseInt(b.name.replace("DOCK", ""), 10);
      return na - nb;
    });
}

export async function fetchLoadTasks(auth: AuthState): Promise<LoadTaskRecord[]> {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

  const formatLocal = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

  const res = await fetch(`${WMS_API_BASE_URL}/wms-bam/outbound/load-task/search-by-paging`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({
      currentPage: 1,
      pageSize: 200,
      createdTimePeriod: [formatLocal(startOfDay), formatLocal(endOfDay)],
    }),
  });
  const json = await res.json();
  const tasks = json.data?.list || [];

  const bay4DockIds = new Set<string>();
  const dockRes = await fetch(`${WMS_API_BASE_URL}/wms-bam/wms-location/search`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({ type: "DOCK" }),
  });
  const dockJson = await dockRes.json();
  const allDocks = Array.isArray(dockJson.data) ? dockJson.data : dockJson.data?.list || [];
  const dockMap = new Map<string, string>();
  for (const d of allDocks) {
    const match = d.name?.match(/^DOCK(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= BAY4_DOCK_RANGE.min && num <= BAY4_DOCK_RANGE.max) {
        bay4DockIds.add(String(d.id));
        dockMap.set(String(d.id), d.name);
      }
    }
  }

  return tasks
    .filter((t: Record<string, unknown>) => bay4DockIds.has(String(t.dockId)))
    .map((t: Record<string, unknown>): LoadTaskRecord => {
      const loads = (t.loads as Array<Record<string, unknown>>) || [];
      const firstLoad = loads[0] || {};
      const shipTo = (firstLoad.shipTo as Record<string, unknown>) || {};
      const totalPieces = loads.reduce((sum: number, l: Record<string, unknown>) => {
        return sum + (Number(l.totalPieces) || Number(l.pieceCount) || 0);
      }, 0);

      return {
        id: String(t.id),
        dockId: String(t.dockId),
        dockName: dockMap.get(String(t.dockId)) || `DOCK-${t.dockId}`,
        status: String(t.status),
        customerId: String(t.customerId || ""),
        customerName: String(shipTo.name || t.customerId || ""),
        assigneeUserId: String(t.assigneeUserId || ""),
        assigneeName: "",
        createdTime: String(t.createdTime || ""),
        loadNo: String(firstLoad.loadNo || ""),
        shipToName: String(shipTo.name || ""),
        pieces: totalPieces || undefined,
        loadMode: String(t.loadMode || ""),
      };
    });
}

export async function fetchUserNames(
  auth: AuthState,
  userIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!userIds.length) return map;

  try {
    const res = await fetch(`${WMS_API_BASE_URL}/wms-bam/user/search`, {
      method: "POST",
      headers: headers(auth, false),
      body: JSON.stringify({ ids: userIds }),
    });
    const json = await res.json();
    const users = Array.isArray(json.data) ? json.data : json.data?.list || [];
    for (const u of users) {
      const name = u.nickname || u.displayName || u.username || u.name || "";
      if (name) map.set(String(u.id), name);
    }
  } catch {
    // fallback - names will show as IDs
  }
  return map;
}

export async function fetchOrgNames(
  auth: AuthState,
  orgIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!orgIds.length) return map;

  try {
    const res = await fetch(`${WMS_API_BASE_URL}/wms-bam/organization/search`, {
      method: "POST",
      headers: headers(auth),
      body: JSON.stringify({ ids: orgIds }),
    });
    const json = await res.json();
    const orgs = Array.isArray(json.data) ? json.data : json.data?.list || [];
    for (const o of orgs) {
      map.set(String(o.id), o.name || o.code || "");
    }
  } catch {
    // fallback
  }
  return map;
}
