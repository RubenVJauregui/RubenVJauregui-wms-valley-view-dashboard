const express = require('express');
const path = require('path');
const fs = require('fs');

const IAM_BASE_URL = 'https://id.item.com';
const WMS_API_BASE_URL = 'https://unis.item.com/api';

const app = express();
app.use(express.json());

// ── Helpers ────────────────────────────────────────────────────────────────

function safeJsonParse(text, fallback = {}) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch { return null; }
}

async function fetchWmsUser(userId, accessToken, tenantId) {
  const res = await fetch(`${WMS_API_BASE_URL}/wms-bam/user/${userId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-tenant-id': tenantId,
    },
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.code !== 0 && String(json.code) !== '0') return null;
  return json.data;
}

// ── Auth Routes ────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'Enter your username and password.' });
  }

  try {
    // Exchange username/password for tokens via IAM
    const iamRes = await fetch(`${IAM_BASE_URL}/auth/exchange-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', username, password }),
    });
    const iamJson = await iamRes.json().catch(() => ({}));

    if (!iamRes.ok || (iamJson.code != null && String(iamJson.code) !== '0')) {
      return res.status(401).json({ message: iamJson.msg || iamJson.message || 'Sign in failed.' });
    }

    const accessToken = iamJson.data?.access_token || iamJson.access_token;
    const refreshToken = iamJson.data?.refresh_token || iamJson.refresh_token;
    const expiresIn = iamJson.data?.expires_in ?? iamJson.expires_in ?? 3600;

    if (!accessToken) {
      return res.status(401).json({ message: 'Sign in failed.' });
    }

    // Decode JWT to get identity
    const payload = decodeJwtPayload(accessToken);
    const identity = payload?.data ?? {};
    const userId = String(identity.user_id ?? '');
    const tenantId = String(identity.tenant_id ?? identity.company_code ?? '');

    if (!userId || !tenantId) {
      return res.status(401).json({ message: 'Warehouse access could not be loaded.' });
    }

    // Fetch user profile (facilities)
    const userData = await fetchWmsUser(userId, accessToken, tenantId);
    if (!userData || !userData.profile?.facilities?.length) {
      return res.status(401).json({ message: 'No warehouse access is available for this account.' });
    }

    const profile = userData.profile;
    const facilities = profile.facilities || [];
    const defaultFacility = profile.defaultFacility || facilities[0];

    return res.json({
      accessToken,
      refreshToken,
      expiresIn,
      identity: { user_id: userId, user_name: identity.user_name, tenant_id: tenantId },
      facilities,
      defaultFacility,
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ message: 'Sign in failed. Please try again.' });
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ message: 'Missing refresh token.' });
  }

  try {
    const iamRes = await fetch(
      `${IAM_BASE_URL}/auth/token/refresh?refreshToken=${encodeURIComponent(refreshToken)}`,
      { method: 'GET', headers: { 'content-type': 'application/json' } }
    );
    const iamJson = await iamRes.json().catch(() => ({}));

    if (!iamRes.ok) return res.status(401).json({ message: 'Session expired. Sign in again.' });

    const accessToken = iamJson.data?.access_token || iamJson.access_token;
    const newRefreshToken = iamJson.data?.refresh_token || iamJson.refresh_token;
    const expiresIn = iamJson.data?.expires_in ?? iamJson.expires_in ?? 3600;

    if (!accessToken) return res.status(401).json({ message: 'Session expired. Sign in again.' });

    const payload = decodeJwtPayload(accessToken);
    const identity = payload?.data ?? {};
    const userId = String(identity.user_id ?? '');
    const tenantId = String(identity.tenant_id ?? identity.company_code ?? '');

    return res.json({
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn,
      identity: { user_id: userId, user_name: identity.user_name, tenant_id: tenantId },
    });
  } catch (err) {
    console.error('Refresh error:', err);
    return res.status(500).json({ message: 'Session refresh failed.' });
  }
});

// ── Auth middleware ────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return res.status(401).json({ message: 'Authentication required.' });

  const payload = decodeJwtPayload(token);
  if (!payload) return res.status(401).json({ message: 'Invalid token.' });

  const identity = payload.data ?? {};
  req.userId = String(identity.user_id ?? '');
  req.tenantId = String(identity.tenant_id ?? identity.company_code ?? '');
  req.accessToken = token;

  if (!req.userId || !req.tenantId) {
    return res.status(401).json({ message: 'Warehouse access could not be loaded.' });
  }
  next();
}

// ── Organization name resolver (cached in-memory) ──────────────────────────

const orgNameCache = new Map(); // orgId -> name

