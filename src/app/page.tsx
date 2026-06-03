"use client";

import { useState, useEffect, useCallback } from "react";
import { AuthState, login, saveAuth, loadAuth, clearAuth } from "@/lib/auth";
import Login from "@/components/Login";
import Dashboard from "@/components/Dashboard";

export default function Home() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const saved = loadAuth();
    if (saved) setAuth(saved);
    setLoading(false);
  }, []);

  const handleLogin = useCallback(async (username: string, password: string) => {
    const state = await login(username, password);
    saveAuth(state);
    setAuth(state);
  }, []);

  const handleLogout = useCallback(() => {
    clearAuth();
    setAuth(null);
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--color-surface)]">
        <div className="text-[var(--color-text-muted)] text-sm">Loading...</div>
      </div>
    );
  }

  if (!auth) {
    return <Login onLogin={handleLogin} />;
  }

  return <Dashboard auth={auth} onLogout={handleLogout} />;
}
