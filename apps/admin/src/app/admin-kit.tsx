"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";

// Shared pieces for the admin's extra pages (captain management, commission transfer).

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const API = API_URL.endsWith("/api") ? API_URL : `${API_URL.replace(/\/$/, "")}/api`;

export type Captain = {
  id: string;
  phone: string;
  fullName: string | null;
  status: "ACTIVE" | "PENDING_PROFILE" | "SUSPENDED";
  balanceJod: number;
  accountType: "PRODUCER" | "CONSUMER" | null;
  createdAt: string;
};

export function accountTypeLabel(type: Captain["accountType"]): string {
  if (type === "PRODUCER") return "منتج";
  if (type === "CONSUMER") return "مستهلك";
  return "غير محدد";
}

export async function api<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(options.headers ?? {}) }
  });
  const text = await response.text();
  let result: { error?: string } & Record<string, unknown>;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`تعذر قراءة رد الخادم (${response.status}).`);
  }
  if (!response.ok) throw new Error(result.error ?? `تعذر إكمال الطلب (${response.status}).`);
  return result as T;
}

export function money(value: number): string {
  return new Intl.NumberFormat("ar-JO", { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(value);
}

export function statusLabel(status: Captain["status"]): string {
  if (status === "ACTIVE") return "مفعل";
  if (status === "SUSPENDED") return "موقوف";
  return "بانتظار الاسم";
}

/** Matches a captain by name or phone; a phone typed as 079... also matches the stored 96279... */
export function matchesCaptain(captain: Captain, query: string): boolean {
  const text = query.trim();
  if (!text) return true;
  const digits = text.replace(/\D/g, "").replace(/^0/, "");
  return (captain.fullName ?? "").includes(text) || (digits.length > 0 && captain.phone.includes(digits));
}

/** The admin session saved by the main dashboard, or null when nobody is logged in. */
export function useAdminToken(): { token: string; missing: boolean } {
  const [token, setToken] = useState("");
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem("take-go-admin-token");
    } catch {
      stored = null;
    }
    if (stored) setToken(stored);
    else setMissing(true);
  }, []);
  return { token, missing };
}

export function AdminFrame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="admin-shell" dir="rtl">
      <header className="admin-topbar">
        <a className="brand" href="/"><span className="brand-icon">T<span>↗</span></span><span>Take <b>&amp;</b> Go</span></a>
        <div className="admin-label"><span className="live-dot" /> نظام الإدارة</div>
        <a className="button ghost" href="/"><ArrowRight size={16} /> لوحة الإدارة</a>
      </header>
      <div className="admin-main">
        <div className="heading">
          <div><p className="eyebrow">غرفة الإدارة</p><h1>{title}</h1><p className="muted">{subtitle}</p></div>
        </div>
        {children}
      </div>
    </main>
  );
}

export function LoginRequired() {
  return (
    <AdminFrame title="سجّل الدخول أولاً" subtitle="هذه الصفحة تحتاج جلسة إدارة.">
      <a className="button primary" href="/">الذهاب لتسجيل الدخول</a>
    </AdminFrame>
  );
}
