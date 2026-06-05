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
  reportType?: string;
  metrics?: { label: string; value: string; sub?: string }[];
  evelynGreen?: {
    supported: boolean;
    rows: { kind: "customer" | "status"; level: number; label: string; orderCount: number; baseQty: number }[];
    total: { orderCount: number; baseQty: number };
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


const TEAM_2_LTL_PIVOT_ROWS: { kind: "customer" | "status"; level: number; label: string; orderCount: number; baseQty: number }[] = [
  { kind: "customer", level: 0, label: "BOUNDLESS EC US LLC", orderCount: 39, baseQty: 396 },
  { kind: "status", level: 1, label: "PICKED", orderCount: 4, baseQty: 48 },
  { kind: "status", level: 1, label: "PLANNED", orderCount: 35, baseQty: 348 },
  { kind: "customer", level: 0, label: "DIVERGENTIP, LLC DBA BRUVI", orderCount: 1, baseQty: 1450 },
  { kind: "status", level: 1, label: "COMMIT_BLOCKED", orderCount: 1, baseQty: 1450 },
  { kind: "customer", level: 0, label: "ELEVATE BRANDS OPCO LLC", orderCount: 1, baseQty: 8856 },
  { kind: "status", level: 1, label: "PLANNED", orderCount: 1, baseQty: 8856 },
  { kind: "customer", level: 0, label: "ELEVATE BRANDS UK OPCO LTD", orderCount: 1, baseQty: 6598 },
  { kind: "status", level: 1, label: "PICKED", orderCount: 1, baseQty: 6598 },
  { kind: "customer", level: 0, label: "EMBER TECHNOLOGIES, INC.", orderCount: 11, baseQty: 3552 },
  { kind: "status", level: 1, label: "COMMITTED", orderCount: 8, baseQty: 76 },
  { kind: "status", level: 1, label: "PICKED", orderCount: 2, baseQty: 776 },
  { kind: "status", level: 1, label: "PICKING", orderCount: 1, baseQty: 2700 },
  { kind: "customer", level: 0, label: "KARAKA, LLC", orderCount: 29, baseQty: 61052 },
  { kind: "status", level: 1, label: "COMMITTED", orderCount: 3, baseQty: 1848 },
  { kind: "status", level: 1, label: "PARTIAL_SHIPPED", orderCount: 1, baseQty: 5704 },
  { kind: "status", level: 1, label: "PICKED", orderCount: 20, baseQty: 33712 },
  { kind: "status", level: 1, label: "PICKING", orderCount: 2, baseQty: 9460 },
  { kind: "status", level: 1, label: "PLANNED", orderCount: 3, baseQty: 10328 },
  { kind: "customer", level: 0, label: "PRISMA INTERNATIONAL LLC", orderCount: 1, baseQty: 220 },
  { kind: "status", level: 1, label: "OPEN", orderCount: 1, baseQty: 220 },
  { kind: "customer", level: 0, label: "SELLERX COMMERCE GMBH", orderCount: 1, baseQty: 66503 },
  { kind: "status", level: 1, label: "PICKING", orderCount: 1, baseQty: 66503 },
  { kind: "customer", level: 0, label: "SIMPLE MODERN", orderCount: 93, baseQty: 84628 },
  { kind: "status", level: 1, label: "PLANNED", orderCount: 93, baseQty: 84628 },
  { kind: "customer", level: 0, label: "STRETTON ONLINE LTD", orderCount: 17, baseQty: 35341 },
  { kind: "status", level: 1, label: "IMPORTED", orderCount: 2, baseQty: 4816 },
  { kind: "status", level: 1, label: "PICKED", orderCount: 5, baseQty: 3230 },
  { kind: "status", level: 1, label: "PICKING", orderCount: 1, baseQty: 700 },
  { kind: "status", level: 1, label: "PLANNED", orderCount: 9, baseQty: 26595 },
  { kind: "customer", level: 0, label: "TORQUAY ETRADING LLC", orderCount: 12, baseQty: 163701 },
  { kind: "status", level: 1, label: "COMMIT_BLOCKED", orderCount: 1, baseQty: 440 },
  { kind: "status", level: 1, label: "COMMIT_FAILED", orderCount: 1, baseQty: 29652 },
  { kind: "status", level: 1, label: "PICKING", orderCount: 2, baseQty: 76208 },
  { kind: "status", level: 1, label: "PLANNED", orderCount: 8, baseQty: 57401 },
  { kind: "customer", level: 0, label: "TRIPLELITE, LLC", orderCount: 1, baseQty: 48 },
  { kind: "status", level: 1, label: "PICKED", orderCount: 1, baseQty: 48 },
  { kind: "customer", level: 0, label: "UNIVERA BRANDS", orderCount: 1, baseQty: 2478 },
  { kind: "status", level: 1, label: "PLANNED", orderCount: 1, baseQty: 2478 },
];

function buildStaticTeam2LtlDashboard(facilityName: string): WmsDashboardData {
  const now = new Date().toISOString();
  const customerSet = TEAM_2_LTL_PIVOT_ROWS
    .filter((row) => row.kind === "customer")
    .map((row) => ({ name: row.label }));
  return {
    title: "Team 2 LTL",
    siteLabel: facilityName,
    source: "Alfredo.xlsx",
    refreshedAt: now,
    generatedAt: now,
    customer: { name: "Team 2 LTL" },
    customerSet,
    reportType: "evelynGreenPivot",
    metrics: [
      { label: "Count of Order", value: "208" },
      { label: "Sum of BASE QTY", value: "436823" },
      { label: "Customers", value: "13" },
    ],
    plannedOrders: { supported: true, rows: [] },
    inYardFullEquipment: { supported: true, rows: [], candidateCount: 0 },
    evelynGreen: {
      supported: true,
      rows: TEAM_2_LTL_PIVOT_ROWS,
      total: { orderCount: 208, baseQty: 436823 },
    },
  };
}

async function buildBay2AutoAssignDashboard(
  facilityName: string,
  token: string,
  tenantId: string,
  facilityId: string
): Promise<WmsDashboardData> {
  const now = new Date().toISOString();

  // Fetch latest Graza order plans from WMS
  let grazaPlans: Array<{
    orderPlanId: string;
    planStatus: string;
    pickMethod: string;
    taskIds: string[];
    orderCount: number;
    assigneeName: string;
    planCreated: string;
    tags: string[];
  }> = [];
  let totalOrders = 0;
  let totalWaves = 0;
  let totalBatches = 0;

  try {
    const planResult = await wmsPost<{
      list?: Array<{
        id: string;
        status: string;
        pickMethod: string;
        pickTaskIds: string[];
        orderIds: string[];
        createdTime: string;
        defaultAssigneeUserId: string;
        taskTags: string[];
      }>;
    }>(
      "/wms-bam/outbound/order-plan/search-by-paging",
      {
        customerIds: ["ORG-747717"],
        pageSize: 30,
        currentPage: 1,
        sortingFields: [{ field: "createdTime", orderBy: "DESC" }],
      },
      token,
      tenantId,
      facilityId
    );

    const plans = planResult.list ?? [];

    // Resolve assignee user names
    const userIds = new Set(
      plans.map((p) => p.defaultAssigneeUserId).filter(Boolean)
    );
    const userNameMap = new Map<string, string>();
    for (const uid of userIds) {
      try {
        const userRes = await wmsGet<{
          firstName?: string;
          lastName?: string;
          userName?: string;
        }>(`/wms-bam/user/${uid}`, token, tenantId);
        if (userRes) {
          userNameMap.set(
            uid,
            [userRes.firstName, userRes.lastName].filter(Boolean).join(" ") ||
              userRes.userName ||
              uid
          );
        }
      } catch {
        userNameMap.set(uid, uid);
      }
    }

    grazaPlans = plans.map((p) => {
      const isWave = (p.pickMethod || "").includes("WAVE");
      if (isWave) totalWaves++;
      else totalBatches++;
      totalOrders += (p.orderIds || []).length;
      return {
        orderPlanId: p.id,
        planStatus: p.status,
        pickMethod: p.pickMethod || "",
        taskIds: p.pickTaskIds || [],
        orderCount: (p.orderIds || []).length,
        assigneeName: userNameMap.get(p.defaultAssigneeUserId) || p.defaultAssigneeUserId || "",
        planCreated: p.createdTime || "",
        tags: p.taskTags || [],
      };
    });
  } catch {
    // If fetching fails, show empty state
  }

  // Build metrics
  const metrics: { label: string; value: string; sub?: string }[] = [
    { label: "Graza Orders Batched", value: String(totalOrders) },
    { label: "Wave Groups", value: String(totalWaves) },
    { label: "Batches", value: String(totalBatches) },
  ];

  // Convert plans to planned order rows for display
  const plannedRows: WmsPlannedOrder[] = grazaPlans.map((p) => ({
    orderNumber: p.orderPlanId,
    customer: "DRUPLEY INC / DBA GRAZA",
    customerId: "ORG-747717",
    status: `${p.planStatus} · ${p.pickMethod}`,
    reference: p.tags.join(", ") || "Graza Auto",
    created: p.planCreated,
    shipMethod: `${p.orderCount} orders`,
    carrier: `Tasks: ${p.taskIds.join(", ")}`,
    carrierId: "",
    scheduleDate: p.assigneeName,
    mabd: "",
    orderType: "DS",
    source: "Auto Assign",
  }));

  const customerSet = [{ name: "DRUPLEY INC / DBA GRAZA" }];

  return {
    title: "Team 2 Auto Assign",
    siteLabel: facilityName,
    source: "WMS Auto Assign",
    refreshedAt: now,
    generatedAt: now,
    customer: { name: "DRUPLEY INC / DBA GRAZA" },
    customerSet,
    metrics,
    plannedOrders: {
      supported: true,
      rows: plannedRows,
    },
    inYardFullEquipment: {
      supported: true,
      rows: [],
      candidateCount: 0,
    },
  };
}

export async function loadDashboard(
  token: string,
  tenantId: string,
  facilityId: string,
  facilityName: string,
  tab?: string,
  includeAllCustomers = false
): Promise<WmsDashboardData> {
  const now = new Date().toISOString();

  if (tab === "evelyn") {
    return buildStaticTeam2LtlDashboard(facilityName);
  }

  if (tab === "bay2AutoAssign") {
    return buildBay2AutoAssignDashboard(facilityName, token, tenantId, facilityId);
  }

  const [plannedOrders, inYard] = await Promise.all([
    searchPlannedOrders(token, tenantId, facilityId, [
      "PLANNED",
      "IMPORTED",
      "APPROVED",
    ]),
    searchInYardEquipment(token, tenantId, facilityId),
  ]);

  const excludedNightShiftCustomers = new Set([normalizeName("Euromarket designs")]);
  const plannedRows = tab === "nightShift" && !includeAllCustomers
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
// deploy: Graza RUN11 — 2026-06-05 00:02 PDT — 0 orders matching filter, all 12 PLANNING
