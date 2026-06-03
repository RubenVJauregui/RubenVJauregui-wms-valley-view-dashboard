const WMS_API_BASE_URL =
  process.env.WMS_API_BASE_URL || "https://unis.item.com/api";

export interface WmsPlannedOrder {
  orderNumber: string;
  customer: string;
  customerId: string;
  status: string;
  reference: string;
  created: string;
  shipMethod: string;
  carrier: string;
  carrierId: string;
  scheduleDate: string;
  mabd: string;
  orderType: string;
  source: string;
}

export interface WmsInYardEquipment {
  equipmentNumber: string;
  entryTicket: string;
  checkIn: string;
  timeInYard: string;
  customer: string;
}

export interface WmsDashboardData {
  title: string;
  siteLabel: string;
  source: string;
  refreshedAt: string;
  generatedAt: string;
  customer: { name: string };
  customerSet: { name: string }[];
  plannedOrders: {
    supported: boolean;
    rows: WmsPlannedOrder[];
    unavailableReason?: string;
  };
  inYardFullEquipment: {
    supported: boolean;
    rows: WmsInYardEquipment[];
    candidateCount?: number;
    unavailableReason?: string;
  };
}

function authHeaders(token: string, tenantId: string, facilityId?: string) {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-tenant-id": tenantId,
    "item-time-zone": "America/Los_Angeles",
  };
  if (facilityId) h["x-facility-id"] = facilityId;
  return h;
}

