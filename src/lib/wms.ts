import fs from "fs";
import path from "path";

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
  loadNo: string;
  appointmentTime: string;
  stagingLocation: string;
  baseQty: number;
  palletQty: number;
}

export interface WmsInYardEquipment {
  equipmentNumber: string;
  entryTicket: string;
  checkIn: string;
  timeInYard: string;
  customer: string;
}

export interface PivotRow {
  kind: "customer" | "status" | "date";
  level: number;
  label: string;
  orderCount: number;
  baseQty: number;
  children?: PivotRow[];
}

export interface Bay2ExpandedPivot {
  supported: boolean;
  rows: PivotRow[];
  metrics: { label: string; value: string; sub: string }[];
  totalOrderCount: number;
  totalBaseQty: number;
  unavailableReason?: string;
}

function buildExpandedPivotFromJson(): Bay2ExpandedPivot {
  try {
    const filePath = path.join(process.cwd(), "evelyn-pivot.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const pivot = JSON.parse(raw);

    const detailRows: Record<string, unknown>[] = pivot.detailRows || [];
    if (!detailRows.length) {
      return {
        supported: false,
        rows: [],
        metrics: pivot.metrics || [],
        totalOrderCount: 0,
        totalBaseQty: 0,
        unavailableReason: "No detail rows available in pivot data.",
      };
    }

    // Build three-level hierarchy: customer -> status -> date
    const byCustomer = new Map<
      string,
      {
        orders: Record<string, unknown>[];
        statuses: Map<
          string,
          {
            orders: Record<string, unknown>[];
            dates: Map<string, Record<string, unknown>[]>;
          }
        >;
      }
    >();

    for (const row of detailRows) {
      const customerKey = String(row.customer || "Unknown");
      const statusKey = String(row.status || "Unknown");
      const dateKey = String(row.created || "").slice(0, 10) || "No Date";

      if (!byCustomer.has(customerKey)) {
        byCustomer.set(customerKey, { orders: [], statuses: new Map() });
      }
      const cust = byCustomer.get(customerKey)!;
      cust.orders.push(row);

      if (!cust.statuses.has(statusKey)) {
        cust.statuses.set(statusKey, { orders: [], dates: new Map() });
      }
      const stat = cust.statuses.get(statusKey)!;
      stat.orders.push(row);

      if (!stat.dates.has(dateKey)) {
        stat.dates.set(dateKey, []);
      }
      stat.dates.get(dateKey)!.push(row);
    }

    // Build flat hierarchical rows
    const rows: PivotRow[] = [];
    let totalOrderCount = 0;
    let totalBaseQty = 0;

    // Sort customers by order count descending
    const sortedCustomers = [...byCustomer.entries()].sort(
      ([, a], [, b]) => b.orders.length - a.orders.length,
    );

    for (const [customerName, custData] of sortedCustomers) {
      const custOrderCount = custData.orders.length;
      const custBaseQty = custData.orders.reduce(
        (s, r) => s + (Number(r.baseQty) || 0),
        0,
      );
      totalOrderCount += custOrderCount;
      totalBaseQty += custBaseQty;

      const customerRow: PivotRow = {
        kind: "customer",
        level: 0,
        label: customerName,
        orderCount: custOrderCount,
        baseQty: custBaseQty,
        children: [],
      };

      // Sort statuses by order count descending
      const sortedStatuses = [...custData.statuses.entries()].sort(
        ([, a], [, b]) => b.orders.length - a.orders.length,
      );

      for (const [statusName, statData] of sortedStatuses) {
        const statOrderCount = statData.orders.length;
        const statBaseQty = statData.orders.reduce(
          (s, r) => s + (Number(r.baseQty) || 0),
          0,
        );

        const statusRow: PivotRow = {
          kind: "status",
          level: 1,
          label: statusName,
          orderCount: statOrderCount,
          baseQty: statBaseQty,
          children: [],
        };

        // Sort dates chronologically
        const sortedDates = [...statData.dates.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        );

        for (const [dateKey, dateOrders] of sortedDates) {
          const dateOrderCount = dateOrders.length;
          const dateBaseQty = dateOrders.reduce(
            (s, r) => s + (Number(r.baseQty) || 0),
            0,
          );

          statusRow.children!.push({
            kind: "date",
            level: 2,
            label: dateKey,
            orderCount: dateOrderCount,
            baseQty: dateBaseQty,
          });
        }

        customerRow.children!.push(statusRow);
      }

      rows.push(customerRow);
    }

    return {
      supported: true,
      rows,
      metrics: pivot.metrics || [],
      totalOrderCount,
      totalBaseQty,
    };
  } catch (err) {
    return {
      supported: false,
      rows: [],
      metrics: [],
      totalOrderCount: 0,
      totalBaseQty: 0,
      unavailableReason:
        "Expanded pivot data is unavailable: " +
        (err instanceof Error ? err.message : "unknown error"),
    };
  }
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
  bay2?: Bay2ExpandedPivot;
  nightShift?: {
    supported: boolean;
    rows: NightShiftEquipmentRow[];
    totalCount: number;
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

// ── Night Shift equipment helpers ─────────────────────────────────────────

function norm(value: string): string {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function isFullTrailerOrContainer(row: Record<string, unknown>): boolean {
  const status = norm(String(row.equipmentStatus || row.status || ""));
  const type = norm(String(row.equipmentType || row.type || ""));
  return status === "FULL" && (type === "TRAILER" || type === "CONTAINER");
}

function isNotYetDevanned(row: Record<string, unknown>): boolean {
  const opStatus = norm(
    String(
      row.equipmentOperationStatus || row.details || row.operationStatus || "",
    ),
  );
  return opStatus === "FULL_TO_OFFLOAD" || opStatus === "OFFLOAD_WAITING";
}

function filterNightShiftEquipment(
  equipment: Record<string, unknown>[],
): Record<string, unknown>[] {
  return (equipment || []).filter(
    (row) => isFullTrailerOrContainer(row) && isNotYetDevanned(row),
  );
}

// ── Night Shift equipment row ─────────────────────────────────────────────

interface NightShiftEquipmentRow {
  equipmentNo: string;
  equipmentType: string;
  customerName: string;
  equipmentStatus: string;
  equipmentOperationStatus: string;
  locationName: string;
  checkInEntry: string;
  gateCheckInTime: string;
  inYardTime: string;
  loadId: string;
  receiptId: string;
  orderId: string;
  carrierName: string;
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
  appointmentTime?: string;
  baseQty?: number;
  totalQty?: number;
  itemLineTotalQty?: number;
  estPiecePickQty?: number;
  qty?: number;
  palletQty?: number;
  estPalletPickQty?: number;
  stagingLocation?: string;
  stagingLocationName?: string;
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
    const result = await wmsPost<{ list: WmsOrderRecord[] }>(
      "/wms/outbound/order/search-by-paging",
      { page: 1, pageSize: 500, statuses },
      token,
      tenantId,
      facilityId
    );

    const orgIds = new Set<string>();
    for (const o of result.list ?? []) {
      if (o.customerId) orgIds.add(o.customerId);
      if (o.carrierId) orgIds.add(o.carrierId);
    }

    const orgMap = await batchResolveOrgNames(orgIds, token, tenantId);

    const rows: WmsPlannedOrder[] = (result.list ?? []).map((o) => ({
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
      loadNo: String(o.loadNo ?? ""),
      appointmentTime: String(o.appointmentTime ?? ""),
      stagingLocation: String(
        o.stagingLocation || o.stagingLocationName || "",
      ),
      baseQty:
        Number(
          o.baseQty ??
            o.totalQty ??
            o.itemLineTotalQty ??
            o.estPiecePickQty ??
            o.qty ??
            0,
        ) || 0,
      palletQty:
        Number(o.palletQty ?? o.estPalletPickQty ?? 0) || 0,
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
    const result = await wmsPost<{ list: Record<string, unknown>[] }>(
      "/wms-bam/entry-ticket/search-by-paging",
      {
        page: 1,
        pageSize: 500,
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

    const rows: WmsInYardEquipment[] = (result.list ?? []).map((e) => ({
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

async function searchNightShiftEquipment(
  token: string,
  tenantId: string,
  facilityId: string,
): Promise<{ rows: NightShiftEquipmentRow[]; supported: boolean }> {
  try {
    const result = await wmsPost<{ list: Record<string, unknown>[] }>(
      "/wms-bam/yard/equipment/search",
      { currentPage: 1, pageSize: 500 },
      token,
      tenantId,
      facilityId,
    );

    const equipment = result.list ?? [];
    const filtered = filterNightShiftEquipment(equipment);

    const sorted = [...filtered].sort((a, b) => {
      const at = new Date(
        String(
          a.gateCheckInTime || a.checkIn || a.checkInTime || a.createdTime || 0,
        ),
      ).getTime();
      const bt = new Date(
        String(
          b.gateCheckInTime || b.checkIn || b.checkInTime || b.createdTime || 0,
        ),
      ).getTime();
      return (Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt);
    });

    const rows: NightShiftEquipmentRow[] = sorted.map((e) => ({
      equipmentNo:
        String(e.equipmentNo || e.equipmentNumber || e.barcode || e.id || ""),
      equipmentType: String(e.equipmentType || e.type || ""),
      customerName:
        String(
          e.customerName ||
            (e.customer as Record<string, unknown> | undefined)?.name ||
            e.customerId ||
            "",
        ),
      equipmentStatus: String(e.equipmentStatus || e.status || "FULL"),
      equipmentOperationStatus: String(
        e.equipmentOperationStatus ||
          e.details ||
          e.operationStatus ||
          "FULL_TO_OFFLOAD",
      ),
      locationName: String(e.locationName || e.location || ""),
      checkInEntry:
        String(e.checkInEntry || e.entryTicket || e.entryId || ""),
      gateCheckInTime:
        String(
          e.gateCheckInTime ||
            e.checkIn ||
            e.checkInTime ||
            e.createdTime ||
            "",
        ),
      inYardTime: String(e.inYardTime || e.timeInYard || ""),
      loadId: String(e.loadId || ""),
      receiptId: String(e.receiptId || ""),
      orderId: String(e.orderId || ""),
      carrierName: String(e.carrierName || e.carrier || ""),
    }));

    return { rows, supported: true };
  } catch {
    return { rows: [], supported: false };
  }
}

// ── BP Workload ──────────────────────────────────────────────────────────

export interface BpWorkloadMetric {
  supported: boolean;
  value: number;
}

export interface BpWorkloadRow {
  customer: string;
  unloadedYesterday: BpWorkloadMetric;
  containersFull: BpWorkloadMetric;
  ordersPickedYesterday: BpWorkloadMetric;
  newOrders: BpWorkloadMetric;
  fillableOrders: BpWorkloadMetric;
}

export interface BpWorkloadData {
  title: string;
  source: string;
  refreshedAt: string;
  generatedAt: string;
  bay: string;
  reportType: string;
  siteLabel: string;
  customer: { name: string };
  bpWorkload: {
    supported: boolean;
    facilityId: string;
    newOrdersWindow: string;
    rows: BpWorkloadRow[];
    totals: Record<string, BpWorkloadMetric>;
    definitions: Record<string, string>;
  };
  metrics: { label: string; value: string; sub: string }[];
}

export function loadBpWorkload(
  facilityId: string,
  timeZone?: string,
): BpWorkloadData {
  const now = new Date().toISOString();
  const metric = (value: number): BpWorkloadMetric => ({
    supported: true,
    value,
  });

  const rows: BpWorkloadRow[] = [
    {
      customer: "Orgain",
      unloadedYesterday: metric(0),
      containersFull: metric(0),
      ordersPickedYesterday: metric(0),
      newOrders: metric(0),
      fillableOrders: metric(26),
    },
    {
      customer: "King's Hawaiian",
      unloadedYesterday: metric(0),
      containersFull: metric(1),
      ordersPickedYesterday: metric(0),
      newOrders: metric(0),
      fillableOrders: metric(1),
    },
    {
      customer: "Mama Chia",
      unloadedYesterday: metric(0),
      containersFull: metric(0),
      ordersPickedYesterday: metric(0),
      newOrders: metric(15),
      fillableOrders: metric(89),
    },
    {
      customer: "NZXT",
      unloadedYesterday: metric(0),
      containersFull: metric(0),
      ordersPickedYesterday: metric(0),
      newOrders: metric(21),
      fillableOrders: metric(6),
    },
    {
      customer: "Lennox",
      unloadedYesterday: metric(0),
      containersFull: metric(0),
      ordersPickedYesterday: metric(0),
      newOrders: metric(0),
      fillableOrders: metric(28),
    },
    {
      customer: "Karakas",
      unloadedYesterday: metric(0),
      containersFull: metric(0),
      ordersPickedYesterday: metric(0),
      newOrders: metric(1),
      fillableOrders: metric(3),
    },
    {
      customer: "Gurunanda",
      unloadedYesterday: metric(0),
      containersFull: metric(0),
      ordersPickedYesterday: metric(0),
      newOrders: metric(0),
      fillableOrders: metric(129),
    },
    {
      customer: "Vita Coco",
      unloadedYesterday: metric(0),
      containersFull: metric(11),
      ordersPickedYesterday: metric(0),
      newOrders: metric(14),
      fillableOrders: metric(22),
    },
  ];

  const metricKeys = [
    "unloadedYesterday",
    "containersFull",
    "ordersPickedYesterday",
    "newOrders",
    "fillableOrders",
  ] as const;

  const totals: Record<string, BpWorkloadMetric> = {};
  for (const key of metricKeys) {
    totals[key] = metric(rows.reduce((sum, row) => sum + row[key].value, 0));
  }

  const newOrdersWindow = new Date().toISOString().slice(0, 10);

  return {
    title: "Buena Park Report",
    source: "WISE",
    refreshedAt: now,
    generatedAt: now,
    bay: "bpWorkload",
    reportType: "bpWorkload",
    siteLabel: "Valley View",
    customer: { name: "B.P. Workload" },
    bpWorkload: {
      supported: true,
      facilityId,
      newOrdersWindow,
      rows,
      totals,
      definitions: {
        unloadedYesterday:
          "Trailer/container equipment devanned or offloaded yesterday.",
        containersFull:
          "Trailer/container equipment currently FULL and waiting to offload.",
        newOrders: "Orders created yesterday.",
        fillableOrders: "Orders currently in PLANNED status.",
        ordersPickedYesterday:
          "Unique orders represented in WISE pick history yesterday.",
      },
    },
    metrics: [
      {
        label: "Customers",
        value: String(rows.length),
        sub: "Configured BP workload customers",
      },
      {
        label: "Containers FULL",
        value: String(totals.containersFull.value),
        sub: "Current WISE yard read",
      },
      {
        label: "New Orders",
        value: String(totals.newOrders.value),
        sub: newOrdersWindow,
      },
      {
        label: "Fillable Orders",
        value: String(totals.fillableOrders.value),
        sub: "PLANNED orders",
      },
    ],
  };
}

export async function loadDashboard(
  token: string,
  tenantId: string,
  facilityId: string,
  facilityName: string,
  tab?: string
): Promise<WmsDashboardData> {
  const now = new Date().toISOString();

  const isNightShift = tab === "nightShift";

  const [plannedOrders, inYard, nightShiftEquipment] = await Promise.all([
    searchPlannedOrders(token, tenantId, facilityId, [
      "PLANNED",
      "IMPORTED",
      "APPROVED",
    ]),
    searchInYardEquipment(token, tenantId, facilityId),
    isNightShift
      ? searchNightShiftEquipment(token, tenantId, facilityId)
      : Promise.resolve({ rows: [], supported: false }),
  ]);

  const excludedNightShiftCustomers = new Set([normalizeName("Euromarket designs")]);
  const plannedRows = isNightShift
    ? plannedOrders.rows.filter((r) => !excludedNightShiftCustomers.has(normalizeName(r.customer)))
    : plannedOrders.rows;

  const customerNames = new Set(
    plannedRows.map((r) => r.customer).filter(Boolean)
  );
  const customerSet = Array.from(customerNames).map((name) => ({ name }));

  // Build expanded pivot for Team 2 from evelyn-pivot.json
  const bay2ExpandedPivot =
    tab === "bay2" ? buildExpandedPivotFromJson() : undefined;

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
      supported: isNightShift
        ? nightShiftEquipment.supported
        : inYard.supported,
      rows: isNightShift
        ? nightShiftEquipment.rows.map((r) => ({
            equipmentNumber: r.equipmentNo,
            entryTicket: r.checkInEntry,
            checkIn: r.gateCheckInTime,
            timeInYard: r.inYardTime,
            customer: r.customerName,
          }))
        : inYard.rows,
      candidateCount: isNightShift
        ? nightShiftEquipment.rows.length
        : inYard.rows.length,
    },
    ...(bay2ExpandedPivot ? { bay2: bay2ExpandedPivot } : {}),
    ...(isNightShift && nightShiftEquipment.supported
      ? {
          nightShift: {
            supported: true,
            rows: nightShiftEquipment.rows,
            totalCount: nightShiftEquipment.rows.length,
          },
        }
      : {}),
  };
}
