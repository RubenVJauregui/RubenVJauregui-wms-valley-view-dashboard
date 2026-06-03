import { NextRequest, NextResponse } from "next/server";
import { loadDashboard } from "@/lib/wms";
import fs from "fs";
import path from "path";

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const tenantId = request.headers.get("x-tenant-id");
  const facilityId = request.headers.get("x-facility-id");

  if (!auth?.startsWith("Bearer ") || !tenantId || !facilityId) {
    return NextResponse.json(
      { message: "Missing required auth headers." },
      { status: 401 },
    );
  }

  const token = auth.slice(7);

  try {
    try {
      const payloadBase64 = token.split(".")[1];
      const payload = JSON.parse(
        Buffer.from(payloadBase64, "base64url").toString("utf8"),
      );
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        return NextResponse.json(
          { message: "Session expired. Sign in again." },
          { status: 401 },
        );
      }
    } catch {
      // continue even if we can't decode the token
    }

    const body = await request.json().catch(() => ({}));
    const facilityName = body.facilityName || "Fontana";

    if (!body.facilityId) {
      return NextResponse.json(
        { message: "Facility is required." },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();

    // Read evelyn-pivot.json for Team 2 LTL / E-comm LTL data
    try {
      const filePath = path.join(process.cwd(), "evelyn-pivot.json");
      const raw = fs.readFileSync(filePath, "utf8");
      const workbookPivot = JSON.parse(raw);

      const result = {
        bay: "evelyn",
        reportType: "evelynGreenPivot",
        title: "E-comm LTL",
        siteLabel: "Fontana",
        source: "WISE",
        refreshedAt: workbookPivot.generatedAt || now,
        generatedAt: workbookPivot.generatedAt || now,
        customer: { name: "E-comm LTL" },
        customerSet: (workbookPivot.evelynGreen?.rows || [])
          .filter((r: { level: number }) => r.level === 0)
          .map((r: { label: string }) => ({ name: r.label })),
        plannedOrders: { supported: true, rows: [] },
        inYardFullEquipment: { supported: true, rows: [] },
        evelynGreen:
          workbookPivot.evelynGreen || {
            supported: true,
            rows: [],
            total: { orderCount: 0, baseQty: 0 },
            aged72Rows: [],
          },
        detailRows: workbookPivot.detailRows || [],
        metrics: workbookPivot.metrics || [],
      };

      return NextResponse.json(result);
    } catch {
      return NextResponse.json(
        {
          title: "E-comm LTL",
          siteLabel: "Fontana",
          source: "WISE",
          refreshedAt: now,
          generatedAt: now,
          customer: { name: "E-comm LTL" },
          customerSet: [],
          plannedOrders: { supported: true, rows: [] },
          inYardFullEquipment: { supported: true, rows: [] },
          evelynGreen: {
            supported: false,
            rows: [],
            total: { orderCount: 0, baseQty: 0 },
            aged72Rows: [],
            unavailableReason: "E-comm LTL pivot data is unavailable.",
          },
          metrics: [],
        },
        { status: 200 },
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("401")) {
      return NextResponse.json(
        { message: "Session expired. Sign in again." },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { message: "E-comm LTL data is unavailable." },
      { status: 200 },
    );
  }
}
