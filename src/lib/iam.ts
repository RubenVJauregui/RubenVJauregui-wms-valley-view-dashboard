const IAM_BASE_URL = process.env.IAM_BASE_URL || "https://id.item.com";

export interface IamTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  identity?: Record<string, unknown>;
}

export interface IamLoginPayload {
  username: string;
  password: string;
}

export async function exchangeToken(
  payload: IamLoginPayload
): Promise<{ ok: boolean; data?: IamTokenResponse; error?: string }> {
  const res = await fetch(`${IAM_BASE_URL}/auth/exchange-token`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      username: payload.username,
      password: payload.password,
    }),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || (json.code && String(json.code) !== "0")) {
    return { ok: false, error: json.msg || json.message || "Sign in failed." };
  }

  return {
    ok: true,
    data: {
      access_token: json.data?.access_token ?? json.access_token,
      refresh_token: json.data?.refresh_token ?? json.refresh_token,
      token_type: json.data?.token_type ?? json.token_type ?? "Bearer",
      expires_in: json.data?.expires_in ?? json.expires_in ?? 3600,
      identity: json.data,
    },
  };
}

export async function refreshToken(
  refreshToken: string
): Promise<{ ok: boolean; data?: IamTokenResponse; error?: string }> {
  const res = await fetch(
    `${IAM_BASE_URL}/auth/token/refresh?refreshToken=${encodeURIComponent(refreshToken)}`,
    {
      method: "GET",
      cache: "no-store",
    }
  );

  const json = await res.json().catch(() => ({}));

  if (!res.ok || (json.code && String(json.code) !== "0")) {
    return { ok: false, error: json.msg || "Token refresh failed." };
  }

  return {
    ok: true,
    data: {
      access_token: json.data?.access_token ?? json.access_token,
      refresh_token: json.data?.refresh_token ?? json.refresh_token,
      token_type: json.data?.token_type ?? json.token_type ?? "Bearer",
      expires_in: json.data?.expires_in ?? json.expires_in ?? 3600,
    },
  };
}