async function resolveOrgName(orgId, accessToken, tenantId) {
  if (!orgId || !orgId.startsWith('ORG-')) return orgId || 'Unknown';
  if (orgNameCache.has(orgId)) return orgNameCache.get(orgId);

  try {
    const res = await fetch(
      `${WMS_API_BASE_URL}/mdm/organization/${encodeURIComponent(orgId)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'x-tenant-id': tenantId,
        },
      }
    );
    if (res.ok) {
      const json = await res.json();
      const name = json.data?.name || json.data?.orgName || orgId;
      orgNameCache.set(orgId, name);
      return name;
    }
  } catch {}
  return orgId;
}

async function resolveOrgNames(orgIds, accessToken, tenantId) {
  const unique = [...new Set(orgIds.filter(id => id && id.startsWith('ORG-')))];
  const results = {};
  await Promise.all(unique.map(async (id) => {
    results[id] = await resolveOrgName(id, accessToken, tenantId);
  }));
  return results;
}

// ── Dashboard data route ───────────────────────────────────────────────────

// ── Tab configuration ──────────────────────────────────────────────────────

/**
 * Maps a tab key (from body.tab or URL :variant) to display metadata.
 *
 * Special tab shapes:
 *  - bpWorkload       → bpWorkload.rows (B.P. Workload pivot)
 *  - crateBarrel      → crateEquipment.rows + planned orders
 *  - nightShift       → same shape as Team 4 but bay = "nightShift"
 *  - frontGuardShack  → assignment-based view (Front Guard Shack)
 *  - bay2AutoAssign   → assignment-based view (Team 2 Auto Assign)
 *  - bay4AutoAssign   → assignment-based view (Rear Guard Shack)
 *  - evelyn           → bay2Ecomm / evelynPivot / evelynGreenPivot
 */
const TAB_CONFIG = {
  bay1: { bay: 'bay1', reportType: 'bay1', title: 'Team 1', customerIds: ['ORG-655338','ORG-739504','ORG-536926','ORG-55783','ORG-625907','ORG-625900','ORG-629731','ORG-625904','ORG-729253','ORG-672896','ORG-646997','ORG-616507','ORG-740120','ORG-614850','ORG-674362','ORG-714892','ORG-601372','ORG-647815','ORG-625905','ORG-723580'] },
  bay2: { bay: 'bay2', reportType: 'bay2Ecomm', title: 'Team 2', customerNames: [
    'AMZN PREP - MATTRESSES','AMZN PREP - RGS','AS EVER ENTERPRISES, LLC','BABYARK INC','BOUNDLESS EC US LLC','DELTA ELECTRONICS','DUPRAY USA LLC','ELEVATE BRANDS OPCO LLC','NET HEALTH SHOPS LLC','NZXT','PRISMA INTERNATIONAL LLC','RIO ROUTER INC','ROAR BEVERAGES INC','SIMPLE MODERN','SLINGER BAG AMERICAS INC.','STRETTON ONLINE LTD','SUN NINJA LLC','THE MURRIETA RHINO HOLDCO LLC','TINYYO LIMITED','TORQUAY ETRADING LLC','TRIPLELITE, LLC','UNIVERA BRANDS',
    'MAMMA CHIA','THE FEELIST','OPAL CAMERA','BIRD OF CONDOR','BUMP','FLAG AND ANTHEM','VAONIS','EMBER','VITA COCO DTC','COME READY','PUNK BUNNY','THE OUAI','BYTE DANCE - TIKTOK','ZEN','RECOVERY','MUSE','RISEANDSHINE','WATERPLUS','UPTIME ENERGY','FHIRST','KACE TEA','SPLENDOR WATER'
  ], mezzanineCustomerNames: ['MAMMA CHIA','THE FEELIST','OPAL CAMERA','BIRD OF CONDOR','BUMP','FLAG AND ANTHEM','VAONIS','EMBER','VITA COCO DTC','COME READY','PUNK BUNNY','THE OUAI','BYTE DANCE - TIKTOK','ZEN','RECOVERY','MUSE','RISEANDSHINE','WATERPLUS','UPTIME ENERGY','FHIRST','KACE TEA','SPLENDOR WATER'] },
  bay3: { bay: 'bay3', reportType: 'bay3', title: 'Team 3', customerNames: ['TCL NORTH AMERICA','LENNOX INDUSTRIES INC.','AMIEE LYNN, LNC.','KARAKA, LLC','NZXT','CMPC USA (Cut Paper and Rolls)','WOODY FLAW CREST INC','North Star','CMPC USA','La Jolla','ESI','TPV USA','Gurunanda','the only bean'] },
  bay4: { bay: 'bay4', reportType: 'bay4', title: 'Team 4', customerIds: ['ORG-655875'], customerNames: ['GURUNANDA'] },
  bay5: { bay: 'bay5', reportType: 'bay5', title: 'Team 5', customerIds: ['ORG-34557','ORG-614850','ORG-755323','ORG-582188','ORG-646997','ORG-616507'] },
  evelyn: { bay: 'evelyn', reportType: 'evelynGreenPivot', title: 'Team 2 LTL', customerNames: ['BOUNDLESS EC US LLC','DIVERGENT LLC DBA BRUVI','EMBER TECHNOLOGIES, INC.','KARAKA, LLC','PM&J','PRISMA INTERNATIONAL LLC','SELLERX COMMERCE GMBH','SIMPLE MODERN','THOROGOOD SPORTS LTD c/o MXP PRIME PLATFORM','TORQUAY ETRADING LLC'] },
  crateBarrel: { bay: 'crateBarrel', reportType: 'crateEquipment', title: 'Crate & Barrel', customerIds: ['ORG-359565'] },
  bpWorkload: { bay: 'bpWorkload', reportType: 'bpWorkload', title: 'B.P. Workload' },
  nightShift: { bay: 'nightShift', reportType: 'nightShift', title: 'Night Shift' },
  bay4AutoAssign: { bay: 'bay4AutoAssign', reportType: 'bay4AutoAssign', title: 'Rear Guard Shack' },
  frontGuardShack: { bay: 'frontGuardShack', reportType: 'frontGuardPaused', title: 'Front Guard Shack' },
  bay2AutoAssign: { bay: 'bay2AutoAssign', reportType: 'bay2AutoAssign', title: 'Team 2 Auto Assign' },
};


const TEAM_2_LTL_PIVOT_ROWS = [
  { kind: 'customer', level: 0, label: 'BOUNDLESS EC US LLC', orderCount: 39, baseQty: 396 },
  { kind: 'status', level: 1, label: 'PICKED', orderCount: 4, baseQty: 48 },
  { kind: 'status', level: 1, label: 'PLANNED', orderCount: 35, baseQty: 348 },
  { kind: 'customer', level: 0, label: 'DIVERGENTIP, LLC DBA BRUVI', orderCount: 1, baseQty: 1450 },
  { kind: 'status', level: 1, label: 'COMMIT_BLOCKED', orderCount: 1, baseQty: 1450 },
  { kind: 'customer', level: 0, label: 'ELEVATE BRANDS OPCO LLC', orderCount: 1, baseQty: 8856 },
  { kind: 'status', level: 1, label: 'PLANNED', orderCount: 1, baseQty: 8856 },
  { kind: 'customer', level: 0, label: 'ELEVATE BRANDS UK OPCO LTD', orderCount: 1, baseQty: 6598 },
  { kind: 'status', level: 1, label: 'PICKED', orderCount: 1, baseQty: 6598 },
  { kind: 'customer', level: 0, label: 'EMBER TECHNOLOGIES, INC.', orderCount: 11, baseQty: 3552 },
  { kind: 'status', level: 1, label: 'COMMITTED', orderCount: 8, baseQty: 76 },
  { kind: 'status', level: 1, label: 'PICKED', orderCount: 2, baseQty: 776 },
  { kind: 'status', level: 1, label: 'PICKING', orderCount: 1, baseQty: 2700 },
  { kind: 'customer', level: 0, label: 'KARAKA, LLC', orderCount: 29, baseQty: 61052 },
  { kind: 'status', level: 1, label: 'COMMITTED', orderCount: 3, baseQty: 1848 },
  { kind: 'status', level: 1, label: 'PARTIAL_SHIPPED', orderCount: 1, baseQty: 5704 },
  { kind: 'status', level: 1, label: 'PICKED', orderCount: 20, baseQty: 33712 },
  { kind: 'status', level: 1, label: 'PICKING', orderCount: 2, baseQty: 9460 },
  { kind: 'status', level: 1, label: 'PLANNED', orderCount: 3, baseQty: 10328 },
  { kind: 'customer', level: 0, label: 'PRISMA INTERNATIONAL LLC', orderCount: 1, baseQty: 220 },
  { kind: 'status', level: 1, label: 'OPEN', orderCount: 1, baseQty: 220 },
  { kind: 'customer', level: 0, label: 'SELLERX COMMERCE GMBH', orderCount: 1, baseQty: 66503 },
  { kind: 'status', level: 1, label: 'PICKING', orderCount: 1, baseQty: 66503 },
  { kind: 'customer', level: 0, label: 'SIMPLE MODERN', orderCount: 93, baseQty: 84628 },
  { kind: 'status', level: 1, label: 'PLANNED', orderCount: 93, baseQty: 84628 },
  { kind: 'customer', level: 0, label: 'STRETTON ONLINE LTD', orderCount: 17, baseQty: 35341 },
  { kind: 'status', level: 1, label: 'IMPORTED', orderCount: 2, baseQty: 4816 },
  { kind: 'status', level: 1, label: 'PICKED', orderCount: 5, baseQty: 3230 },
  { kind: 'status', level: 1, label: 'PICKING', orderCount: 1, baseQty: 700 },
  { kind: 'status', level: 1, label: 'PLANNED', orderCount: 9, baseQty: 26595 },
  { kind: 'customer', level: 0, label: 'TORQUAY ETRADING LLC', orderCount: 12, baseQty: 163701 },
  { kind: 'status', level: 1, label: 'COMMIT_BLOCKED', orderCount: 1, baseQty: 440 },
  { kind: 'status', level: 1, label: 'COMMIT_FAILED', orderCount: 1, baseQty: 29652 },
  { kind: 'status', level: 1, label: 'PICKING', orderCount: 2, baseQty: 76208 },
  { kind: 'status', level: 1, label: 'PLANNED', orderCount: 8, baseQty: 57401 },
  { kind: 'customer', level: 0, label: 'TRIPLELITE, LLC', orderCount: 1, baseQty: 48 },
  { kind: 'status', level: 1, label: 'PICKED', orderCount: 1, baseQty: 48 },
  { kind: 'customer', level: 0, label: 'UNIVERA BRANDS', orderCount: 1, baseQty: 2478 },
  { kind: 'status', level: 1, label: 'PLANNED', orderCount: 1, baseQty: 2478 },
];

function applyStaticTeam2LtlPayload(result, now, siteLabel) {
  result.bay = 'evelyn';
  result.reportType = 'evelynGreenPivot';
  result.title = 'Team 2 LTL';
  result.customer = { name: 'Team 2 LTL' };
  result.customerSet = TEAM_2_LTL_PIVOT_ROWS.filter(r => r.kind === 'customer').map(r => ({ name: r.label }));
  result.metrics = [
    { label: 'Count of Order', value: '208' },
    { label: 'Sum of BASE QTY', value: '436823' },
    { label: 'Customers', value: '13' },
  ];
  result.evelynGreen = { supported: true, rows: TEAM_2_LTL_PIVOT_ROWS, total: { orderCount: 208, baseQty: 436823 } };
  result.detailRows = [];
  result.plannedOrders = { supported: true, rows: [] };
  result.inYardFullEquipment = { supported: true, rows: [] };
  result.refreshedAt = now;
  result.generatedAt = now;
  return result;
}

const BAY2_PATRICIA_SHEET3_METRICS = {
  'ROAR BEVERAGES INC': { orderCount: 497, baseQty: 700 },
  'DRUPLEY INC / DBA GRAZA': { orderCount: 94, baseQty: 672 },
  'NZXT': { orderCount: 86, baseQty: 182 },
  'AMZN PREP - RGS': { orderCount: 21, baseQty: 21 },
  'DUPRAY USA LLC': { orderCount: 16, baseQty: 25 },
  'AS EVER ENTERPRISES, LLC': { orderCount: 15, baseQty: 66 },
  'BOUNDLESS EC US LLC': { orderCount: 9, baseQty: 84 },
  'NET HEALTH SHOPS LLC': { orderCount: 7, baseQty: 7 },
  'SLINGER BAG AMERICAS INC.': { orderCount: 3, baseQty: 3 },
  'BABYARK INC': { orderCount: 3, baseQty: 3 },
  'TORQUAY ETRADING LLC': { orderCount: 1, baseQty: 638 },
  'ELEVATE BRANDS OPCO LLC': { orderCount: 1, baseQty: 1 },
  'DELTA ELECTRONICS (AMERICAS) LTD - NEW': { orderCount: 1, baseQty: 2 },
};


const BAY2_LEFT_DROPSHIP_CUSTOMERS = [
  'AMZN PREP - MATTRESSES','AMZN PREP - RGS','AS EVER ENTERPRISES, LLC','BABYARK INC','BOUNDLESS EC US LLC','DELTA ELECTRONICS','DUPRAY USA LLC','ELEVATE BRANDS OPCO LLC','NET HEALTH SHOPS LLC','NZXT','PRISMA INTERNATIONAL LLC','RIO ROUTER INC','ROAR BEVERAGES INC','SIMPLE MODERN','SLINGER BAG AMERICAS INC.','STRETTON ONLINE LTD','SUN NINJA LLC','THE MURRIETA RHINO HOLDCO LLC','TINYYO LIMITED','TORQUAY ETRADING LLC','TRIPLELITE, LLC','UNIVERA BRANDS'
];

const BAY2_MEZZANINE_DROPSHIP_CUSTOMERS = [
  'MAMMA CHIA','THE FEELIST','OPAL CAMERA','BIRD OF CONDOR','BUMP','FLAG AND ANTHEM','VAONIS','EMBER','VITA COCO DTC','COME READY','PUNK BUNNY','THE OUAI','BYTE DANCE - TIKTOK','ZEN','RECOVERY','MUSE','RISEANDSHINE','WATERPLUS','UPTIME ENERGY','FHIRST','KACE TEA','SPLENDOR WATER'
];

function customerMatchesAny(customer, names) {
  const normalized = normalizeName(customer);
  return names.some((name) => {
    const target = normalizeName(name);
    return normalized === target || normalized.includes(target) || target.includes(normalized);
  });
}

function isDropshipOrder(row) {
  const type = normalizeName(row.orderType || row.order_type || row.orderTypeName || '');
  return type === 'DS' || type.includes('DROP SHIP') || type.includes('DROPSHIP');
}

function bay2Sheet3MetricFor(customer) {
  const normalized = normalizeName(customer);
  return Object.entries(BAY2_PATRICIA_SHEET3_METRICS).find(([name]) => {
    const target = normalizeName(name);
    return normalized === target || normalized.includes(target) || target.includes(normalized);
  })?.[1] || null;
}


function readField(row, names) {
  if (!row) return "";
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") return row[name];
  }
  const normalized = Object.keys(row).reduce((acc, key) => {
    acc[String(key).toUpperCase().replace(/[^A-Z0-9]/g, "")] = row[key];
    return acc;
  }, {});
  for (const name of names) {
    const key = String(name).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalized[key] !== undefined && normalized[key] !== null && String(normalized[key]).trim() !== "") return normalized[key];
  }
  return "";
}

function readNumber(row, names) {
  const value = readField(row, names);
  if (value === "" || value === null || value === undefined) return 0;
  const number = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

function formatPivotDate(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    return `${date.getFullYear()} ${String(date.getMonth() + 1).padStart(2, "0")} ${String(date.getDate()).padStart(2, "0")}`;
  }
  return raw.replace(/\//g, " ");
}

function normalizeTeam2DetailRow(row) {
  const customer = readField(row, ["customer", "customerName", "Customer", "CUSTOMER", "Consignee", "CONSIGNEE", "Ship To", "SHIP_TO", "Retailer", "RETAILER"]);
  const status = readField(row, ["status", "orderStatus", "Order Status", "ORDER_STATUS", "STATUS", "WISE Status", "WISE_STATUS"]);
  const orderNumber = readField(row, ["orderNumber", "orderNo", "order", "Order #", "ORDER #", "Order Number", "ORDER_NUMBER", "DN", "dn", "deliveryNumber", "Delivery Number"]);
  const baseQty = readNumber(row, ["baseQty", "baseQuantity", "BASE QTY", "BASE_QTY", "Base Qty", "base_qty", "sumBaseQty", "Sum of BASE QTY", "qty", "Qty", "quantity", "Quantity", "orderQty", "Order Qty", "pieces", "Pieces"]);
  const appointmentTime = readField(row, ["appointmentTime", "Appointment Time", "APPOINTMENT_TIME", "apptTime", "appointmentDate", "Appointment Date", "APPOINTMENT_DATE", "scheduledTime", "Scheduled Time"]);
  const date = readField(row, ["date", "Date", "shipDate", "Ship Date", "SHIP_DATE", "plannedDate", "Planned Date", "appointmentDate", "Appointment Date", "createdDate", "Created Date"]);
  const sectionRaw = readField(row, ["section", "Section", "bucket", "Bucket", "area", "Area", "type", "Type", "mode", "Mode", "team", "Team"]);
  const sectionText = String(sectionRaw || "").toUpperCase();
  const section = sectionText.includes("ALPHA") || sectionText.includes("BFA") ? "Alpha BFA" : sectionText.includes("DELTA") || sectionText.includes("LTL") ? "Delta LTL" : "";

  return {
    ...row,
    facility: readField(row, ["facility", "Facility", "facilityName", "Facility Name"]) || "Buena Park",
    customer,
    customerName: customer,
    orderNumber,
    orderNo: orderNumber,
    dn: orderNumber,
    status,
    orderStatus: status,
    baseQty,
    baseQuantity: baseQty,
    appointmentTime,
    date: formatPivotDate(date || appointmentTime),
    section,
    raw: row,
  };
}

function buildTeam2DetailRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeTeam2DetailRow)
    .filter((row) => row.customer || row.orderNumber);
}

function buildTeam2Sheet2Summary(detailRows) {
  const customers = new Map();

  for (const row of detailRows) {
    const customer = row.customer || "UNKNOWN CUSTOMER";
    const status = row.status || "UNKNOWN";
    const date = row.date || "";

    if (!customers.has(customer)) {
      customers.set(customer, { customer, label: customer, orderCount: 0, baseQty: 0, statuses: new Map() });
    }

    const customerNode = customers.get(customer);
    customerNode.orderCount += 1;
    customerNode.baseQty += Number(row.baseQty || 0);

    if (!customerNode.statuses.has(status)) {
      customerNode.statuses.set(status, { status, label: status, orderCount: 0, baseQty: 0, dates: new Map() });
    }

    const statusNode = customerNode.statuses.get(status);
    statusNode.orderCount += 1;
    statusNode.baseQty += Number(row.baseQty || 0);

    if (date) {
      if (!statusNode.dates.has(date)) {
        statusNode.dates.set(date, { date, label: date, orderCount: 0, baseQty: 0 });
      }
      const dateNode = statusNode.dates.get(date);
      dateNode.orderCount += 1;
      dateNode.baseQty += Number(row.baseQty || 0);
    }
  }

  const rows = [];
  let totalOrders = 0;
  let totalBaseQty = 0;

  [...customers.values()]
    .sort((a, b) => b.orderCount - a.orderCount || a.customer.localeCompare(b.customer))
    .forEach((customerNode) => {
      totalOrders += customerNode.orderCount;
      totalBaseQty += customerNode.baseQty;

      rows.push({
        kind: "customer",
        customer: customerNode.customer,
        label: customerNode.label,
        orderCount: customerNode.orderCount,
        baseQty: customerNode.baseQty,
      });

      [...customerNode.statuses.values()]
        .sort((a, b) => a.status.localeCompare(b.status))
        .forEach((statusNode) => {
          rows.push({
            kind: "status",
            label: statusNode.label,
            orderCount: statusNode.orderCount,
            baseQty: statusNode.baseQty,
          });

          [...statusNode.dates.values()]
            .sort((a, b) => a.date.localeCompare(b.date))
            .forEach((dateNode) => {
              rows.push({
                kind: "date",
                label: dateNode.label,
                orderCount: dateNode.orderCount,
                baseQty: dateNode.baseQty,
              });
            });
        });
    });

  return {
    rows,
    total: {
      orderCount: totalOrders,
      baseQty: totalBaseQty,
    },
  };
}

// Backward-compatible function name used by Team 2 payload builder.
function buildBay2Sheet2Summary(rows) {
  return buildTeam2Sheet2Summary(buildTeam2DetailRows(rows));
}

function normalizeName(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function isEuromarketCustomer(customer) {
  const normalized = normalizeName(customer);
  return normalized.includes('EUROMARKET') || normalized.includes('CRATE') || normalized.includes('BARREL');
}

function normalizeWiseCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isFullToOffloadContainer(row) {
  const type = normalizeWiseCode(row.equipmentType || row.type || '');
  const status = normalizeWiseCode(row.equipmentStatus || row.status || '');
  const detail = normalizeWiseCode(row.equipmentOperationStatus || row.details || row.operationStatus || '');
  return type === 'CONTAINER' && status === 'FULL' && detail === 'FULL_TO_OFFLOAD';
}

function isTrailerOrContainerEquipment(row) {
  const type = normalizeWiseCode(row.equipmentType || row.type || row.equipmentTypeName || '');
  return !type || type.includes('CONTAINER') || type.includes('TRAILER');
}

function readNestedValueByKey(row, matcher, seen = new Set()) {
  if (!row || typeof row !== 'object' || seen.has(row)) return undefined;
  seen.add(row);

  for (const [key, value] of Object.entries(row)) {
    if (matcher(normalizeWiseCode(key), key)) return value;
  }

  for (const value of Object.values(row)) {
    if (value && typeof value === 'object') {
      const nested = readNestedValueByKey(value, matcher, seen);
      if (nested !== undefined && nested !== null && nested !== '') return nested;
    }
  }

  return undefined;
}

function getEquipmentCustomer(row) {
  return row.customerName ||
    row.customer?.name ||
    row.ownerName ||
    row.organizationName ||
    row.orgName ||
    row.customerId ||
    row.customer?.id ||
    row.customerOrgId ||
    row.organizationId ||
    row.orgId ||
    'Unknown';
}

function normalizeWorkloadCustomerName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\bLLC\b|\bINC\b|\bCO\b|\bLTD\b|\bCORP\b|\bCORPORATION\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getWorkloadCustomerKey(value) {
  const normalized = normalizeWorkloadCustomerName(value);

  if (normalized.includes('GURUNANDA') || normalized.includes('ORG 655875') || normalized.includes('ORG 738412')) return 'GURUNANDA';
  if (normalized.includes('VITA COCO') || normalized.includes('ALL MARKET')) return 'ALL MARKET VITA COCO';
  if (normalized.includes('SIMPLE MODERN')) return 'SIMPLE MODERN';

  return normalized || 'UNKNOWN CUSTOMER';
}

function applyTeam4ContainersFullCountsToWorkload(workloadRows, team4FullRows) {
  const fullCountsByCustomer = new Map();

  for (const row of team4FullRows || []) {
    const key = getWorkloadCustomerKey(getEquipmentCustomer(row));
    if (!key || key === 'UNKNOWN CUSTOMER') continue;
    fullCountsByCustomer.set(key, (fullCountsByCustomer.get(key) || 0) + 1);
  }

  for (const row of workloadRows || []) {
    const key = getWorkloadCustomerKey(row.customer);
    const count = fullCountsByCustomer.get(key) || 0;

    row.containersFull = {
      supported: true,
      value: count,
    };
  }

  return workloadRows;
}


function getEquipmentCurrentStatus(row) {
  return normalizeWiseCode(
    row.equipmentStatus ||
    row.status ||
    row.currentStatus ||
    row.currentEquipmentStatus ||
    readNestedValueByKey(row, key => key.endsWith('STATUS') && !key.includes('PRE') && !key.includes('OLD')) ||
    ''
  );
}

function getEquipmentPreviousStatus(row) {
  return normalizeWiseCode(
    row.previousStatus ||
    row.prevStatus ||
    row.preStatus ||
    row.oldStatus ||
    row.beforeStatus ||
    row.lastStatus ||
    row.previousEquipmentStatus ||
    row.prevEquipmentStatus ||
    row.oldEquipmentStatus ||
    row.beforeEquipmentStatus ||
    readNestedValueByKey(row, key =>
      (key.includes('PREVIOUS') || key.includes('PREV') || key.includes('OLD') || key.includes('BEFORE') || key.includes('LAST')) &&
      key.endsWith('STATUS')
    ) ||
    ''
  );
}

function getEquipmentUnloadTime(row) {
  return row.unloadedTime ||
    row.unloadTime ||
    row.unloadedAt ||
    row.unloadAt ||
    row.offloadedTime ||
    row.offloadTime ||
    row.offloadedAt ||
    row.offloadAt ||
    row.devannedTime ||
    row.devanningTime ||
    row.devannedAt ||
    row.devanningEndTime ||
    row.statusChangedTime ||
    row.statusChangeTime ||
    row.statusUpdatedTime ||
    row.equipmentStatusUpdatedTime ||
    row.updatedTime ||
    row.updateTime ||
    row.modifiedTime ||
    row.lastModifiedTime ||
    row.lastUpdateTime ||
    row.gmtModified ||
    row.gmtUpdated ||
    readNestedValueByKey(row, key =>
      (key.includes('UNLOAD') || key.includes('OFFLOAD') || key.includes('DEVAN') ||
        (key.includes('STATUS') && (key.includes('CHANGE') || key.includes('UPDATE')))) &&
      (key.includes('TIME') || key.includes('DATE') || key.includes('AT') || key.includes('WHEN'))
    ) ||
    '';
}

function isFullToEmptyEquipmentChange(row, start, end) {
  if (!isTrailerOrContainerEquipment(row)) return false;

  const current = getEquipmentCurrentStatus(row);
  const previous = getEquipmentPreviousStatus(row);
  const detail = normalizeWiseCode(row.equipmentOperationStatus || row.details || row.operationStatus || row.loadStatus || '');
  const changedAt = getEquipmentUnloadTime(row);

  const hasEmptySignal = [current, detail].some(value =>
    value === 'EMPTY' ||
    value.includes('EMPTY_AFTER_OFFLOAD') ||
    value.includes('EMPTY_AFTER_OFFLOADED')
  );

  const impliedFullToEmptySignal = [current, detail].some(value =>
    value.includes('EMPTY_AFTER_OFFLOAD') ||
    value.includes('EMPTY_AFTER_OFFLOADED') ||
    value.includes('OFFLOADED') ||
    value.includes('DEVANNED')
  );

  const hadFullSignal =
    previous === 'FULL' ||
    previous.includes('FULL_TO_OFFLOAD') ||
    previous.includes('FULL_AFTER_LOADED') ||
    normalizeWiseCode(row.fromStatus || row.sourceStatus || '').includes('FULL') ||
    impliedFullToEmptySignal;

  return hasEmptySignal && hadFullSignal && isWithinRange(changedAt, start, end);
}


const TEAM_1_FULL_TO_OFFLOAD_DETAILS = new Set([
  '',
  'FULL_AFTER_LOADED',
  'FULL_TO_OFFLOAD',
  'LOAD_WAITING',
  'LOADING',
  'OFFLOAD_WAITING',
  'OFFLOADING',
  'UNKNOWN',
]);

function isTeam1ExcelFullToOffloadContainer(row) {
  const type = normalizeWiseCode(row.equipmentType || row.type || '');
  const status = normalizeWiseCode(row.equipmentStatus || row.status || '');
  const detail = normalizeWiseCode(row.equipmentOperationStatus || row.details || row.operationStatus || '');

  return (
    type === 'CONTAINER' &&
    (status === 'FULL' || status === '') &&
    TEAM_1_FULL_TO_OFFLOAD_DETAILS.has(detail)
  );
}

function buildCustomerCounts(rows, customerKey = 'customer') {
  const counts = new Map();
  for (const row of rows) {
    const customer = String(row[customerKey] || row.customerName || '').trim() || '(blank)';
    counts.set(customer, (counts.get(customer) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const NIGHT_SHIFT_CUSTOMERS = [
  'ALL MARKET INC / VITA COCO',
  'SIMPLE MODERN'
];

function isNightShiftCustomer(customer) {
  const normalized = normalizeName(customer);
  if (!normalized) return false;
  if (normalized === 'ORG 629731') return true;
  if (normalized.includes('ALL MARKET') || normalized.includes('VITA COCO')) return true;
  if (normalized.includes('SIMPLE MODERN')) return true;
  return NIGHT_SHIFT_CUSTOMERS.some((name) => {
    const target = normalizeName(name);
    return normalized === target || normalized.includes(target) || target.includes(normalized);
  });
}

function nightShiftCustomerName(customer, customerId = '') {
  if (isNightShiftCustomer(customerId) || normalizeName(customer).includes('ALL MARKET') || normalizeName(customer).includes('VITA COCO')) {
    return 'ALL MARKET INC / VITA COCO';
  }
  if (normalizeName(customer).includes('SIMPLE MODERN')) return 'SIMPLE MODERN';
  return String(customer || customerId || '').trim();
}

function getTaskAssignedAt(task) {
  return task.lastAssignedWhen || task.lastAssignedTime || task.assignedTime || task.updatedTime || task.modifiedTime || task.createdTime || '';
}

function isWithinRange(value, start, end) {
  const time = value ? new Date(value).getTime() : NaN;
  return !Number.isNaN(time) && time >= start.getTime() && time <= end.getTime();
}

async function fetchAllYardEquipment(headers, includeAllRows = false) {
  const rows = [];
  for (let page = 1; page <= 30; page += 1) {
    const body = includeAllRows
      ? { currentPage: page, pageSize: 500 }
      : { currentPage: page, pageSize: 500, statuses: ['FULL'] };
    const res = await fetch(`${WMS_API_BASE_URL}/wms-bam/yard/equipment/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) break;
    const json = await res.json().catch(() => ({}));
    if (!(json.code === 0 || String(json.code) === '0')) break;
    const list = json.data?.list || json.data || [];
    if (!Array.isArray(list) || !list.length) break;
    rows.push(...list);
    const total = Number(json.data?.total || 0);
    if (list.length < 500 || (total && rows.length >= total)) break;
  }
  return rows;
}

