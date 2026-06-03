import { NextRequest, NextResponse } from "next/server";
import { loadDashboard } from "@/lib/wms";

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const tenantId = request.headers.get("x-tenant-id");
  const facilityId = request.headers.get("x-facility-id");

  if (!auth?.startsWith("Bearer ") || !tenantId || !facilityId) {
    return NextResponse.json(
      { message: "Missing required auth headers." },
      { status: 401 }
    );
  }

  const token = auth.slice(7);

  try {
    const body = await request.json().catch(() => ({}));
    const facilityName = body.facilityName || "Valley View";
    const tab = body.tab || "";

    // Check token expiry
    try {
      const payloadBase64 = token.split(".")[1];
      const payload = JSON.parse(
        Buffer.from(payloadBase64, "base64url").toString("utf8")
      );
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        return NextResponse.json(
          { message: "Session expired. Sign in again." },
          { status: 401 }
        );
      }
    } catch {
      // continue with the request even if we can't decode the token
    }

    const data = await loadDashboard(
      token,
      tenantId,
      facilityId,
      facilityName,
      tab
    );

    return NextResponse.json(data);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("401")
    ) {
      return NextResponse.json(
        { message: "Session expired. Sign in again." },
        { status: 401 }
      );
    }
    return NextResponse.json(
      {
        title: facilityId,
        siteLabel: facilityId,
        source: "WISE",
        refreshedAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        customer: { name: facilityId },
        customerSet: [],
        plannedOrders: {
          supported: false,
          rows: [],
          unavailableReason: "This report data is currently unavailable.",
        },
        inYardFullEquipment: {
          supported: false,
          rows: [],
          unavailableReason: "This report data is currently unavailable.",
        },
      },
      { status: 200 }
    );
  }
}
