import { NextRequest, NextResponse } from "next/server";
import { refreshToken } from "@/lib/iam";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { refreshToken: rt } = body;

    if (!rt) {
      return NextResponse.json(
        { message: "Refresh token is required." },
        { status: 400 }
      );
    }

    const result = await refreshToken(rt);

    if (!result.ok || !result.data) {
      return NextResponse.json(
        { message: result.error || "Session expired. Sign in again." },
        { status: 401 }
      );
    }

    return NextResponse.json({
      accessToken: result.data.access_token,
      refreshToken: result.data.refresh_token,
      expiresIn: result.data.expires_in,
    });
  } catch {
    return NextResponse.json(
      { message: "Session expired. Sign in again." },
      { status: 401 }
    );
  }
}
