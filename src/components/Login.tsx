"use client";

import { useState } from "react";

interface LoginProps {
  onLogin: (username: string, password: string) => Promise<void>;
}

export default function Login({ onLogin }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setError("");
    setSubmitting(true);
    try {
      await onLogin(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center bg-[var(--color-surface)]">
      <div className="w-full max-w-sm mx-4">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 mb-4">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <rect width="28" height="28" rx="6" fill="#3b82f6" />
              <path d="M7 14h4l3-6 4 12 3-6h4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-lg font-semibold text-[var(--color-text-primary)] tracking-tight">UNIS</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-1">Warehouse Dashboard</p>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)] tracking-tight">Valley View</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2.5 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
              placeholder="Enter username"
              autoComplete="username"
              disabled={submitting}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
              placeholder="Enter password"
              autoComplete="current-password"
              disabled={submitting}
            />
          </div>

          {error && (
            <div className="text-xs text-[var(--color-danger)] bg-[var(--color-danger-dim)] px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !username || !password}
            className="w-full py-2.5 bg-[var(--color-accent)] text-white text-sm font-medium rounded-lg hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <p className="text-center text-xs text-[var(--color-text-muted)] mt-6">
          Valley View is selected by default when available on your account.
        </p>
      </div>
    </div>
  );
}