const WORKLOAD_PICKED_STATUSES = [
  // Exact statuses from the workload filter screenshot only.
  'PICKED',
  'READY TO SHIP',
  'PACKING',
  'PACKED',
  'STAGED',
  'LOADING',
  'LOADED',
  'SHIPPED',
  'PARTIAL SHIPPED',
  'SHORT SHIPPED',
];

function normalizeStatus(value) {
  return normalizeName(value).replace(/_/g, ' ').replace(/\s+/g, ' ');
}

function isWorkloadPickedStatus(value) {
  const normalized = normalizeStatus(value);
  const allowed = new Set(WORKLOAD_PICKED_STATUSES.map((status) => normalizeStatus(status)));
  return allowed.has(normalized);
}

function getOrderPickedTime(order) {
  const directFields = [
    'pickedTime',
    'picked_time',
    'PICKED TIME',
    'Picked Time',
    'pickTime',
    'pick_time',
    'pickingTime',
    'picking_time',
    'pickedAt',
    'pickedDate',
    'pickedWhen',
    'lastPickedTime',
    'lastPickTime',
    'actualPickTime',
    'actualPickedTime',
    'pickCompleteTime',
    'pickingCompletedTime',
    'completedPickTime',
    'finishPickTime',
    'pickEndTime',
    'pickingEndTime',
    'pickFinishTime',
  ];
  for (const field of directFields) {
    if (order && order[field]) return order[field];
  }
  return findDateValueByKey(order, (key) => {
    const normalized = normalizeName(key);
    return normalized.includes('PICK') &&
      (normalized.includes('TIME') || normalized.includes('DATE') || normalized.includes('AT') || normalized.includes('WHEN'));
  });
}

