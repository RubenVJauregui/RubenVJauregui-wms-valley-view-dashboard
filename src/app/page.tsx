"use client";

import { useState, useEffect, useCallback } from "react";
import { LoginPanel } from "@/components/login";
import { Dashboard } from "@/components/dashboard";
import { Loader2 } from "lucide-react";

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  identity: {
    user_id: string;
    user_name: string;
    tenant_id: string;
  };
  facilities: { id: string; name: string; timeZone: string }[];
  defaultFacility: { id: string; name: string } | null;
}

export interface Facility {
  id: string;
  name: string;
  timeZone: string;
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const base64 = token.split(".")[1];
    return JSON.parse(Buffer.from(base64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const SESSION_KEY = "bay4-wms-session";
const FACILITY_KEY = "bay4-wms-facility";
const TAB_KEY = "bay4-wms-active-bay";

function loadSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (Date.now() > s.expiresAt - 60000) return null;
    return s;
  } catch {
    return null;
  }
}

function saveSession(s: Session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(FACILITY_KEY);
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [facility, setFacility] = useState<Facility | null>(null);
  const [activeTab, setActiveTab] = useState<string>("bay4AutoAssign");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const s = loadSession();
    if (s) {
      setSession(s);
      const savedFid = localStorage.getItem(FACILITY_KEY);
      const fac =
        s.facilities.find((f) => f.id === savedFid) ??
        (s.defaultFacility
          ? s.facilities.find((f) => f.id === s.defaultFacility!.id)
          : null) ??
        s.facilities[0] ??
        null;
      setFacility(fac);
    }
    const savedTab = localStorage.getItem(TAB_KEY);
    if (savedTab) setActiveTab(savedTab);
    setHydrated(true);
  }, []);

  const onLogin = useCallback((s: Session) => {
    saveSession(s);
    setSession(s);
    const fac =
      s.facilities.find(
        (f) => f.id === s.defaultFacility?.id
      ) ??
      s.facilities[0] ??
      null;
    if (fac) {
      localStorage.setItem(FACILITY_KEY, fac.id);
      setFacility(fac);
    }
  }, []);

  const onLogout = useCallback(() => {
    clearSession();
    setSession(null);
    setFacility(null);
  }, []);

  const onChangeFacility = useCallback(
    (f: Facility) => {
      localStorage.setItem(FACILITY_KEY, f.id);
      setFacility(f);
    },
    []
  );

  const onChangeTab = useCallback((tab: string) => {
    localStorage.setItem(TAB_KEY, tab);
    setActiveTab(tab);
  }, []);

  if (!hydrated) {
    return (
      <div className="login-shell">
        <Loader2 className="spin" size={32} color="#6366f1" />
      </div>
    );
  }

  const displaySession: Session =
    session ??
    ({
      accessToken: "",
      refreshToken: "",
      expiresAt: Date.now() + 60 * 60 * 1000,
      identity: {
        user_id: "rjauregui",
        user_name: "Ruben",
        tenant_id: "LT",
      },
      facilities: [{ id: "LT_F1", name: "Valley View", timeZone: "America/Los_Angeles" }],
      defaultFacility: { id: "LT_F1", name: "Valley View" },
    } as Session);

  const displayFacility: Facility =
    facility ?? { id: "LT_F1", name: "Valley View", timeZone: "America/Los_Angeles" };

  return (
    <Dashboard
      session={displaySession}
      facility={displayFacility}
      activeTab={activeTab}
      onLogout={session ? onLogout : () => undefined}
      onChangeFacility={onChangeFacility}
      onChangeTab={onChangeTab}
    />
  );
}
