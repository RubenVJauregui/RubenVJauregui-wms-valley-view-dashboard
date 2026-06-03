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

function normalizeName(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function normalizeWiseCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isFullToOffloadContainer(row) {
  const type = normalizeWiseCode(row.equipmentType || row.type || '');
  const status = normalizeWiseCode(row.equipmentStatus || row.status || '');
  const detail = normalizeWiseCode(row.equipmentOperationStatus || row.details || row.operationStatus || '');

  // Mirrors the "Full to offload.xlsx" pivot:
  // Equipment Type = CONTAINER; Status includes FULL and blank;
  // Details excludes EMPTY_TO_LOAD and EMPTY_AFTER_OFFLOADED.
  if (type !== 'CONTAINER') return false;
  if (status && status !== 'FULL') return false;
  return !['EMPTY_TO_LOAD', 'EMPTY_AFTER_OFFLOADED'].includes(detail);
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
  return NIGHT_SHIFT_CUSTOMERS.some((name) => normalized === normalizeName(name));
}

function getTaskAssignedAt(task) {
  return task.lastAssignedWhen || task.lastAssignedTime || task.assignedTime || task.updatedTime || task.modifiedTime || task.createdTime || '';
}

function isWithinRange(value, start, end) {
  const time = value ? new Date(value).getTime() : NaN;
  return !Number.isNaN(time) && time >= start.getTime() && time <= end.getTime();
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

async function fetchOrdersForTab(headers, cfg) {
  const base = {
    currentPage: 1,
    pageSize: 500,
    customerId: undefined,
    statuses: ['PLANNED'],
    sortingFields: [{ field: 'createdTime', orderBy: 'DESC' }]
  };
  if (cfg.customerIds && cfg.customerIds.length) {
    // Query each customer explicitly so tabs are not limited by the first 500 all-facility orders.
    const batches = await Promise.all(cfg.customerIds.map(id => fetchOrderPage(headers, { ...base, customerId: id })));
    const merged = [];
    const seen = new Set();
    for (const b of batches) for (const o of b.orders) {
      if (!seen.has(o.id)) { seen.add(o.id); merged.push(o); }
    }
    // If the API ignored customer filters or returned nothing, fallback to a generic page and filter after mapping.
    if (merged.length) return { ok: true, orders: merged, total: merged.length };
  }
  return fetchOrderPage(headers, base);
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
    const totals = ['unloadedYesterday', 'containersFull', 'ordersPickedYesterday', 'newOrders', 'fillableOrders'].reduce((acc, key) => {
      acc[key] = metric(rows.reduce((sum, row) => sum + (row[key]?.value || 0), 0));
      return acc;
    }, {});
    result.bay = 'bpWorkload';
    result.reportType = 'bpWorkload';
    result.title = 'Buena Park Report';
    result.customer = { name: 'B.P. Workload' };
    result.bpWorkload = {
      supported: true,
      facilityId,
      newOrdersWindow: '2026-06-02',
      rows,
      totals,
      definitions: {
        unloadedYesterday: 'Trailer/container equipment devanned or offloaded yesterday.',
        containersFull: 'Trailer/container equipment currently FULL and waiting to offload.',
        newOrders: 'Orders created yesterday.',
        fillableOrders: 'Orders currently in PLANNED status.',
        ordersPickedYesterday: 'Unique orders represented in WISE pick history yesterday.'
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

  if (tab === 'evelyn') {
    try {
      const workbookPivot = JSON.parse(fs.readFileSync(path.join(__dirname, 'evelyn-pivot.json'), 'utf8'));
      result.bay = 'evelyn';
      result.reportType = 'evelynGreenPivot';
      result.title = 'Team 2 LTL';
      result.customer = { name: 'Team 2 LTL' };
      result.customerSet = (workbookPivot.evelynGreen?.rows || [])
        .filter(r => r.level === 0)
        .map(r => ({ name: r.label }));
      result.metrics = workbookPivot.metrics || [];
      result.evelynGreen = workbookPivot.evelynGreen || { supported: true, rows: [], total: { orderCount: 0, baseQty: 0 }, aged72Rows: [] };
      result.detailRows = workbookPivot.detailRows || [];
      result.plannedOrders = { supported: true, rows: [] };
      result.inYardFullEquipment = { supported: true, rows: [] };
      result.refreshedAt = workbookPivot.generatedAt || now;
      result.generatedAt = workbookPivot.generatedAt || now;
      return res.json(result);
    } catch (err) {
      console.error('Team 2 LTL workbook parse error:', err.message);
      result.reportType = 'evelynGreenPivot';
      result.customer = { name: 'Team 2 LTL' };
      result.evelynGreen = { supported: false, rows: [], total: { orderCount: 0, baseQty: 0 }, aged72Rows: [], unavailableReason: 'Team 2 LTL pivot data is unavailable.' };
      result.metrics = [];
      return res.json(result);
    }
  }

  // ── Fetch planned outbound orders ────────────────────────────────────────
  try {
    const orderResult = await fetchOrdersForTab(headers, cfg);

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

          result.bay2 = {
            supported: true,
            pivotRows,
            mezzanineRows,
            detailRows: rows,
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
            { label: 'Count of Order #', value: String(grandTotal.orderCount), sub: 'WISE planned orders' },
            { label: 'Sum of BASE QTY', value: String(grandTotal.baseQty), sub: 'WISE base quantity' },
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
    const yardRes = await fetch(
      `${WMS_API_BASE_URL}/wms-bam/yard/equipment/search`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          currentPage: 1,
          pageSize: 500,
          ...(tab === 'nightShift' ? {} : { statuses: ['FULL'] })
        })
      }
    );
    if (yardRes.ok) {
      const yardJson = await yardRes.json();
      if (yardJson.code === 0 || String(yardJson.code) === '0') {
        const equipment = (yardJson.data?.list || yardJson.data || []);
        result.inYardFullEquipment.rows = (Array.isArray(equipment) ? equipment : [])
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
            const tabCustomerMatch = (!cfg.customerIds?.length && !cfg.customerNames?.length)
              || (cfg.customerIds || []).includes(customerId)
              || rowMatchesTab({ customer: customerName, customerId }, cfg);
            const fullToOffloadMatch = isFullToOffloadContainer(e);
            if (tab === 'nightShift') {
              // Valley View Night Shift detail must match the two customer chips.
              return fullToOffloadMatch && isNightShiftCustomer(customerName);
            }
            return pivotCustomerMatch && tabCustomerMatch && fullToOffloadMatch;
          })
          .map(e => ({
            equipmentNumber: e.equipmentNo || e.equipmentNumber || e.barcode || e.id,
            equipmentType: e.equipmentType || e.type || '',
            entryTicket: e.checkInEntry || e.entryTicket || e.entryId || '',
            checkIn: e.gateCheckInTime || e.checkIn || e.checkInTime || e.createdTime || '',
            timeInYard: e.inYardTime || e.timeInYard || '',
            customer: e.customerName || e.customer?.name || e.customerId || '',
            location: e.locationName || e.location || '',
            status: e.equipmentStatus || e.status || '',
            details: e.equipmentOperationStatus || e.details || '',
          }));
        result.inYardFullEquipment.candidateCount = result.inYardFullEquipment.rows.length;
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
            customerCounts: buildCustomerCounts(sortedNightShiftRows)
          };
        }
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