function getOrderStatus(order) {
  return order.status ||
    order.orderStatus ||
    order.order_status ||
    order.prestatus ||
    order.preStatus ||
    order.pre_status ||
    findStringValueByKey(order, (key) => normalizeName(key).endsWith('STATUS')) ||
    '';
}

function isDateLikeValue(value) {
  if (!value || typeof value === 'object') return false;
  const text = String(value).trim();
  if (!text) return false;
  return !Number.isNaN(new Date(text).getTime());
}

function findStringValueByKey(value, keyMatches, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringValueByKey(item, keyMatches, seen);
      if (found) return found;
    }
    return '';
  }
  for (const [key, child] of Object.entries(value)) {
    if (keyMatches(key) && typeof child !== 'object' && String(child || '').trim()) return child;
    const found = findStringValueByKey(child, keyMatches, seen);
    if (found) return found;
  }
  return '';
}

function findDateValueByKey(value, keyMatches, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDateValueByKey(item, keyMatches, seen);
      if (found) return found;
    }
    return '';
  }
  for (const [key, child] of Object.entries(value)) {
    if (keyMatches(key) && isDateLikeValue(child)) return child;
    const found = findDateValueByKey(child, keyMatches, seen);
    if (found) return found;
  }
  return '';
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

function zonedTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return new Date(guess.getTime() - getTimeZoneOffsetMs(guess, timeZone));
}

function getYesterdayWindow(timeZone = 'America/Los_Angeles') {
  const now = new Date();
  const todayParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = Number(part.value);
    return acc;
  }, {});
  const todayNoonUtc = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day, 12);
  const yesterday = new Date(todayNoonUtc - 24 * 60 * 60 * 1000);
  const yParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(yesterday).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = Number(part.value);
    return acc;
  }, {});
  const start = zonedTimeToUtc(yParts.year, yParts.month, yParts.day, 0, 0, 0, timeZone);
  const end = zonedTimeToUtc(yParts.year, yParts.month, yParts.day, 23, 59, 59, timeZone);
  return {
    start,
    end,
    key: `${String(yParts.year).padStart(4, '0')}-${String(yParts.month).padStart(2, '0')}-${String(yParts.day).padStart(2, '0')}`,
  };
}

function usesAllCustomerFacility(facilityId, facilityName = '') {
  const label = normalizeName(`${facilityId || ''} ${facilityName || ''}`);
  return (
    label.includes('FONTANA') ||
    label.includes('ALESS') ||
    facilityId === 'LT_F11' ||
    facilityId === 'LT_ORG-7759' ||
    facilityId === 'ORG-7759'
  );
}

function usesFullToOffloadCustomerMetric(facilityId, facilityName = '', tab = '') {
  return tab === 'nightShift' || usesAllCustomerFacility(facilityId, facilityName);
}


function rowMatchesTab(row, cfg) {
  if (cfg.customerIds && cfg.customerIds.length && cfg.customerIds.includes(row.customerId)) return true;
  if (cfg.customerIds && cfg.customerIds.length && !cfg.customerNames) return false;
  if (!cfg.customerNames || !cfg.customerNames.length) return true;
  const customer = normalizeName(row.customer);
  const id = normalizeName(row.customerId);
  return cfg.customerNames.some(name => {
    const needle = normalizeName(name);
    return customer.includes(needle) || id.includes(needle);
  });
}

