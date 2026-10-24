"use client";

import { useEffect, useState } from "react";
import { ArrowDownLeft, ArrowLeft, ArrowUpLeft, CarFront, Check, CircleDollarSign, Clock3, Copy, LogOut, Lock, Phone, ShieldCheck, Wallet } from "lucide-react";

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

type PaymentMethod = { id: string; label: string; details: string };
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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذرت قراءة صورة الوصل."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("تعذرت قراءة صورة الوصل."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export default function CaptainHome() {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [needsProfile, setNeedsProfile] = useState(false);
  const [fullName, setFullName] = useState("");
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [captainName, setCaptainName] = useState<string>("");

  useEffect(() => {
    const stored = window.localStorage.getItem("take-go-captain-token");
    if (stored) {
      setToken(stored);
      void loadDashboard(stored);
    } else {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch(`${API}/payment-methods`)
      .then((response) => (response.ok ? response.json() : []))
      .then((data: PaymentMethod[]) => setPaymentMethods(Array.isArray(data) ? data : []))
      .catch(() => setPaymentMethods([]));
  }, []);

  async function copyDetails(method: PaymentMethod) {
    try {
      await navigator.clipboard.writeText(method.details);
      setCopiedId(method.id);
      setTimeout(() => setCopiedId((current) => (current === method.id ? null : current)), 2000);
    } catch {
      setCopiedId(null);
    }
  }

  async function submitTopUp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = event.currentTarget;
    const formData = new FormData(form);
    const file = formData.get("receipt") as File | null;
    if (!file || file.size === 0) {
      setError("أرفق صورة وصل التحويل لإتمام الطلب.");
      setBusy(false);
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setError("أرفق صورة بصيغة JPG أو PNG أو WebP أو GIF.");
      setBusy(false);
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError("يجب ألا يتجاوز حجم صورة الوصل 4 ميغابايت.");
      setBusy(false);
      return;
    }
    try {
      const receipt = await readFileAsDataUrl(file);
      const result = await api<{ id: string; amountJod: number }>(
        "/captain/topup", token, { method: "POST", body: JSON.stringify({ amount: formData.get("amount"), receipt }) }
      );
      setNotice(`تم إرسال طلب شحن بمبلغ ${result.amountJod} د.أ مع صورة الوصل إلى الإدارة، وسيتم اعتماده بعد المراجعة.`);
      setTopUpOpen(false);
      form.reset();
      await loadDashboard(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر إنشاء طلب الشحن.");
    } finally {
      setBusy(false);
    }
  }

  async function loadDashboard(authToken: string) {
    setLoading(true);
    try {
      const me = await api<{ status: string; fullName: string | null }>("/captain/me", authToken);
      setCaptainName(me.fullName ?? "كابتن");
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
      <main className="auth-hero">
        <div className="auth-hero-inner">
          <div className="hero-logo">
            <span className="hero-logo-tg">T<span className="hero-logo-g">G</span><span className="hero-logo-pin">📍</span></span>
            <span className="hero-logo-name">Take<b>&amp;</b>go</span>
            <span className="hero-logo-tagline">معك في كل طريق</span>
          </div>
          <form className="auth-card-dark" onSubmit={login}>
            <span className="hero-captain-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="3.2" />
                <path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6" />
                <path d="M9.5 4.6C10 3.6 10.9 3 12 3s2 .6 2.5 1.6" />
                <path d="M8.5 5.5h7" />
              </svg>
            </span>
            <h2>تسجيل دخول الكابتن</h2>
            <p className="auth-card-dark-sub">أدخل بياناتك للدخول إلى حسابك</p>
            <label className="dark-field">
              <span className="dark-field-icon"><Phone size={17} /></span>
              <input name="phone" type="tel" autoComplete="tel" placeholder="تسجيل الدخول" required />
            </label>
            <label className="dark-field">
              <span className="dark-field-icon"><Lock size={17} /></span>
              <input name="password" type="password" autoComplete="current-password" placeholder="كلمة السر" required />
            </label>
            {error && <p className="error-message dark" role="alert">{error}</p>}
            <button className="hero-button" disabled={busy}>{busy ? "جارٍ الدخول..." : "دخول"} <ArrowLeft size={18} /></button>
          </form>
        </div>
        <footer className="hero-footer">Take &amp;go <span>·</span> معك في كل طريق</footer>
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
          <div><p className="eyebrow">ملخص حساب الكابتن</p><h1>{captainName || "كابتن"}</h1></div>
          <span className="today-date">{new Intl.DateTimeFormat("ar-JO", { dateStyle: "full" }).format(new Date())} <span>🇯🇴</span></span>
         </div>
        {error && <p className="error-message" role="alert">{error}</p>}
        {notice && <p className="success-message" role="status">{notice}</p>}
        <section className="balance-card">
          <div className="balance-copy"><span className="balance-icon"><Wallet size={22} /></span><span>رصيدك الحالي</span></div>
          <p className="balance-value">{money(dashboard?.balanceJod ?? 0)} <small>د.أ</small></p>
          <span className="balance-footnote">يتم تحديث الرصيد بعد اعتماد الطلبات</span>
          <div className="balance-decoration">T</div>
        </section>
        <button
          type="button"
          className="topup-button"
          aria-expanded={topUpOpen}
          aria-controls="topup-form"
          onClick={() => { setTopUpOpen((open) => !open); setNotice(""); }}
        >
          <CircleDollarSign size={18} /> {topUpOpen ? "إغلاق نموذج الشحن" : "شحن رصيد"}
        </button>
        {topUpOpen && (
          <form id="topup-form" className="topup-card" onSubmit={submitTopUp}>
            <strong>طلب شحن رصيد</strong>
            <span>أدخل المبلغ، حوّل المبلغ بإحدى طرق الدفع، ثم أرفق صورة الوصل لإرسال الطلب إلى لوحة الإدارة. صورة الوصل مطلوبة ولا يمكن إرسال الطلب بدونها (حد أقصى 4 ميغابايت).</span>
            <input name="amount" type="number" min="0.001" step="0.001" placeholder="مبلغ الشحن بالدينار" required />
            <input name="receipt" type="file" accept="image/jpeg,image/png,image/webp,image/gif" required />
            <button className="primary-button" disabled={busy}>{busy ? "جارٍ الإرسال..." : "إرسال طلب الشحن للإدارة"} <ArrowUpLeft size={18} /></button>
          </form>
        )}
        <section className="stat-grid" aria-label="إحصائيات الطلبات">
          <article className="stat-card"><span className="stat-icon blue"><CarFront size={21} /></span><span className="stat-label">الأوردرات المكتملة</span><strong>{dashboard?.statistics.orders ?? 0}</strong><small>كل 5 د.أ = أوردر واحد</small></article>
          <article className="stat-card"><span className="stat-icon green"><ArrowDownLeft size={21} /></span><span className="stat-label">الركاب المكتملون</span><strong>{dashboard?.statistics.riders ?? 0}</strong><small>كل 5 د.أ = راكب واحد</small></article>
        </section>
        <section className="ledger-section">
          <div className="section-heading"><div><p className="eyebrow">لشحن رصيدك</p><h2>طرق الدفع المتاحة</h2></div><span className="ledger-count">اضغط على الرقم لنسخه</span></div>
          <div className="ledger-list">
            {paymentMethods.map((method) => (
              <button type="button" className="ledger-row payment-row" key={method.id} onClick={() => void copyDetails(method)}>
                <span className={"ledger-icon credit"}><Wallet size={19} /></span>
                <div className="ledger-description"><strong>{method.label}</strong><span dir="ltr">{method.details}</span></div>
                <div className="ledger-amount">
                  {copiedId === method.id ? <strong className="positive"><Check size={16} /> تم النسخ</strong> : <strong><Copy size={16} /> نسخ</strong>}
                </div>
              </button>
            ))}
            {!paymentMethods.length && <div className="empty-state">لا توجد طرق دفع متاحة حالياً.</div>}
          </div>
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