function normalizeName(value: string): string {
  return String(value || "")
    .toUpperCase()
    .replace(/&/g, "AND")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

async function wmsGet<T>(
  path: string,
  token: string,
  tenantId: string,
  facilityId?: string
): Promise<T> {
  const res = await fetch(`${WMS_API_BASE_URL}${path}`, {
    headers: authHeaders(token, tenantId, facilityId),
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok || (json.code && String(json.code) !== "0")) {
    throw new Error(json.msg || `WMS API error: ${res.status}`);
  }
  return (json.data ?? json) as T;
}

async function wmsPost<T>(
  path: string,
  body: unknown,
  token: string,
  tenantId: string,
  facilityId?: string
): Promise<T> {
  const res = await fetch(`${WMS_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...authHeaders(token, tenantId, facilityId),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok || (json.code && String(json.code) !== "0")) {
    throw new Error(json.msg || `WMS API error: ${res.status}`);
  }
  return (json.data ?? json) as T;
}

async function wmsSearchAllPages<T>(
  path: string,
  body: Record<string, unknown>,
  token: string,
  tenantId: string,
  facilityId: string,
  pageSize = 500
): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;

  while (page <= 50) {
    const result = await wmsPost<{ list?: T[]; records?: T[]; total?: number }>(
      path,
      { ...body, page, pageSize },
      token,
      tenantId,
      facilityId
    );
    const pageRows = result.list ?? result.records ?? [];
    rows.push(...pageRows);

    const total = Number(result.total ?? 0);
    if (pageRows.length < pageSize) break;
    if (total > 0 && rows.length >= total) break;
    page += 1;
  }

  return rows;
}

export async function getUserProfile(
  userId: string,
  token: string,
  tenantId: string
): Promise<{
  id: string;
  accountId: string;
  companyCode: string;
  email: string;
  firstName: string;
  lastName: string;
  userName: string;
  profile?: {
    facilities: { id: string; name: string; timeZone: string }[];
    defaultFacility: { id: string; name: string };
  };
}> {
  return wmsGet(`/wms-bam/user/${userId}`, token, tenantId);
}

interface WmsOrderRecord {
  id: string;
  status: string;
  customerId: string;
  carrierId: string;
  retailerId: string;
  shipMethod: string;
  deliveryService?: string;
  orderType: string;
  source: string;
  referenceNo?: string;
  referenceNo01?: string;
  poNo?: string;
  createdTime?: string;
  scheduleDate?: string;
  shipNoLater?: string;
  shipToAddress?: { name?: string };
  loadNo?: string;
}

// Known customer names mapped from org IDs seen in the data
const KNOWN_CUSTOMERS: Record<string, string> = {
  "ORG-368834": "FLAG AND ANTHEM",
  "ORG-644329": "NZXT",
  "ORG-738412": "GURUNANDA",
};

async function batchResolveOrgNames(
  orgIds: Set<string>,
  token: string,
  tenantId: string
): Promise<Map<string, string>> {
  const orgMap = new Map<string, string>();

  // Use known mappings first
  for (const id of orgIds) {
    if (KNOWN_CUSTOMERS[id]) {
      orgMap.set(id, KNOWN_CUSTOMERS[id]);
    }
  }

  // Try to resolve remaining IDs from MDM customer search
  const unresolved = Array.from(orgIds).filter((id) => !orgMap.has(id));
  if (unresolved.length === 0) return orgMap;

  try {
    const result = await wmsPost<{ records?: { id: string; name: string }[] }>(
      "/mdm/customer/search",
      { orgIds: unresolved },
      token,
      tenantId
    );
    for (const rec of result.records ?? []) {
      if (rec.id && rec.name) orgMap.set(rec.id, rec.name);
    }
  } catch {
    // MDM lookup unavailable; we'll use IDs as names
  }

  // Fallback: use org ID itself
  for (const id of unresolved) {
    if (!orgMap.has(id)) orgMap.set(id, id);
  }

  return orgMap;
}

// Resolve customer name from order data
function resolveCustomerName(
  order: WmsOrderRecord,
  orgMap: Map<string, string>
): string {
  const id = order.customerId;
  if (id && orgMap.has(id) && orgMap.get(id) !== id) return orgMap.get(id)!;
  // Use ship-to name as fallback
  if (order.shipToAddress?.name) return order.shipToAddress.name;
  return id ?? "";
}

export async function searchPlannedOrders(
  token: string,
  tenantId: string,
  facilityId: string,
  statuses: string[]
): Promise<{ rows: WmsPlannedOrder[]; supported: boolean }> {
  try {
    const orders = await wmsSearchAllPages<WmsOrderRecord>(
      "/wms/outbound/order/search-by-paging",
      { statuses },
      token,
      tenantId,
      facilityId
    );

    const orgIds = new Set<string>();
    for (const o of orders) {
      if (o.customerId) orgIds.add(o.customerId);
      if (o.carrierId) orgIds.add(o.carrierId);
    }

    const orgMap = await batchResolveOrgNames(orgIds, token, tenantId);

    const rows: WmsPlannedOrder[] = orders.map((o) => ({
      orderNumber: o.id,
      customer: resolveCustomerName(o, orgMap),
      customerId: o.customerId ?? "",
      status: o.status,
      reference: o.referenceNo || o.poNo || o.referenceNo01 || "",
      created: o.createdTime ?? "",
      shipMethod: o.shipMethod ?? "",
      carrier: orgMap.get(o.carrierId) ?? o.carrierId ?? "",
      carrierId: o.carrierId ?? "",
      scheduleDate: o.scheduleDate ?? "",
      mabd: o.shipNoLater ?? "",
      orderType: o.orderType ?? "",
      source: o.source ?? "",
    }));

    return { rows, supported: true };
  } catch {
    return { rows: [], supported: false };
  }
}

export async function searchInYardEquipment(
  token: string,
  tenantId: string,
  facilityId: string
): Promise<{ rows: WmsInYardEquipment[]; supported: boolean }> {
  try {
    const equipment = await wmsSearchAllPages<Record<string, unknown>>(
      "/wms-bam/entry-ticket/search-by-paging",
      {
        statuses: [
          "Gate Checked In",
          "Window Checked In",
          "Dock Checked In",
          "Waiting",
        ],
      },
      token,
      tenantId,
      facilityId
    );

    const rows: WmsInYardEquipment[] = equipment.map((e) => ({
      equipmentNumber: String(
        e.equipmentNumber ?? e.equipment_id ?? e.equipmentId ?? ""
      ),
      entryTicket: String(
        e.entryTicket ?? e.entry_ticket ?? e.ticketId ?? e.id ?? e.entryId ?? ""
      ),
      checkIn: String(e.checkIn ?? e.check_in ?? e.createdTime ?? e.gateCheckInTime ?? ""),
      timeInYard: String(
        e.timeInYard ?? e.time_in_yard ?? e.yardTime ?? e.yardDuration ?? ""
      ),
      customer: String(
        e.customer ?? e.customerName ?? e.customerId ?? ""
      ),
    }));

    return { rows, supported: true };
  } catch {
    return { rows: [], supported: false };
  }
}

export async function loadDashboard(
  token: string,
  tenantId: string,
  facilityId: string,
  facilityName: string,
  tab?: string
): Promise<WmsDashboardData> {
  const now = new Date().toISOString();

  const [plannedOrders, inYard] = await Promise.all([
    searchPlannedOrders(token, tenantId, facilityId, [
      "PLANNED",
      "IMPORTED",
      "APPROVED",
    ]),
    searchInYardEquipment(token, tenantId, facilityId),
  ]);

  const excludedNightShiftCustomers = new Set([normalizeName("Euromarket designs")]);
  const plannedRows = tab === "nightShift"
    ? plannedOrders.rows.filter((r) => !excludedNightShiftCustomers.has(normalizeName(r.customer)))
    : plannedOrders.rows;

  const customerNames = new Set(
    plannedRows.map((r) => r.customer).filter(Boolean)
  );
  const customerSet = Array.from(customerNames).map((name) => ({ name }));

  return {
    title: facilityName,
    siteLabel: facilityName,
    source: "WISE",
    refreshedAt: now,
    generatedAt: now,
    customer: { name: customerSet[0]?.name ?? facilityName },
    customerSet,
    plannedOrders: {
      supported: plannedOrders.supported,
      rows: plannedRows,
    },
    inYardFullEquipment: {
      supported: inYard.supported,
      rows: inYard.rows,
      candidateCount: inYard.rows.length,
    },
  };
}