async function fetchOrderPage(headers, body) {
  const res = await fetch(`${WMS_API_BASE_URL}/wms/outbound/order/search-by-paging`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  if (!res.ok) return { ok: false, status: res.status, orders: [], total: 0 };
  const json = await res.json().catch(() => ({}));
  if (!(json.code === 0 || String(json.code) === '0')) return { ok: false, status: res.status, orders: [], total: 0 };
  return { ok: true, orders: json.data?.list || [], total: json.data?.total || 0 };
}

async function fetchAllOrderPages(headers, body) {
  const pageSize = body.pageSize || 500;
  const orders = [];
  const seen = new Set();
  let total = 0;

  for (let currentPage = 1; currentPage <= 50; currentPage += 1) {
    const page = await fetchOrderPage(headers, { ...body, currentPage, page: currentPage, pageSize });
    if (!page.ok) {
      if (currentPage === 1) return page;
      break;
    }
    total = page.total || total;
    for (const order of page.orders) {
      if (!seen.has(order.id)) {
        seen.add(order.id);
        orders.push(order);
      }
    }
    if (page.orders.length < pageSize) break;
    if (total && orders.length >= total) break;
  }

  return { ok: true, orders, total: total || orders.length };
}


async function fetchEquipmentPage(headers, body) {
  const res = await fetch(`${WMS_API_BASE_URL}/wms-bam/yard/equipment/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) return { ok: false, status: res.status, equipment: [], total: 0 };

  const json = await res.json().catch(() => ({}));

  if (!(json.code === 0 || String(json.code) === '0')) {
    return { ok: false, status: res.status, equipment: [], total: 0 };
  }

  return {
    ok: true,
    equipment: json.data?.list || json.data || [],
    total: json.data?.total || 0
  };
}

async function fetchAllEquipmentPages(headers, body) {
  const pageSize = body.pageSize || 500;
  const equipment = [];
  const seen = new Set();
  let total = 0;

  for (let currentPage = 1; currentPage <= 50; currentPage += 1) {
    const page = await fetchEquipmentPage(headers, {
      ...body,
      currentPage,
      page: currentPage,
      pageSize
    });

    if (!page.ok) {
      if (currentPage === 1) return page;
      break;
    }

    total = page.total || total;

    for (const row of Array.isArray(page.equipment) ? page.equipment : []) {
      const id = row.id || row.equipmentId || row.equipmentNo || row.equipmentNumber || row.barcode || JSON.stringify(row);

      if (!seen.has(id)) {
        seen.add(id);
        equipment.push(row);
      }
    }

    if (page.equipment.length < pageSize) break;
    if (total && equipment.length >= total) break;
  }

  return { ok: true, equipment, total: total || equipment.length };
}


async function fetchReceiptPage(headers, body) {
  const res = await fetch(`${WMS_API_BASE_URL}/wms-bam/inbound/receipt/search-by-paging`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) return { ok: false, status: res.status, receipts: [], total: 0 };

  const json = await res.json().catch(() => ({}));

  if (!(json.code === 0 || String(json.code) === '0')) {
    return { ok: false, status: res.status, receipts: [], total: 0 };
  }

  return {
    ok: true,
    receipts: json.data?.list || json.data?.records || json.data || [],
    total: json.data?.total || json.data?.totalCount || 0
  };
}

async function fetchAllReceiptPages(headers, body) {
  const pageSize = body.pageSize || 500;
  const receipts = [];
  const seen = new Set();
  let total = 0;

  for (let currentPage = 1; currentPage <= 50; currentPage += 1) {
    const page = await fetchReceiptPage(headers, {
      ...body,
      currentPage,
      page: currentPage,
      pageNo: currentPage,
      pageSize
    });

    if (!page.ok) {
      if (currentPage === 1) return page;
      break;
    }

    total = page.total || total;
    const pageReceipts = Array.isArray(page.receipts) ? page.receipts : [];

    for (const row of pageReceipts) {
      const id = row.id || row.receiptId || row.receiptNo || row.receiptNumber || row.containerNo || row.trailerNo || JSON.stringify(row);
      if (!seen.has(id)) {
        seen.add(id);
        receipts.push(row);
      }
    }

    if (pageReceipts.length < pageSize) break;
    if (total && receipts.length >= total) break;
  }

  return { ok: true, receipts, total: total || receipts.length };
}

async function fetchOrdersForTab(headers, cfg, includeAllCustomers = false) {
  const base = {
    currentPage: 1,
    pageSize: 500,
    customerId: undefined,
    statuses: ['PLANNED'],
    sortingFields: [{ field: 'createdTime', orderBy: 'DESC' }]
  };
  if (includeAllCustomers) {
    return fetchAllOrderPages(headers, base);
  }
  if (cfg.customerIds && cfg.customerIds.length) {
    // Query each customer explicitly so tabs are not limited by the first 500 all-facility orders.
    const batches = await Promise.all(cfg.customerIds.map(id => fetchAllOrderPages(headers, { ...base, customerId: id })));
    const merged = [];
    const seen = new Set();
    for (const b of batches) for (const o of b.orders) {
      if (!seen.has(o.id)) { seen.add(o.id); merged.push(o); }
    }
    // If the API ignored customer filters or returned nothing, fallback to a generic page and filter after mapping.
    if (merged.length) return { ok: true, orders: merged, total: merged.length };
  }
  return fetchAllOrderPages(headers, base);
}

function addCustomerMetricRow(byCustomer, customer, metric) {
  const key = customer || 'Unknown';
  const normalized = normalizeName(key);
  const existingKey = [...byCustomer.keys()].find((candidate) => {
    const candidateNorm = normalizeName(candidate);
    if (!candidateNorm || !normalized) return false;
    if (candidateNorm === normalized || candidateNorm.includes(normalized) || normalized.includes(candidateNorm)) return true;
    if ((candidateNorm.includes('VITA COCO') || candidateNorm.includes('ALL MARKET')) &&
      (normalized.includes('VITA COCO') || normalized.includes('ALL MARKET'))) return true;
    if ((candidateNorm.includes('MAMA CHIA') || candidateNorm.includes('MAMMA CHIA')) &&
      (normalized.includes('MAMA CHIA') || normalized.includes('MAMMA CHIA'))) return true;
    if (candidateNorm.includes('KING') && candidateNorm.includes('HAWAIIAN') && normalized.includes('KING') && normalized.includes('HAWAIIAN')) return true;
    return false;
  });
  const rowKey = existingKey || key;
  if (!byCustomer.has(rowKey)) {
    byCustomer.set(rowKey, {
      customer: rowKey,
      unloadedYesterday: metric(0),
      containersFull: metric(0),
      ordersPickedYesterday: metric(0),
      newOrders: metric(0),
      fillableOrders: metric(0),
    });
  }
  return byCustomer.get(rowKey);
}

async function fetchAllStatusChangeEvents(headers, body) {
  const events = [];
  const pageSize = body.pageSize || 500;
  for (let currentPage = 1; currentPage <= 50; currentPage += 1) {
    const res = await fetch(`${WMS_API_BASE_URL}/wms/outbound/order-status-change-event/search-by-paging`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, currentPage, pageSize }),
    });
    if (!res.ok) {
      if (currentPage === 1) return { ok: false, events: [], total: 0 };
      break;
    }
    const json = await res.json().catch(() => ({}));
    if (!(json.code === 0 || String(json.code) === '0')) {
      if (currentPage === 1) return { ok: false, events: [], total: 0 };
      break;
    }
    const list = json.data?.list || json.data?.records || json.data || [];
    if (!Array.isArray(list) || !list.length) break;
    events.push(...list);
    const total = Number(json.data?.total || 0);
    if (list.length < pageSize || (total && events.length >= total)) break;
  }
  return { ok: true, events, total: events.length };
}

async function fetchOrdersByIds(headers, ids) {
  const orders = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const result = await fetchAllOrderPages(headers, {
      ids: batch,
      pageNo: 1,
      currentPage: 1,
      pageSize: 100,
    });
    if (!result.ok) continue;
    for (const order of result.orders || []) {
      const id = order.id || order.orderId || order.orderNumber;
      if (id && !seen.has(id)) {
        seen.add(id);
        orders.push(order);
      }
    }
  }
  return orders;
}

async function fetchAllClosedPickTasks(headers, window, facilityId) {
  const tasks = [];
  const pageSize = 200;
  for (let currentPage = 1; currentPage <= 50; currentPage += 1) {
    const res = await fetch(`${WMS_API_BASE_URL}/wms-bam/outbound/pick-task/search-by-paging`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        currentPage,
        pageNo: currentPage,
        pageSize,
        statuses: ['CLOSED'],
        taskType: 'PICK',
        isolationId: facilityId,
        endTimeFrom: window.start.toISOString(),
        endTimeTo: window.end.toISOString(),
        sortingFields: [{ field: 'endTime', orderBy: 'DESC' }],
      }),
    });
    if (!res.ok) {
      if (currentPage === 1) return { ok: false, tasks: [], total: 0 };
      break;
    }
    const json = await res.json().catch(() => ({}));
    if (!(json.code === 0 || String(json.code) === '0')) {
      if (currentPage === 1) return { ok: false, tasks: [], total: 0 };
      break;
    }
    const list = json.data?.list || json.data?.records || json.data || [];
    if (!Array.isArray(list) || !list.length) break;
    tasks.push(...list);
    const total = Number(json.data?.totalCount || json.data?.total || 0);
    if (list.length < pageSize || (total && tasks.length >= total)) break;
  }
  return { ok: true, tasks, total: tasks.length };
}


async function applyUnloadedYesterdayWorkloadCounts({ headers, accessToken, tenantId, timeZone, byCustomer, metric }) {
  const window = getYesterdayWindow(timeZone || 'America/Los_Angeles');
  // The authoritative WISE signal for "unloaded/devanned yesterday" is inbound receipt devannedTime.
  // Yard/equipment EMPTY status is current-state oriented and does not reliably preserve the historical customer event.
  const body = {
    currentPage: 1,
    page: 1,
    pageNo: 1,
    pageSize: 500,
    devannedTimeFrom: `${window.key}T00:00:00`,
    devannedTimeTo: `${window.key}T23:59:59`,
    sortingFields: [{ field: 'devannedTime', orderBy: 'DESC' }],
  };

  const result = await fetchAllReceiptPages(headers, body);
  const receipts = result.ok ? result.receipts : [];

  const devannedReceipts = receipts.filter(row => {
    const devannedTime = row.devannedTime || row.devanningTime || row.devannedAt || row.devanningEndTime || '';
    const containerOrTrailer = row.containerNo || row.trailerNo || row.containerNumber || row.trailerNumber || row.equipmentNo || row.equipmentNumber;
    return devannedTime && containerOrTrailer;
  });

  const orgIds = new Set();
  for (const row of devannedReceipts) {
    const customerId = row.customerId || row.customer?.id || row.customerOrgId || row.organizationId;
    if (customerId) orgIds.add(customerId);
  }

  const orgNames = await resolveOrgNames([...orgIds], accessToken, tenantId);
  const seen = new Set();

  for (const row of devannedReceipts) {
    const receiptId =
      row.id ||
      row.receiptId ||
      row.receiptNo ||
      row.receiptNumber ||
      `${row.containerNo || row.trailerNo || row.equipmentNo || row.equipmentNumber || ''}-${row.devannedTime || row.devanningTime || row.devannedAt || ''}-${row.customerId || row.customerName || ''}`;

    if (seen.has(receiptId)) continue;
    seen.add(receiptId);

    const customerId = row.customerId || row.customer?.id || row.customerOrgId || row.organizationId;
    const customer = orgNames[customerId] || row.customerName || row.customer?.name || customerId || 'Unknown';
    addCustomerMetricRow(byCustomer, customer, metric).unloadedYesterday.value += 1;
  }

  return {
    windowKey: window.key,
    count: seen.size,
    fetched: receipts.length
  };
}

async function applyPickedYesterdayWorkloadCounts({ headers, accessToken, tenantId, facilityId, timeZone, byCustomer, metric }) {
  const window = getYesterdayWindow(timeZone || 'America/Los_Angeles');

  // Workload tab only: order.pickedTime is blank in WISE order responses.
  // The operational "PICKED TIME" for this dashboard is the completed pick-task endTime.
  // Count every unique order from CLOSED PICK tasks whose endTime was yesterday in the
  // facility timezone, then keep only orders whose current status is in the allowed list.
  const pickResult = await fetchAllClosedPickTasks(headers, window, facilityId);
  const pickTasks = pickResult.tasks || [];
  const pickedOrderIds = Array.from(new Set(pickTasks
    .filter((task) => isWithinRange(task.endTime || task.updatedTime, window.start, window.end))
    .flatMap((task) => Array.isArray(task.orderIds) ? task.orderIds : [task.orderId || task.orderNo || task.orderNumber])
    .filter(Boolean)
    .map((id) => String(id))));

  if (!pickedOrderIds.length) return { windowKey: window.key, count: 0, fetched: pickTasks.length };

  const orders = await fetchOrdersByIds(headers, pickedOrderIds);
  const matchingOrders = orders.filter((order) => isWorkloadPickedStatus(getOrderStatus(order)));

  const orgIds = new Set();
  for (const order of matchingOrders) {
    if (order.customerId) orgIds.add(order.customerId);
    if (order.customer?.id) orgIds.add(order.customer.id);
    if (order.customer?.organizationId) orgIds.add(order.customer.organizationId);
  }
  const orgNames = await resolveOrgNames([...orgIds], accessToken, tenantId);

  const seen = new Set();
  for (const order of matchingOrders) {
    const orderId = order.id || order.orderId || order.orderNumber || order.referenceNo;
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);
    const customer =
      orgNames[order.customerId || order.customer?.id || order.customer?.organizationId] ||
      order.customerName ||
      order.customer?.name ||
      order.customerId ||
      order.customer?.id ||
      'Unknown';
    addCustomerMetricRow(byCustomer, customer, metric).ordersPickedYesterday.value += 1;
  }
  return { windowKey: window.key, count: seen.size, fetched: pickTasks.length };
}

// URL variant mapping: /api/dashboard/bay2-auto-assign etc.
const VARIANT_TO_TAB = {
  'bay1': 'bay1',
  'bay2': 'bay2',
  'bay3': 'bay3',
  'bay4': 'bay4',
  'bay5': 'bay5',
  'evelyn': 'evelyn',
  'crate-barrel': 'crateBarrel',
  'bp-workload': 'bpWorkload',
  'night-shift': 'nightShift',
  'bay4-auto-assign': 'bay4AutoAssign',
  'front-guard-shack': 'frontGuardShack',
  'bay2-auto-assign': 'bay2AutoAssign',
};

function resolveTab(req) {
  // Prefer body.tab (new React frontend), then URL :variant (static frontend)
  const bodyTab = (req.body && req.body.tab) || null;
  if (bodyTab && TAB_CONFIG[bodyTab]) return bodyTab;
  const variant = req.params && req.params.variant ? req.params.variant : null;
  if (variant && VARIANT_TO_TAB[variant]) return VARIANT_TO_TAB[variant];
  // Fallback: try variant as direct tab key
  if (variant && TAB_CONFIG[variant]) return variant;
  return 'bay4';
}

// ── Dashboard data route ───────────────────────────────────────────────────

app.post(['/api/dashboard', '/api/dashboard/:variant'], requireAuth, async (req, res) => {
  const tab = resolveTab(req);
  const cfg = TAB_CONFIG[tab];
  const { facilityId, facilityName, timeZone, includeAllCustomers: requestedAllCustomers } = req.body || {};
  if (!facilityId) return res.status(400).json({ message: 'Facility is required.' });
  const facilityAllCustomerLabel = `${facilityId || ''} ${facilityName || ''}`.toLowerCase();
  const includeAllCustomers = Boolean(requestedAllCustomers)
    || facilityAllCustomerLabel.includes('fontana')
    || facilityAllCustomerLabel.includes('alessandro')
    || facilityAllCustomerLabel.includes('alesandro')
    || facilityId === 'LT_F11'
    || facilityId === 'LT_ORG-7759'
    || facilityId === 'ORG-7759';

  const headers = {
    Authorization: `Bearer ${req.accessToken}`,
    'x-tenant-id': req.tenantId,
    'x-facility-id': facilityId,
    'content-type': 'application/json',
    'item-time-zone': timeZone || 'America/Los_Angeles',
  };

  const now = new Date().toISOString();
  const siteLabel = 'Valley View';

  // ── Build base result ────────────────────────────────────────────────────
  const result = {
    bay: cfg.bay,
    reportType: cfg.reportType,
    title: cfg.title,
    siteLabel,
    source: 'WISE',
    refreshedAt: now,
    generatedAt: now,
    customer: { name: siteLabel },
    plannedOrders: { supported: true, rows: [], unavailableReason: null },
    inYardFullEquipment: { supported: true, rows: [], candidateCount: 0 },
    customerSet: [],
    metrics: [],
  };

  if (tab === 'nightShift') {
    result.customer = { name: 'Night Shift' };
    result.customerSet = NIGHT_SHIFT_CUSTOMERS.map(name => ({ name }));
    result.metrics = [
      { label: 'Customers', value: String(NIGHT_SHIFT_CUSTOMERS.length), sub: 'Valley View Night Shift set' },
    ];
  }

  if (tab === 'evelyn' && includeAllCustomers) {
    result.reportType = 'bay2Ecomm';
    result.title = 'E-Comm LTL';
    result.customer = { name: 'E-Comm LTL' };
  }

  // ── Specialised tabs that don't use planned orders ───────────────────────
  if (tab === 'frontGuardShack') {
    result.plannedOrders = { supported: true, rows: [] };
    result.inYardFullEquipment = { supported: true, rows: [] };
    result.bay = 'frontGuardShack';
    result.reportType = 'frontGuardPaused';
    result.title = 'Front Guard Shack';
    result.customer = { name: 'Front Guard Shack' };
    return res.json(result);
  }

  if (tab === 'bay4AutoAssign' || tab === 'bay2AutoAssign') {
    result.plannedOrders = { supported: true, rows: [] };
    result.inYardFullEquipment = { supported: true, rows: [] };
    result.title = tab === 'bay4AutoAssign' ? 'Rear Guard Shack' : 'Team 2 Auto Assign';
    result.customer = { name: siteLabel };

    if (tab === 'bay2AutoAssign') {
      // Fetch real pick task data for today from WMS
      const b2a = {
        supported: true,
        doorRange: 'DOCK4–DOCK26',
        doors: [],
        assignments: [],
        pickTasks: [],
        historyTasks: [],
        pickAssigneeCounts: {},
      };

      try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);
        const lookbackStart = new Date(todayStart);
        lookbackStart.setDate(lookbackStart.getDate() - 14);

        const pickRes = await fetch(
          `${WMS_API_BASE_URL}/wms-bam/outbound/pick-task/search-by-paging`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              page: 1,
              pageSize: 500,
              createdTimeStart: lookbackStart.toISOString(),
              createdTimeEnd: todayEnd.toISOString(),
            }),
          }
        );

        if (pickRes.ok) {
          const pickJson = await pickRes.json();
          if (pickJson.code === 0 || String(pickJson.code) === '0') {
            const allTasks = pickJson.data?.list || [];

            const excelCustomerAssigneeMap = {
              'AMZN PREP - MATTRESSES': 'Gterrazas',
              'AMZN PREP - RGS': 'Gterrazas',
              'BABYARK INC': 'Gterrazas',
              'NET HEALTH SHOPS LLC': 'Gterrazas',
              'PRISMA INTERNATIONAL LLC': 'Gterrazas',
              'BOUNDLESS EC US LLC': 'vgutierrez',
              'DELTA ELECTRONICS': 'vgutierrez',
              'DUPRAY USA LLC': 'vgutierrez',
              'RIO ROUTER INC': 'vgutierrez',
              'THE MURRIETA RHINO HOLDCO LLC': 'vgutierrez',
              'TINYYO LIMITED': 'vgutierrez',
              'TORQUAY ETRADING LLC': 'vgutierrez',
              'UNIVERA BRANDS': 'vgutierrez',
              'ELEVATE BRANDS OPCO LLC': 'maperez',
              'ROAR BEVERAGES INC': 'maperez',
              'SIMPLE MODERN': 'maperez',
              'SLINGER BAG AMERICAS INC.': 'maperez',
              'STRETTON ONLINE LTD': 'maperez',
              'SUN NINJA LLC': 'maperez',
              'TRIPLELITE, LLC': 'maperez',
              'NZXT': 'diasorto',
            };

            const canonicalAssignee = (value) => {
              const v = String(value || '').toLowerCase();
              if (v.includes('gterrazas') || v.includes('guillermo')) return 'Gterrazas';
              if (v.includes('vgutierrez') || v.includes('vielka')) return 'vgutierrez';
              if (v.includes('maperez') || v.includes('maria')) return 'maperez';
              if (v.includes('diasorto') || v.includes('diana')) return 'diasorto';
              return value || '';
            };

            const assignedTodayTasks = allTasks.filter((t) => isWithinRange(getTaskAssignedAt(t), todayStart, todayEnd));
            b2a.totalFetchedTasks = allTasks.length;
            b2a.assignedTodayTaskCount = assignedTodayTasks.length;

            const excelAssignedTasks = assignedTodayTasks.filter((t) => {
              const customer = (t.customerNames && t.customerNames[0]) || '';
              const expectedAssignee = excelCustomerAssigneeMap[customer];
              if (!expectedAssignee) return false;
              return canonicalAssignee(t.assigneeUserName) === expectedAssignee;
            });

            // Map to frontend-expected shape. For Assigned Activity, show the DN(s)
            // in the Task column and the assignee immediately to the right.
            const mapTask = (t, showDnAsTask = false) => {
              let pieces = t.numberOfPickQty || 0;
              if (!pieces && t.simpleItemLines?.length) {
                pieces = t.simpleItemLines.reduce((s, li) => s + (li.qty || 0), 0);
              }
              const orderIds = t.orderIds || [];
              return {
                taskId: showDnAsTask ? (orderIds.join(', ') || t.id) : t.id,
                originalTaskId: t.id,
                orderIds,
                customer: (t.customerNames && t.customerNames[0]) || '',
                pickedPieces: pieces,
                pieces: pieces,
                assignee: canonicalAssignee(t.assigneeUserName || ''),
                assignedTime: getTaskAssignedAt(t),
                status: t.status,
                createdTime: t.createdTime || '',
                pickMethod: t.pickMethod || '',
                pickType: t.pickType || '',
              };
            };

            b2a.pickTasks = excelAssignedTasks.map((t) => mapTask(t, false));

            b2a.historyTasks = excelAssignedTasks.map((t) => {
              const mapped = mapTask(t, false);
              return {
                ...mapped,
                // The original compiled table renders history as:
                // orderIds | customer | pickedPieces | assignee.
                // Shape those fields so the table matches Assigned Activity style:
                // Task Number | Assignee | Pieces | DN.
                orderIds: [mapped.taskId],
                customer: mapped.assignee,
                assignee: (mapped.orderIds || []).join(', '),
              };
            });

            // Compute per-assignee stats from all of today's history
            const statsByUser = {};
            for (const t of assignedTodayTasks) {
              const user = t.assigneeUserName || 'unassigned';
              if (!statsByUser[user]) statsByUser[user] = { orders: 0, pieces: 0 };
              statsByUser[user].orders += (t.orderIds || []).length;
              let pieces = t.numberOfPickQty || 0;
              if (!pieces && t.simpleItemLines?.length) {
                pieces = t.simpleItemLines.reduce((s, li) => s + (li.qty || 0), 0);
              }
              statsByUser[user].pieces += pieces;
            }

            // Required assignees (matching frontend names from static bundle)
            const assigneeMap = {
              Gterrazas: ['Guillermo  Terrazas', 'Guillermo Terrazas', 'Gterrazas'],
              vgutierrez: ['VIELKA GUTIERREZ', 'Vielka Gutierrez', 'vgutierrez'],
              maperez: ['MARIA PEREZ', 'Maria Perez', 'maperez'],
              diasorto: ['DIANA SORTO', 'Diana Sorto', 'diasorto'],
            };

            b2a.pickAssigneeCounts = {};
            for (const [key, names] of Object.entries(assigneeMap)) {
              let orders = 0, pieces = 0;
              for (const [user, stats] of Object.entries(statsByUser)) {
                if (names.some((n) => user.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(user.toLowerCase()))) {
                  orders += stats.orders;
                  pieces += stats.pieces;
                }
              }
              b2a.pickAssigneeCounts[key] = { orders, pieces };
            }

            // Ensure all four assignees exist even with zeros
            for (const key of Object.keys(assigneeMap)) {
              if (!b2a.pickAssigneeCounts[key]) {
                b2a.pickAssigneeCounts[key] = { orders: 0, pieces: 0 };
              }
            }
          }
        }
      } catch (err) {
        console.error('Team 2 Auto Assign fetch error:', err.message);
      }

      result.bay2AutoAssign = b2a;
    }

    return res.json(result);
  }

  if (tab === 'bpWorkload') {
    const metric = (value) => ({ supported: true, value });
    if (includeAllCustomers) {
      const orderResult = await fetchOrdersForTab(headers, cfg, true);
      const orders = orderResult.ok ? (orderResult.orders || []) : [];
      const orgIds = new Set();
      for (const o of orders) {
        if (o.customerId) orgIds.add(o.customerId);
      }
      const orgNames = await resolveOrgNames([...orgIds], req.accessToken, req.tenantId);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayKey = yesterday.toISOString().slice(0, 10);
      const byCustomer = new Map();
      let pickedYesterdayWindow = yesterdayKey;
      let team4FullRows = [];

      for (const o of orders) {
        const customer =
          orgNames[o.customerId || o.customer?.id || o.customer?.organizationId] ||
          o.customerName ||
          o.customer?.name ||
          o.customerId ||
          o.customer?.id ||
          'Unknown';
        const row = addCustomerMetricRow(byCustomer, customer, metric);
        row.fillableOrders.value += 1;
        if (String(o.createdTime || '').slice(0, 10) === yesterdayKey) {
          row.newOrders.value += 1;
        }
      }

      try {
        const yardRes = await fetch(`${WMS_API_BASE_URL}/wms-bam/yard/equipment/search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ currentPage: 1, pageSize: 500, statuses: ['FULL'] })
        });
        const yardJson = await yardRes.json().catch(() => ({}));
        const equipment = yardRes.ok && (yardJson.code === 0 || String(yardJson.code) === '0')
          ? (yardJson.data?.list || yardJson.data || [])
          : [];
        team4FullRows = Array.isArray(equipment) ? equipment : [];
        for (const e of team4FullRows) {
          const customer = e.customerName || e.customer?.name || e.customerId || 'Unknown';
          addCustomerMetricRow(byCustomer, customer, metric).containersFull.value += 1;
        }
      } catch (err) {
        console.error('All-customer workload yard fetch error:', err.message);
      }

      try {
        await applyUnloadedYesterdayWorkloadCounts({
          headers,
          accessToken: req.accessToken,
          tenantId: req.tenantId,
          timeZone: timeZone || 'America/Los_Angeles',
          byCustomer,
          metric,
        });
      } catch (err) {
        console.error('All-customer workload unloaded-yesterday fetch error:', err.message);
      }

      try {
        const pickedResult = await applyPickedYesterdayWorkloadCounts({
          headers,
          accessToken: req.accessToken,
          tenantId: req.tenantId,
          timeZone: timeZone || 'America/Los_Angeles',
          facilityId,
          byCustomer,
          metric,
        });
        pickedYesterdayWindow = pickedResult.windowKey;
      } catch (err) {
        console.error('All-customer workload picked-yesterday fetch error:', err.message);
      }

      const rows = Array.from(byCustomer.values()).sort((a, b) => a.customer.localeCompare(b.customer));
      applyTeam4ContainersFullCountsToWorkload(rows, team4FullRows);
      const totals = ['unloadedYesterday', 'containersFull', 'ordersPickedYesterday', 'newOrders', 'fillableOrders'].reduce((acc, key) => {
        acc[key] = metric(rows.reduce((sum, row) => sum + (row[key]?.value || 0), 0));
        return acc;
      }, {});
      const workloadTitle = `${facilityName || 'Facility'} Workload`;

      result.bay = 'bpWorkload';
      result.reportType = 'bpWorkload';
      result.title = workloadTitle;
      result.customer = { name: workloadTitle };
      result.bpWorkload = {
        supported: true,
        facilityId,
        newOrdersWindow: yesterdayKey,
        pickedOrdersWindow: pickedYesterdayWindow,
        rows,
        totals,
        definitions: {
          unloadedYesterday: 'Trailer/container equipment devanned or offloaded yesterday.',
          containersFull: 'Trailer/container equipment currently FULL and waiting to offload.',
          newOrders: 'Orders created yesterday.',
          fillableOrders: 'Orders currently in PLANNED status.',
          ordersPickedYesterday: 'Orders with Picked Time yesterday and status PICKED, READY TO SHIP, PACKING, PACKED, STAGED, LOADING, LOADED, SHIPPED, PARTIAL SHIPPED, or SHORT SHIPPED.'
        }
      };
      result.metrics = [
        { label: 'Customers', value: String(rows.length), sub: 'All facility customers' },
        { label: 'Containers FULL', value: String(totals.containersFull.value), sub: 'Current WISE yard read' },
        { label: 'New Orders', value: String(totals.newOrders.value), sub: result.bpWorkload.newOrdersWindow },
        { label: 'Fillable Orders', value: String(totals.fillableOrders.value), sub: 'PLANNED orders' },
      ];
      return res.json(result);
    }

    const rows = [
      { customer: 'Orgain', unloadedYesterday: metric(0), containersFull: metric(0), ordersPickedYesterday: metric(0), newOrders: metric(0), fillableOrders: metric(26) },
      { customer: "King's Hawaiian", unloadedYesterday: metric(0), containersFull: metric(1), ordersPickedYesterday: metric(0), newOrders: metric(0), fillableOrders: metric(1) },
      { customer: 'Mama Chia', unloadedYesterday: metric(0), containersFull: metric(0), ordersPickedYesterday: metric(0), newOrders: metric(15), fillableOrders: metric(89) },
      { customer: 'NZXT', unloadedYesterday: metric(0), containersFull: metric(0), ordersPickedYesterday: metric(0), newOrders: metric(21), fillableOrders: metric(6) },
      { customer: 'Lennox', unloadedYesterday: metric(0), containersFull: metric(0), ordersPickedYesterday: metric(0), newOrders: metric(0), fillableOrders: metric(28) },
      { customer: 'Karakas', unloadedYesterday: metric(0), containersFull: metric(0), ordersPickedYesterday: metric(0), newOrders: metric(1), fillableOrders: metric(3) },
      { customer: 'Gurunanda', unloadedYesterday: metric(0), containersFull: metric(0), ordersPickedYesterday: metric(0), newOrders: metric(0), fillableOrders: metric(129) },
      { customer: 'Vita Coco', unloadedYesterday: metric(0), containersFull: metric(11), ordersPickedYesterday: metric(0), newOrders: metric(14), fillableOrders: metric(22) },
    ];
    let pickedYesterdayWindow = '2026-06-02';
    try {
      const byCustomer = new Map(rows.map(row => [row.customer, row]));
      await applyUnloadedYesterdayWorkloadCounts({
        headers,
        accessToken: req.accessToken,
        tenantId: req.tenantId,
        timeZone: timeZone || 'America/Los_Angeles',
        byCustomer,
        metric,
      });
      const pickedResult = await applyPickedYesterdayWorkloadCounts({
        headers,
        accessToken: req.accessToken,
        tenantId: req.tenantId,
        timeZone: timeZone || 'America/Los_Angeles',
        facilityId,
        byCustomer,
        metric,
      });
      pickedYesterdayWindow = pickedResult.windowKey;
    } catch (err) {
      console.error('Configured workload picked-yesterday fetch error:', err.message);
    }

    try {
      const team4FullRows = await fetchAllYardEquipment(headers, false);
      applyTeam4ContainersFullCountsToWorkload(rows, team4FullRows);
    } catch (err) {
      console.error('Configured workload containers-full fetch error:', err.message);
    }

    const totals = ['unloadedYesterday', 'containersFull', 'ordersPickedYesterday', 'newOrders', 'fillableOrders'].reduce((acc, key) => {
      acc[key] = metric(rows.reduce((sum, row) => sum + (row[key]?.value || 0), 0));
      return acc;
    }, {});
    result.bay = 'bpWorkload';
    result.reportType = 'bpWorkload';
    result.title = 'B.P. Workload';
    result.customer = { name: 'B.P. Workload' };
    result.bpWorkload = {
      supported: true,
      facilityId,
      newOrdersWindow: '2026-06-02',
      pickedOrdersWindow: pickedYesterdayWindow,
      rows,
      totals,
      definitions: {
        unloadedYesterday: 'Trailer/container equipment devanned or offloaded yesterday.',
        containersFull: 'Trailer/container equipment currently FULL and waiting to offload.',
        newOrders: 'Orders created yesterday.',
        fillableOrders: 'Orders currently in PLANNED status.',
        ordersPickedYesterday: 'Orders with Picked Time yesterday and status PICKED, READY TO SHIP, PACKING, PACKED, STAGED, LOADING, LOADED, SHIPPED, PARTIAL SHIPPED, or SHORT SHIPPED.'
      }
    };
    result.metrics = [
      { label: 'Customers', value: String(rows.length), sub: 'Configured BP workload customers' },
      { label: 'Containers FULL', value: String(totals.containersFull.value), sub: 'Current WISE yard read' },
      { label: 'New Orders', value: String(totals.newOrders.value), sub: result.bpWorkload.newOrdersWindow },
      { label: 'Fillable Orders', value: String(totals.fillableOrders.value), sub: 'PLANNED orders' },
    ];
    return res.json(result);
  }

  if (tab === 'crateBarrel') {
    try {
      const crateCustomerId = 'ORG-359565';
      const crateRes = await fetch(
        `${WMS_API_BASE_URL}/wms-bam/yard/equipment/search`,
        { method: 'POST', headers, body: JSON.stringify({ currentPage: 1, pageSize: 500, customerId: crateCustomerId }) }
      );
      const crateJson = crateRes.ok ? await crateRes.json().catch(() => ({})) : {};
      const equipment = (crateJson.data?.list || crateJson.data || []);
      const rows = (Array.isArray(equipment) ? equipment : [])
        .filter(e => (e.customerId || e.customer?.id || crateCustomerId) === crateCustomerId || /EUROMARKET|CRATE|BARREL/i.test(e.customerName || e.customer?.name || ''))
        .map(e => ({
          equipmentNumber: e.equipmentNo || e.equipmentNumber || e.barcode || e.id || '',
          entryTicket: e.checkInEntry || e.lastEntryId || e.entryTicket || e.entryId || '',
          customer: e.customerName || e.customer?.name || 'Euromarket Designs, Inc.',
          type: e.type || e.equipmentType || '',
          equipmentType: e.equipmentType || e.type || '',
          status: e.equipmentStatus || e.status || '',
          carrier: e.carrierName || e.carrier || '',
          location: e.locationName || e.location || '',
          gateCheckIn: e.gateCheckInTime || e.checkIn || e.checkInTime || '',
          sealNumber: e.currentSealNo || e.inboundSealNo || e.outBoundSealNo || e.outboundSealNo || '',
          equipmentId: e.equipmentId || e.id || '',
          barcode: e.barcode || e.equipmentNo || e.equipmentNumber || '',
        }));
      const latestRows = rows.filter(r => r.gateCheckIn);
      result.bay = 'crateBarrel';
      result.reportType = 'crateEquipment';
      result.title = 'Crate & Barrel Equipment';
      result.customer = { id: crateCustomerId, name: 'Euromarket Designs, Inc.', code: 'EURDES0001' };
      result.customerSet = [{ name: 'Euromarket Designs, Inc.' }];
      result.plannedOrders = { supported: true, rows: [] };
      result.inYardFullEquipment = { supported: true, rows: [] };
      result.crateEquipment = {
        supported: true,
        rows,
        latestRows,
        historyRowCount: rows.length,
        latestRowCount: latestRows.length,
        unavailableReason: null,
      };
      result.metrics = [
        { label: 'Equipment History', value: String(rows.length), sub: 'WISE yard equipment' },
        { label: 'Latest Activity', value: String(latestRows.length), sub: 'Rows with gate check-in' },
        { label: 'Customer', value: 'Euromarket Designs', sub: 'Crate & Barrel' },
      ];
      return res.json(result);
    } catch (err) {
      console.error('Crate & Barrel fetch error:', err.message);
      result.reportType = 'crateEquipment';
      result.title = 'Crate & Barrel Equipment';
      result.customer = { id: 'ORG-359565', name: 'Euromarket Designs, Inc.', code: 'EURDES0001' };
      result.crateEquipment = { supported: false, rows: [], latestRows: [], historyRowCount: 0, latestRowCount: 0, unavailableReason: 'Crate & Barrel equipment data is unavailable.' };
      return res.json(result);
    }
  }

  if (tab === 'evelyn' && !includeAllCustomers) {
    return res.json(applyStaticTeam2LtlPayload(result, now, siteLabel));
  }

  // ── Fetch planned outbound orders ────────────────────────────────────────
  try {
    const orderResult = await fetchOrdersForTab(headers, cfg, includeAllCustomers);

    if (orderResult.ok) {
        const orders = orderResult.orders || [];
        const totalCount = orderResult.total || orders.length;

        const orgIds = new Set();
        for (const o of orders) {
          if (o.customerId) orgIds.add(o.customerId);
          if (o.carrierId) orgIds.add(o.carrierId);
          if (o.retailerId) orgIds.add(o.retailerId);
        }
        const orgNames = await resolveOrgNames([...orgIds], req.accessToken, req.tenantId);

        const allRows = orders.map(o => ({
          orderNumber: o.id,
          customer: orgNames[o.customerId || o.customer?.id || o.customer?.organizationId] || o.customerName || o.customer?.name || o.customerId || o.customer?.id || 'Unknown',
          customerId: o.customerId || o.customer?.id || o.customer?.organizationId || '',
          status: o.status,
          reference: o.referenceNo || o.poNo || '',
          created: o.createdTime,
          shipMethod: o.shipMethod || '',
          carrier: orgNames[o.carrierId] || o.carrierId || '',
          scheduleDate: o.scheduleDate,
          mabd: o.mabd,
          appointmentTime: o.appointmentTime,
          retailerName: orgNames[o.retailerId] || o.retailerId || '',
          orderType: o.orderType,
          source: o.source,
          baseQty: Number(o.baseQty ?? o.totalQty ?? o.itemLineTotalQty ?? o.estPiecePickQty ?? o.qty ?? 0) || 0,
          palletQty: Number(o.palletQty ?? o.estPalletPickQty ?? 0) || 0,
          stagingLocation: o.stagingLocation || o.stagingLocationName || '',
          prestatus: o.prestatus || o.preStatus || o.secondaryStatus || '',
          po: o.poNo || o.referenceNo || '',
          so: Array.isArray(o.soNos) ? o.soNos.join(', ') : (o.soNos || o.soNo || ''),
          bolNo: o.bolNo,
          loadNo: o.loadNo,
          orderPlanId: o.orderPlanId || o.planId || '',
          shipToName: o.shipToAddress?.name || o.shipToName || '',
        }));

        let rows = includeAllCustomers ? allRows : allRows.filter(row => rowMatchesTab(row, cfg));

        // Safety guard: Team 4 must be Gurunanda only. Never let the generic LT_F1
        // planned-order page leak other customers into this tab if WISE ignores a
        // customer filter parameter.
        if (tab === 'bay4' && !includeAllCustomers) {
          rows = allRows.filter(row =>
            row.customerId === 'ORG-655875' || normalizeName(row.customer).includes('GURUNANDA')
          );
        }

        const seenCustomers = new Set();
        const customerSet = [];
        for (const row of rows) {
          if (row.customer && !seenCustomers.has(row.customer)) {
            seenCustomers.add(row.customer);
            customerSet.push({ name: row.customer });
          }
        }

        result.plannedOrders.rows = rows;
        result.customer = { name: customerSet[0]?.name || cfg.title || siteLabel };
        result.customerSet = customerSet;
        result.metrics = [
          { label: 'Total Planned', value: rows.length },
          { label: 'Customers', value: customerSet.length },
        ];

        if (tab === 'bay2') {
          const aged24Rows = [];
          const aged48Rows = [];
          const nowMs = Date.now();

          for (const row of rows) {
            const createdMs = row.created ? new Date(row.created).getTime() : NaN;
            const ageHours = Number.isNaN(createdMs) ? null : Math.floor((nowMs - createdMs) / 36e5);
            const detail = { ...row, ageHours };
            if (ageHours != null && ageHours >= 24) aged24Rows.push(detail);
            if (ageHours != null && ageHours >= 48) aged48Rows.push(detail);
          }

          const dropshipRows = rows.filter(isDropshipOrder);
          function buildPivot(sourceRows, customerNames, side) {
            const byCustomer = new Map();
            for (const row of sourceRows) {
              if (!customerMatchesAny(row.customer, customerNames)) continue;
              const customer = row.customer || 'Unknown';
              if (!byCustomer.has(customer)) {
                byCustomer.set(customer, { kind: 'customer', side, level: 0, label: customer, orderCount: 0, baseQty: 0 });
              }
              const pivot = byCustomer.get(customer);
              pivot.orderCount += 1;
              pivot.baseQty += Number(row.baseQty || 0);
            }
            return Array.from(byCustomer.values()).sort((a, b) => b.orderCount - a.orderCount);
          }

          const leftPivotRows = buildPivot(dropshipRows, BAY2_LEFT_DROPSHIP_CUSTOMERS, 'left');
          const grandTotal = {
            kind: 'grandTotal', side: 'left', level: 0, label: 'Grand Total',
            orderCount: leftPivotRows.reduce((sum, r) => sum + r.orderCount, 0),
            baseQty: leftPivotRows.reduce((sum, r) => sum + r.baseQty, 0),
          };
          if (leftPivotRows.length) leftPivotRows.push(grandTotal);

          const mezzanineRows = buildPivot(dropshipRows, BAY2_MEZZANINE_DROPSHIP_CUSTOMERS, 'right');
          const mezzanineTotal = {
            kind: 'grandTotal', side: 'right', level: 0, label: 'Grand Total',
            orderCount: mezzanineRows.reduce((sum, r) => sum + r.orderCount, 0),
            baseQty: mezzanineRows.reduce((sum, r) => sum + r.baseQty, 0),
          };
          if (mezzanineRows.length) mezzanineRows.push(mezzanineTotal);
          const pivotRows = [...leftPivotRows, ...mezzanineRows];
          const team2DetailRows = buildTeam2DetailRows(rows);
          const sheet2Summary = buildTeam2Sheet2Summary(team2DetailRows);

          result.bay2 = {
            supported: true,
            pivotRows,
            mezzanineRows,
            sheet2Summary,
            detailRows: team2DetailRows,
            aged24Rows,
            aged48Rows,
            // Bottom Team 2 sections in the original screen.
            // Dropship Amazon FBA is derived from rows with Amazon/FBA signals in
            // retailer/source/reference/order fields. Delta LTL is derived from
            // LTL ship method or Delta customer rows.
            dropShipAmazonFbaRows: rows.filter(r => {
              const haystack = normalizeName([
                r.customer, r.retailerName, r.reference, r.po, r.so, r.source, r.orderType, r.shipMethod
              ].join(' '));
              return haystack.includes('AMAZON') || haystack.includes('FBA') || haystack.includes('FBM');
            }).map(r => ({
              kind: 'detail', side: 'bottom', level: 0, label: r.customer || 'Amazon FBA',
              customer: r.customer, orderNumber: r.orderNumber, status: r.status,
              orderCount: 1, baseQty: Number(r.baseQty || 0), carrier: r.carrier,
              created: r.created, source: r.source
            })),
            deltaLtlRows: rows.filter(r => {
              const haystack = normalizeName([r.customer, r.shipMethod, r.carrier, r.retailerName].join(' '));
              return haystack.includes('DELTA') || haystack.includes('LTL');
            }).map(r => ({
              facility: siteLabel,
              customer: r.customer,
              orderNumber: r.orderNumber,
              status: r.status,
              prestatus: r.prestatus || '',
              baseQty: Number(r.baseQty || 0),
              appointmentTime: r.appointmentTime || r.scheduleDate || '',
              carrier: r.carrier
            })),
          };
          result.metrics = [
            { label: 'Count of Order #', value: String(sheet2Summary.total.orderCount), sub: 'WISE planned orders' },
            { label: 'Sum of BASE QTY', value: String(sheet2Summary.total.baseQty), sub: 'WISE base quantity' },
            { label: 'Past SLA', value: String(aged24Rows.length), sub: 'Orders older than 24 hours' },
            { label: 'Customers', value: String(customerSet.length), sub: 'Team 2 customer set' },
          ];
        }
    } else {
      result.plannedOrders.supported = false;
      result.plannedOrders.unavailableReason = 'Planned order data is temporarily unavailable from WISE.';
    }
  } catch (err) {
    console.error(`Dashboard [${tab}] order fetch error:`, err.message);
    result.plannedOrders.supported = false;
    result.plannedOrders.unavailableReason = 'Planned order data is temporarily unavailable.';
  }

  // ── Fetch in-yard equipment ──────────────────────────────────────────────
  try {
    const useFullToOffloadMetric = usesFullToOffloadCustomerMetric(facilityId, facilityName, tab);
    const equipment = await fetchAllYardEquipment(headers, useFullToOffloadMetric);
    if (Array.isArray(equipment)) {
        result.inYardFullEquipment.rows = equipment
          .filter(e => {
            const customerId = e.customerId || e.customer?.id || e.customerOrgId || '';
            const customerName = e.customerName || e.customer?.name || '';
            const status = e.equipmentStatus || e.status || '';
            const opStatus = e.equipmentOperationStatus || e.details || e.operationStatus || '';
            const type = e.equipmentType || e.type || '';

            // Section 1 should follow the Full-to-Offload Sheet2 pivot customer set.
            const pivotCustomerNames = [
              'ALL MARKET INC / VITA COCO',
              'AMIEE LYNN, LNC.',
              'Euromarket Designs, Inc.',
              'GURUNANDA, LLC',
              'LENNOX INDUSTRIES INC.',
              'WOODY FLAW CREST INC'
            ];
            const pivotCustomerMatch = pivotCustomerNames.some(name => normalizeName(customerName).includes(normalizeName(name)) || normalizeName(name).includes(normalizeName(customerName)));
            const tabCustomerMatch = includeAllCustomers
              || (!cfg.customerIds?.length && !cfg.customerNames?.length)
              || (cfg.customerIds || []).includes(customerId)
              || rowMatchesTab({ customer: customerName, customerId }, cfg);
            const fullToOffloadMatch = isFullToOffloadContainer(e);

            if (tab === 'bay1') {
              return tabCustomerMatch && isTeam1ExcelFullToOffloadContainer(e);
            }

            if (tab === 'bay3' && (isEuromarketCustomer(customerName) || isEuromarketCustomer(customerId))) {
              return false;
            }

            if (useFullToOffloadMetric) {
              // Valley View Night Shift, Fontana, and Alessandro follow the Full-to-Offload metric:
              // CONTAINER + FULL + FULL_TO_OFFLOAD, excluding Euromarket / Crate & Barrel only.
              return fullToOffloadMatch && !isEuromarketCustomer(customerName) && !isEuromarketCustomer(customerId);
            }
            return tabCustomerMatch && fullToOffloadMatch;
          })
          .map(e => ({
            equipmentNumber: e.equipmentNo || e.equipmentNumber || e.barcode || e.id,
            equipmentType: e.equipmentType || e.type || '',
            entryTicket: e.checkInEntry || e.entryTicket || e.entryId || '',
            checkIn: e.gateCheckInTime || e.checkIn || e.checkInTime || e.createdTime || '',
            timeInYard: e.inYardTime || e.timeInYard || '',
            customer: useFullToOffloadMetric
              ? nightShiftCustomerName(e.customerName || e.customer?.name || '', e.customerId || e.customer?.id || e.customerOrgId || '')
              : (e.customerName || e.customer?.name || e.customerId || ''),
            location: e.locationName || e.location || '',
            status: e.equipmentStatus || e.status || '',
            details: e.equipmentOperationStatus || e.details || '',
          }));
        result.inYardFullEquipment.candidateCount = result.inYardFullEquipment.rows.length;
        if (useFullToOffloadMetric && tab !== 'nightShift') {
          const fullToOffloadRows = result.inYardFullEquipment.rows.filter(e => normalizeName(e.customer) !== normalizeName('Night Shift — All FULL Trailers & Containers'));
          result.inYardFullEquipment.rows = fullToOffloadRows;
          result.inYardFullEquipment.candidateCount = fullToOffloadRows.length;
          const fullToOffloadCustomerCounts = buildCustomerCounts(fullToOffloadRows);
          result.customerSet = fullToOffloadCustomerCounts;
          result.metrics = [
            { label: 'Customers', value: String(fullToOffloadCustomerCounts.length), sub: 'Full-to-offload customer set' },
            { label: 'FULL Containers', value: String(fullToOffloadRows.length), sub: 'Not yet devanned' },
          ];
        }
        if (tab === 'nightShift') {
          const nightShiftRows = result.inYardFullEquipment.rows.filter(e => normalizeName(e.customer) !== normalizeName('Night Shift — All FULL Trailers & Containers'));
          result.inYardFullEquipment.rows = nightShiftRows;
          result.inYardFullEquipment.candidateCount = nightShiftRows.length;
          const sortedNightShiftRows = [...nightShiftRows].sort((a, b) => {
            const at = new Date(a.checkIn || a.gateCheckInTime || a.createdTime || 0).getTime();
            const bt = new Date(b.checkIn || b.gateCheckInTime || b.createdTime || 0).getTime();
            return (Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt);
          });
          result.inYardFullEquipment.rows = sortedNightShiftRows;
          result.inYardFullEquipment.candidateCount = sortedNightShiftRows.length;
          const nightShiftCustomerCounts = buildCustomerCounts(sortedNightShiftRows);
          result.customerSet = nightShiftCustomerCounts.length
            ? nightShiftCustomerCounts
            : NIGHT_SHIFT_CUSTOMERS.map(name => ({ name, count: 0 }));
          result.customer = { name: 'Night Shift' };
          result.metrics = [
            { label: 'Customers', value: String(result.customerSet.length), sub: 'Valley View Night Shift set' },
            { label: 'FULL Containers', value: String(sortedNightShiftRows.length), sub: 'Not yet devanned' },
          ];
          result.nightShift = {
            supported: true,
            title: 'Night Shift - Full to Offload Containers',
            rows: sortedNightShiftRows.map(e => ({
              equipmentNo: e.equipmentNumber || '',
              equipmentType: e.equipmentType || '',
              customerName: e.customer || '',
              equipmentStatus: e.status || 'FULL',
              equipmentOperationStatus: e.details || 'FULL_TO_OFFLOAD',
              locationName: e.location || '',
              checkInEntry: e.entryTicket || '',
              gateCheckInTime: e.checkIn || '',
              inYardTime: e.timeInYard || '',
              loadId: '',
              receiptId: '',
              orderId: '',
              carrierName: ''
            })),
            totalCount: sortedNightShiftRows.length,
            customerCounts: nightShiftCustomerCounts
          };
        }
    }
  } catch {}

  return res.json(result);
});

// ── Static file serving ────────────────────────────────────────────────────

const staticDir = path.join(__dirname, 'website-source');
app.use(express.static(staticDir, {
  setHeaders(res, filePath) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// SPA fallback - serve index.html for any non-API, non-static request
app.get('/{*path}', (req, res) => {
  // Don't intercept API routes
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'Not found' });
  const indexPath = path.join(staticDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Not found');
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Valley View WMS Dashboard running on http://0.0.0.0:${PORT}`);
});
