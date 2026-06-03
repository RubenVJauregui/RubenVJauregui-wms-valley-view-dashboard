"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { Session } from "@/app/page";

const UNIS_LOGO =
  "https://unisco.sfo3.digitaloceanspaces.com/design-unisco-com/svg/unis-logo.svg";

export function LoginPanel({ onLogin }: { onLogin: (s: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError("Enter your username and password.");
      return;
    }
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(
          json.message || "Sign in failed. Check your credentials and try again."
        );
        setLoading(false);
        return;
      }

      if (!json.facilities?.length) {
        setError("No warehouse access is available for this account.");
        setLoading(false);
        return;
      }

      onLogin({
        accessToken: json.accessToken,
        refreshToken: json.refreshToken,
        expiresAt: Date.now() + 1000 * Number(json.expiresIn ?? 3600),
        identity: json.identity,
        facilities: json.facilities,
        defaultFacility: json.defaultFacility,
      });
    } catch {
      setError("Unable to connect. Check your network and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <img className="login-logo" src={UNIS_LOGO} alt="UNIS" />
        <div>
          <p className="eyebrow">Warehouse dashboard</p>
          <h1>Valley View</h1>
          <p className="login-copy">
            Valley View is selected by default when available on your account.
          </p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Username
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <p className="login-error-message">{error || "Enter your username and password."}</p>
          <button className="primary-button" type="submit" disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : null}
            Sign in
          </button>
        </form>
      </section>
    </main>
  );
}
