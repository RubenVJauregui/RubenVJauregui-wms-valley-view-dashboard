import { NextRequest, NextResponse } from "next/server";
import { exchangeToken } from "@/lib/iam";
import { getUserProfile } from "@/lib/wms";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { username, password } = body;

    if (!username?.trim() || !password?.trim()) {
      return NextResponse.json(
        { message: "Enter your username and password." },
        { status: 400 }
      );
    }

    const result = await exchangeToken({ username: username.trim(), password });

    if (!result.ok || !result.data) {
      return NextResponse.json(
        { message: result.error || "Sign in failed." },
        { status: 401 }
      );
    }

    const { access_token, refresh_token, token_type, expires_in, identity } =
      result.data;

    // Decode JWT to get user_id and tenant_id
    const payloadBase64 = access_token.split(".")[1];
    let jwtPayload: Record<string, unknown> = {};
    try {
      jwtPayload = JSON.parse(
        Buffer.from(payloadBase64, "base64url").toString("utf8")
      );
    } catch {
      // use identity from login response
    }

    const nested = (jwtPayload.data as Record<string, unknown>) ?? identity ?? {};
    const userId = String(nested.user_id ?? "");
    const tenantId =
      String(nested.tenant_id ?? nested.company_code ?? "LT");

    if (!userId || !tenantId) {
      return NextResponse.json(
        { message: "Warehouse access could not be loaded." },
        { status: 403 }
      );
    }

    // Load facilities
    let facilities: { id: string; name: string; timeZone: string }[] = [];
    let defaultFacility: { id: string; name: string } | null = null;

    try {
      const profile = await getUserProfile(userId, access_token, tenantId);
      facilities = profile?.profile?.facilities ?? [];
      defaultFacility = profile?.profile?.defaultFacility ?? facilities[0] ?? null;
    } catch {
      return NextResponse.json(
        { message: "No warehouse access is available for this account." },
        { status: 403 }
      );
    }

    if (!facilities.length) {
      return NextResponse.json(
        { message: "No warehouse access is available for this account." },
        { status: 403 }
      );
    }

    return NextResponse.json({
      accessToken: access_token,
      refreshToken: refresh_token,
      tokenType: token_type,
      expiresIn: expires_in,
      identity: {
        user_id: userId,
        user_name: nested.user_name ?? username,
        tenant_id: tenantId,
      },
      facilities,
      defaultFacility,
    });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Authentication failed." },
      { status: 500 }
    );
  }
}
