const IAM_BASE_URL = process.env.NEXT_PUBLIC_IAM_BASE_URL || "https://id.item.com";
const WMS_API_BASE_URL = process.env.NEXT_PUBLIC_WMS_API_BASE_URL || "https://unis.item.com/api";

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  userId: string;
  facilityId: string;
  facilities: Array<{ id: string; name: string; code: string }>;
  username: string;
}

function decodeJwt(token: string): Record<string, unknown> {
  const base64 = token.split(".")[1];
  const json = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json);
}

export async function login(username: string, password: string): Promise<AuthState> {
  const res = await fetch(`${IAM_BASE_URL}/auth/exchange-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "password", username, password }),
  });

  const json = await res.json();
  if (String(json.code) !== "0") {
    throw new Error(json.msg || "Sign in failed");
  }

  const { access_token, refresh_token } = json.data;
  const payload = decodeJwt(access_token);
  const identity = (payload.data as Record<string, unknown>) ?? {};
  const userId = String(identity.user_id ?? "");
  const tenantId = String(identity.tenant_id ?? identity.company_code ?? "");

  if (!userId || !tenantId) {
    throw new Error("Could not resolve warehouse access.");
  }

  const facRes = await fetch(`${WMS_API_BASE_URL}/wms-bam/user/${userId}`, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      "x-tenant-id": tenantId,
    },
  });
  const facJson = await facRes.json();
  const profile = facJson?.data?.profile;
  const facilities = (profile?.facilities || []).map((f: Record<string, unknown>) => ({
    id: String(f.id ?? ""),
    name: String(f.name ?? ""),
    code: String(f.code ?? ""),
  }));

  const defaultFac = profile?.defaultFacility;
  const valleyView = facilities.find((f: { code: string }) => f.code === "LT_F1") ||
    (defaultFac ? { id: String(defaultFac.id), name: String(defaultFac.name), code: String(defaultFac.code) } : facilities[0]);

  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    tenantId,
    userId,
    facilityId: valleyView?.id || "",
    facilities,
    username,
  };
}

export function saveAuth(auth: AuthState) {
  sessionStorage.setItem("wms_auth", JSON.stringify(auth));
}

export function loadAuth(): AuthState | null {
  try {
    const raw = sessionStorage.getItem("wms_auth");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearAuth() {
  sessionStorage.removeItem("wms_auth");
}
