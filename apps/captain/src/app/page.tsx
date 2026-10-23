"use client";

import { useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpLeft, CarFront, Clock3, LogOut, ShieldCheck, Wallet } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const API = API_URL.endsWith("/api") ? API_URL : `${API_URL.replace(/\/$/, "")}/api`;

type LedgerEntry = {
  id: string;
  type: string;
  description: string;
  amountJod: number;
  balanceAfterJod: number;
  createdAt: string;
};

type Dashboard = {
  balanceJod: number;
  statistics: { orders: number; riders: number; orderUnits: number; riderUnits: number };
  ledger: LedgerEntry[];
};

async function api<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "تعذر إكمال الطلب.");
  return data as T;
}

export default function CaptainHome() {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [needsProfile, setNeedsProfile] = useState(false);
  const [fullName, setFullName] = useState("");

  useEffect(() => {
    const stored = window.localStorage.getItem("take-go-captain-token");
    if (stored) {
      setToken(stored);
      void loadDashboard(stored);
    } else {
      setLoading(false);
    }
  }, []);

  async function loadDashboard(authToken: string) {
    setLoading(true);
    try {
      const me = await api<{ status: string; fullName: string | null }>("/captain/me", authToken);
      if (me.status === "PENDING_PROFILE") {
        setNeedsProfile(true);
        return;
      }
      setDashboard(await api<Dashboard>("/captain/dashboard", authToken));
      setNeedsProfile(false);
    } catch (reason) {
      window.localStorage.removeItem("take-go-captain-token");
      setToken("");
      setError(reason instanceof Error ? reason.message : "تعذر تحميل البيانات.");
    } finally {
      setLoading(false);
    }
  }

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const response = await fetch(`${API}/auth/captain/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: form.get("phone"), password: form.get("password") }),
        signal: controller.signal
      }).finally(() => clearTimeout(timeout));
      let data: { error?: string; token?: string; needsProfile?: boolean } = {};
      try { data = await response.json(); } catch { /* رد غير JSON */ }
      if (!response.ok) throw new Error(data.error ?? `خطأ من الخادم (HTTP ${response.status}).`);
      if (!data.token) throw new Error("رد غير متوقع من الخادم.");
      window.localStorage.setItem("take-go-captain-token", data.token);
      setToken(data.token);
      setNeedsProfile(Boolean(data.needsProfile));
      if (!data.needsProfile) await loadDashboard(data.token);
    } catch (reason) {
      if (reason instanceof TypeError) {
        setError((reason as Error).name === "AbortError"
          ? "انتهت مهلة الاتصال بالخادم. الـ API قد يكون نائماً أو غير متاح — أعد المحاولة بعد دقيقة."
          : "تعذر الاتصال بالخادم. تأكد أن الـ API يعمل (قد يكون نائماً على الخطة المجانية — أعد المحاولة بعد دقيقة).");
      } else {
        setError(reason instanceof Error ? reason.message : "تعذر تسجيل الدخول.");
      }
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }

  async function activate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/captain/activate", token, {
        method: "POST",
        body: JSON.stringify({ fullName })
      });
      await loadDashboard(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تفعيل الحساب.");
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    window.localStorage.removeItem("take-go-captain-token");
    setToken("");
    setDashboard(null);
    setNeedsProfile(false);
  }

  if (loading) return <main className="loading-screen"><span className="spinner" /> جارٍ تحميل حسابك...</main>;
  if (!token) {
    return (
      <main className="auth-layout">
        <section className="brand-panel">
          <a className="brand" href="#" aria-label="Take & Go">
            <span className="brand-mark">T<span>↗</span></span>
            <span className="brand-name">Take <b>&amp;</b> Go</span>
            <span className="brand-tagline">رحلتك .. علينا</span>
          </a>
          <div className="welcome-copy">
            <span className="jordan-flag">🇯🇴</span>
            <p>مرحباً بك في</p>
            <h1>Take &amp; Go</h1>
            <span>سجّل دخولك لمتابعة رصيدك وطلباتك</span>
          </div>
          <div className="road-glow" />
        </section>
        <section className="auth-side">
          <form className="auth-card" onSubmit={login}>
            <BrandSmall />
            <p className="eyebrow">بوابة الكابتن</p>
            <h2>تسجيل الدخول</h2>
            <p className="muted">تابع رصيدك وطلباتك من مكان واحد</p>
            <label>رقم الهاتف<input name="phone" type="tel" autoComplete="tel" placeholder="07XXXXXXXX" required /></label>
            <label>كلمة المرور<input name="password" type="password" autoComplete="current-password" placeholder="كلمة المرور" required /></label>
            {error && <p className="error-message" role="alert">{error}</p>}
            <button className="primary-button" disabled={busy}>{busy ? "جارٍ الدخول..." : "تسجيل الدخول"} <ArrowUpLeft size={18} /></button>
            <div className="security-note"><ShieldCheck size={17} /> حسابك وبياناتك محفوظة بأمان</div>
          </form>
        </section>
      </main>
    );
  }

  if (needsProfile) {
    return (
      <main className="profile-screen">
        <form className="profile-card" onSubmit={activate}>
          <BrandSmall />
          <span className="jordan-flag">🇯🇴</span>
          <h1>أهلاً بك في Take &amp; Go</h1>
          <p className="muted">أدخل اسمك الكامل لتفعيل حساب الكابتن.</p>
          <label>الاسم الكامل<input value={fullName} onChange={(event) => setFullName(event.target.value)} minLength={3} required /></label>
          {error && <p className="error-message" role="alert">{error}</p>}
          <button className="primary-button" disabled={busy}>{busy ? "جارٍ التفعيل..." : "تفعيل الحساب"} <ArrowUpLeft size={18} /></button>
        </form>
      </main>
    );
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <BrandSmall />
        <div className="topbar-caption"><span className="online-dot" /> لوحة الكابتن</div>
        <button className="logout-button" onClick={logout}><LogOut size={17} /> خروج</button>
      </header>
      <section className="dashboard-content">
        <div className="page-heading">
          <div><p className="eyebrow">مساء الخير، كابتن</p><h1>ملخص حسابك</h1></div>
          <span className="today-date">{new Intl.DateTimeFormat("ar-JO", { dateStyle: "full" }).format(new Date())} <span>🇯🇴</span></span>
        </div>
        {error && <p className="error-message" role="alert">{error}</p>}
        <section className="balance-card">
          <div className="balance-copy"><span className="balance-icon"><Wallet size={22} /></span><span>رصيدك الحالي</span></div>
          <p className="balance-value">{money(dashboard?.balanceJod ?? 0)} <small>د.أ</small></p>
          <span className="balance-footnote">يتم تحديث الرصيد بعد اعتماد الطلبات</span>
          <div className="balance-decoration">T</div>
        </section>
        <section className="stat-grid" aria-label="إحصائيات الطلبات">
          <article className="stat-card"><span className="stat-icon blue"><CarFront size={21} /></span><span className="stat-label">الأوردرات المكتملة</span><strong>{dashboard?.statistics.orders ?? 0}</strong><small>{dashboard?.statistics.orderUnits ?? 0} وحدة</small></article>
          <article className="stat-card"><span className="stat-icon green"><ArrowDownLeft size={21} /></span><span className="stat-label">الركاب المكتملون</span><strong>{dashboard?.statistics.riders ?? 0}</strong><small>{dashboard?.statistics.riderUnits ?? 0} وحدة</small></article>
        </section>
        <section className="ledger-section">
          <div className="section-heading"><div><p className="eyebrow">آخر الحركات</p><h2>سجل الجرد والخصومات</h2></div><span className="ledger-count">{dashboard?.ledger.length ?? 0} حركة</span></div>
          <div className="ledger-list">
            {dashboard?.ledger.length ? dashboard.ledger.map((entry) => (
              <article className="ledger-row" key={entry.id}>
                <span className={`ledger-icon ${entry.amountJod >= 0 ? "credit" : "debit"}`}>
                  {entry.amountJod >= 0 ? <ArrowDownLeft size={19} /> : <ArrowUpLeft size={19} />}
                </span>
                <div className="ledger-description"><strong>{entry.description}</strong><span><Clock3 size={13} /> {new Intl.DateTimeFormat("ar-JO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt))}</span></div>
                <div className="ledger-amount"><strong className={entry.amountJod >= 0 ? "positive" : ""}>{entry.amountJod > 0 ? "+" : ""}{money(entry.amountJod)} د.أ</strong><small>الرصيد {money(entry.balanceAfterJod)} د.أ</small></div>
              </article>
            )) : <div className="empty-state">لا توجد حركات مالية حتى الآن.</div>}
          </div>
        </section>
      </section>
      <footer className="footer">Take &amp; Go <span>·</span> رحلتك .. علينا</footer>
    </main>
  );
}

function BrandSmall() {
  return <a className="brand brand-small" href="#" aria-label="Take & Go"><span className="brand-mark">T<span>↗</span></span><span className="brand-name">Take <b>&amp;</b> Go</span></a>;
}

function money(value: number): string {
  return new Intl.NumberFormat("ar-JO", { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(value);
}
