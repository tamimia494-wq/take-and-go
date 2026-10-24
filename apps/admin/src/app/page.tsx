"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpLeft, BadgeCheck, CircleDollarSign, KeyRound, LogOut, RefreshCw, Settings2, ShieldCheck, Trash2, UserRoundPlus, Users, Wallet } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const API = API_URL.endsWith("/api") ? API_URL : `${API_URL.replace(/\/$/, "")}/api`;

type Settings = { groupFloorJod: number; riderCommissionPerFiveJod: number; orderCommissionPerFiveJod: number };
type Captain = { id: string; phone: string; fullName: string | null; status: "ACTIVE" | "PENDING_PROFILE" | "SUSPENDED"; balanceJod: number; createdAt: string };
type Activity = { id: string; description: string; type: string; amountJod: number; createdAt: string; captain: { fullName: string | null; phone: string } };
type PaymentMethod = { id: string; label: string; details: string };
type TopUpRequest = { id: string; captainName: string; captainPhone: string; amountJod: number; hasReceipt: boolean; status: string; createdAt: string };
type Overview = { captainCount: number; activeCaptainCount: number; totalBalanceJod: number; settings: Settings; latestActivity: Activity[] };

async function api<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "تعذر إكمال الطلب.");
  return data as T;
}

export default function AdminHome() {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [captains, setCaptains] = useState<Captain[]>([]);
  const [settings, setSettings] = useState<Settings>({ groupFloorJod: 0, riderCommissionPerFiveJod: 0.75, orderCommissionPerFiveJod: 1 });
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustAction, setAdjustAction] = useState<"credit" | "debit">("credit");
  const [adjustCaptain, setAdjustCaptain] = useState<Captain | null>(null);
  const [query, setQuery] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [topUps, setTopUps] = useState<TopUpRequest[]>([]);
  const [receiptPreview, setReceiptPreview] = useState<{ id: string; url: string } | null>(null);

  const refresh = useCallback(async (authToken: string) => {
    const [home, list, methods, topUpList] = await Promise.all([
      api<Overview>("/admin/dashboard", authToken),
      api<Captain[]>("/admin/captains", authToken),
      api<PaymentMethod[]>("/payment-methods", ""),
      api<TopUpRequest[]>("/admin/topups", authToken)
    ]);
    setOverview(home);
    setSettings(home.settings);
    setCaptains(list);
    setPaymentMethods(methods);
    setTopUps(topUpList);
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem("take-go-admin-token");
    if (stored) {
      setToken(stored);
      void refresh(stored).catch((reason: unknown) => {
        window.localStorage.removeItem("take-go-admin-token");
        setToken("");
        setError(reason instanceof Error ? reason.message : "تعذر تحميل لوحة الإدارة.");
      }).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (!token) return;
    const interval = window.setInterval(() => {
      void api<TopUpRequest[]>("/admin/topups", token)
        .then(setTopUps)
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "تعذر تحديث طلبات الشحن."));
    }, 15000);
    return () => window.clearInterval(interval);
  }, [token]);

  useEffect(() => () => {
    if (receiptPreview) URL.revokeObjectURL(receiptPreview.url);
  }, [receiptPreview]);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const response = await fetch(`${API}/auth/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: form.get("password") }),
        signal: controller.signal
      }).finally(() => clearTimeout(timeout));
      let data: { error?: string; token?: string } = {};
      try { data = await response.json(); } catch { /* رد غير JSON */ }
      if (!response.ok) throw new Error(data.error ?? `خطأ من الخادم (HTTP ${response.status}).`);
      if (!data.token) throw new Error("رد غير متوقع من الخادم.");
      window.localStorage.setItem("take-go-admin-token", data.token);
      setToken(data.token);
      await refresh(data.token);
    } catch (reason) {
      if (reason instanceof TypeError) {
        setError(reason.name === "AbortError" || (reason instanceof DOMException)
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

  async function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/admin/settings", token, { method: "PUT", body: JSON.stringify(settings) });
      setNotice("تم حفظ إعدادات الرسوم.");
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر حفظ الإعدادات.");
    } finally {
      setBusy(false);
    }
  }

  async function diagnose() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<Record<string, unknown>>("/admin/green-api/diagnose", token);
      const lines: string[] = [];
      if (result.configured !== true) lines.push("⚠️ متغيرات Green API غير مضبوطة على الخادم.");
      if (typeof result.instanceState === "string") {
        lines.push(result.authorized === true
          ? "✅ الـ Instance متصل بالواتساب."
          : `❌ الـ Instance غير مرتبط بالواتساب (الحالة: ${result.instanceState}). امسح QR من لوحة Green API.`);
      }
      if (result.instanceError) lines.push(`❌ فشل الوصول للـ Instance: ${String(result.instanceError)}`);
      if (typeof result.instancePhone === "string" && result.instancePhone) lines.push(`📱 رقم الـ Instance: ${result.instancePhone}`);
      if (result.groupFound === true) lines.push(`✅ الجروب موجود وعدد المشاركين: ${String(result.participantCount)}.`);
      if (result.groupError) lines.push(`❌ فشل قراءة الجروب: ${String(result.groupError)} — تأكد من GREEN_API_GROUP_ID.`);
      setNotice(lines.join(" | ") || JSON.stringify(result));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تشخيص الاتصال.");
    } finally {
      setBusy(false);
    }
  }

  async function importCaptains() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
    const result = await api<{ imported: number; total: number; skipped?: string[] }>("/admin/captains/import", token, { method: "POST" });
    const skipped = result.skipped?.length ? ` (تم استثناء أرقام الإدارة: ${result.skipped.join(", ")})` : "";
    setNotice(`تمت إضافة ${result.imported} كابتن جديد من أصل ${result.total} مشارك${skipped}. كلمة المرور المؤقتة: 123456`);
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذرت مزامنة المشاركين.");
    } finally {
      setBusy(false);
    }
  }

  function lookupPhone(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setAdjustCaptain(null);
    const form = new FormData(event.currentTarget);
    const raw = String(form.get("phone") ?? "").replace(/\D/g, "");
    const last9 = raw.slice(-9);
    const found = captains.find((captain) => captain.phone.replace(/\D/g, "").endsWith(last9) && last9.length >= 9);
    if (!found) {
      setError("لا يوجد كابتن بهذا الرقم. تأكد من الرقم أو اعمل مزامنة للمجموعة أولاً.");
      return;
    }
    setAdjustCaptain(found);
  }

  async function adjustBalance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adjustCaptain) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ fullName: string | null; phone: string; balanceJod: number }>("/admin/captains/adjust", token, {
        method: "POST",
        body: JSON.stringify({
          phone: adjustCaptain.phone,
          amount: form.get("amount"),
          action: adjustAction,
          description: adjustAction === "credit" ? "شحن رصيد" : "خصم رصيد"
        })
      });
      setNotice(`${adjustAction === "credit" ? "تم شحن" : "تم خصم"} ${money(Number(form.get("amount")))} د.أ ${adjustAction === "credit" ? "على" : "من"} حساب ${result.fullName ?? result.phone}. الرصيد الجديد: ${money(result.balanceJod)} د.أ`);
      setAdjustCaptain(null);
      setAdjustOpen(false);
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تنفيذ العملية.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(captain: Captain) {
    setBusy(true);
    setError("");
    try {
      const status = captain.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED";
      await api(`/admin/captains/${captain.id}/status`, token, { method: "PATCH", body: JSON.stringify({ status }) });
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تحديث حالة الحساب.");
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setError("");
    setNotice("");
    const form = new FormData(formElement);
    try {
      await api("/admin/password", token, {
        method: "POST",
        body: JSON.stringify({ currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") })
      });
      setNotice("تم تغيير كلمة مرور الإدارة بنجاح.");
      formElement.reset();
      setShowPassword(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تغيير كلمة المرور.");
    } finally {
      setBusy(false);
    }
  }

  async function reviewTopUp(id: string, approve: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(`/admin/topups/${id}/${approve ? "approve" : "reject"}`, token, { method: "POST" });
      setNotice(approve ? "تم اعتماد طلب الشحن وشحن الرصيد." : "تم رفض طلب الشحن.");
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر معالجة الطلب.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleReceipt(id: string) {
    if (receiptPreview?.id === id) {
      setReceiptPreview(null);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/admin/topups/${id}/receipt`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? "تعذر تحميل صورة الوصل.");
      }
      const url = URL.createObjectURL(await response.blob());
      setReceiptPreview({ id, url });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تحميل صورة الوصل.");
    } finally {
      setBusy(false);
    }
  }

  async function addPaymentMethod(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setError("");
    setNotice("");
    const form = new FormData(formElement);
    try {
      await api("/admin/payment-methods", token, {
        method: "POST",
        body: JSON.stringify({ label: form.get("label"), details: form.get("details") })
      });
      setNotice("تمت إضافة طريقة الدفع.");
      formElement.reset();
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذرت إضافة طريقة الدفع.");
    } finally {
      setBusy(false);
    }
  }

  async function removePaymentMethod(id: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/admin/payment-methods/${id}`, token, { method: "DELETE" });
      setNotice("تم حذف طريقة الدفع.");
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر حذف طريقة الدفع.");
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    window.localStorage.removeItem("take-go-admin-token");
    setToken("");
    setOverview(null);
    setCaptains([]);
  }

  if (loading) return <main className="loading"><span className="spinner" /> جارٍ تحميل لوحة الإدارة...</main>;
  if (!token) {
    return (
      <main className="admin-auth">
        <section className="admin-auth-art">
          <a className="brand" href="#"><span className="brand-icon">T<span>↗</span></span><span>Take <b>&amp;</b> Go</span></a>
          <span className="flag">🇯🇴</span>
          <div><p>إدارة آمنة وموحدة</p><h1>لوحة تحكم الإدارة</h1><span>منصة Take &amp; Go لإدارة الكباتن والطلبات</span></div>
        </section>
        <section className="admin-auth-side">
          <form className="login-card" onSubmit={login}>
            <span className="login-icon"><ShieldCheck size={22} /></span>
            <p className="eyebrow">منطقة الإدارة</p><h2>تسجيل الدخول</h2><p className="muted">سجّل دخولك باستخدام حساب الإدارة</p>
            <label>كلمة المرور<input name="password" type="password" autoComplete="current-password" placeholder="كلمة المرور" required /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="button primary" disabled={busy}>{busy ? "جارٍ الدخول..." : "دخول لوحة الإدارة"}</button>
            <span className="secure-caption"><ShieldCheck size={15} /> دخول مشفر وآمن</span>
          </form>
        </section>
      </main>
    );
  }

  const visibleCaptains = captains.filter((captain) => {
    const value = `${captain.fullName ?? ""} ${captain.phone}`.toLowerCase();
    return value.includes(query.trim().toLowerCase());
  });

  return (
    <main className="admin-shell">
      <header className="admin-topbar">
        <a className="brand" href="#"><span className="brand-icon">T<span>↗</span></span><span>Take <b>&amp;</b> Go</span></a>
        <div className="admin-label"><span className="live-dot" /> نظام الإدارة</div>
        <button className="button ghost" onClick={logout}><LogOut size={16} /> خروج</button>
      </header>
      <div className="admin-main">
        <div className="heading">
          <div><p className="eyebrow">مساحة العمل</p><h1>مرحباً بك في لوحة الإدارة</h1><p className="muted">إدارة الكباتن والأرصدة والرسوم من مكان واحد.</p></div>
          <div className="heading-actions">
            <button className="button ghost refresh" onClick={() => void refresh(token)}><RefreshCw size={16} /> تحديث البيانات</button>
            <button className="button ghost" onClick={() => setShowPassword((value) => !value)}><KeyRound size={16} /> تغيير كلمة المرور</button>
          </div>
        </div>
        {showPassword && (
          <form className="panel password-panel" onSubmit={changePassword}>
            <div className="panel-heading compact"><span className="panel-icon"><KeyRound size={19} /></span><div><h2>تغيير كلمة مرور الإدارة</h2><p>أدخل كلمة المرور الحالية ثم كلمة المرور الجديدة</p></div></div>
            <div className="password-fields">
              <input name="currentPassword" type="password" placeholder="كلمة المرور الحالية" autoComplete="current-password" required />
              <input name="newPassword" type="password" placeholder="كلمة المرور الجديدة (6 أحرف على الأقل)" autoComplete="new-password" minLength={6} required />
            </div>
            <button className="button primary" disabled={busy}><ShieldCheck size={16} /> تأكيد التغيير</button>
          </form>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <section className="metric-grid">
          <Metric icon={<Users size={20} />} label="إجمالي الكباتن" value={overview?.captainCount ?? 0} color="blue" detail={`${overview?.activeCaptainCount ?? 0} حساب مفعل`} />
          <Metric icon={<CircleDollarSign size={20} />} label="شحن رصيد للكابتن" value="فتح النموذج" color="violet" detail="حسب رقم الهاتف" onClick={() => { setAdjustOpen(true); setAdjustCaptain(null); }} />
          <Metric icon={<BadgeCheck size={20} />} label="حالة التكامل" value="Green API" color="green" detail="ربط مجموعة واتساب" />
        </section>
        <section className="admin-grid">
          <article className="panel settings-panel">
            <div className="panel-heading"><span className="panel-icon"><Settings2 size={19} /></span><div><h2>إعدادات الرسوم</h2><p>العمولات التي تخصم تلقائياً على كل خمس وحدات</p></div></div>
            <form onSubmit={saveSettings}>
              <MoneyInput label="أرضية الجروب الأسبوعية" value={settings.groupFloorJod} onChange={(value) => setSettings({ ...settings, groupFloorJod: value })} />
              <div className="settings-row">
                <MoneyInput label="عمولة الراكب / لكل 5" value={settings.riderCommissionPerFiveJod} onChange={(value) => setSettings({ ...settings, riderCommissionPerFiveJod: value })} />
                <MoneyInput label="عمولة الأوردر / لكل 5" value={settings.orderCommissionPerFiveJod} onChange={(value) => setSettings({ ...settings, orderCommissionPerFiveJod: value })} />
              </div>
              <button className="button primary" disabled={busy}>حفظ الإعدادات</button>
              <p className="hint">تُخصم أرضية الجروب كل خميس الساعة 11:59 مساءً بتوقيت عمّان.</p>
            </form>
          </article>
          <article className="panel import-panel">
            <div className="panel-heading"><span className="panel-icon blue"><UserRoundPlus size={19} /></span><div><h2>إضافة الكباتن</h2><p>استيراد المشاركين من مجموعة Green API المحددة</p></div></div>
            <div className="import-visual"><div className="avatar-stack"><span>ك</span><span>ر</span><span>م</span><b>+</b></div><span>إضافة آمنة للمجموعة المحددة <span className="flag-small">🇯🇴</span></span></div>
            <button className="button ghost full" disabled={busy} onClick={() => void diagnose()}><BadgeCheck size={17} /> فحص اتصال Green API</button>
            <button className="button primary full" disabled={busy} onClick={() => void importCaptains()}><UserRoundPlus size={17} /> {busy ? "جارٍ الاستيراد..." : "مزامنة أعضاء المجموعة"}</button>
            <p className="hint">الحسابات الجديدة تبدأ بكلمة مرور مؤقتة <bdi>123456</bdi> ورصيد صفر، وتحتاج إدخال الاسم عند أول دخول.</p>
          </article>
        </section>
        <section className="panel captains-panel">
          <div className="list-heading"><div className="panel-heading compact"><span className="panel-icon"><Users size={19} /></span><div><h2>إدارة الكباتن</h2><p>{captains.length} حساب مسجل</p></div></div><input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="بحث بالاسم أو الهاتف" /></div>
          {adjustOpen && (
            <div className="credit-form">
              {!adjustCaptain ? (
                <form onSubmit={lookupPhone}>
                  <div><strong>شحن/خصم رصيد</strong><span>أدخل رقم كابتن لعرض حسابه</span></div>
                  <input name="phone" type="tel" dir="ltr" placeholder="رقم الهاتف (مثال: 079xxxxxxx)" required />
                  <button className="button primary" disabled={busy}>بحث</button>
                  <button type="button" className="button ghost" onClick={() => setAdjustOpen(false)}>إلغاء</button>
                </form>
              ) : (
                <form onSubmit={adjustBalance}>
                  <div><strong>{adjustCaptain.fullName ?? "بانتظار تفعيل الحساب"} · {adjustCaptain.phone}</strong><span>الرصيد الحالي: {money(adjustCaptain.balanceJod)} د.أ</span></div>
                  <div className="adjust-toggle">
                    <button type="button" className={adjustAction === "credit" ? "button small credit" : "button small ghost"} onClick={() => setAdjustAction("credit")}><CircleDollarSign size={14} /> شحن</button>
                    <button type="button" className={adjustAction === "debit" ? "button small debit" : "button small ghost"} onClick={() => setAdjustAction("debit")}><ArrowUpLeft size={14} /> خصم</button>
                  </div>
                  <input name="amount" type="number" min="0.001" step="0.001" placeholder={adjustAction === "credit" ? "قيمة الشحن بالدينار" : "قيمة الخصم بالدينار"} required />
                  <button className="button primary" disabled={busy}><CircleDollarSign size={16} /> {adjustAction === "credit" ? "اعتماد الشحن" : "اعتماد الخصم"}</button>
                  <button type="button" className="button ghost" onClick={() => setAdjustCaptain(null)}>رجوع</button>
                </form>
              )}
            </div>
          )}
          <div className="table-wrap">
            <table><thead><tr><th>الكابتن</th><th>رقم الهاتف</th><th>الرصيد</th><th>الحالة</th><th>إجراءات</th></tr></thead>
              <tbody>{visibleCaptains.map((captain) => (
                <tr key={captain.id}>
                  <td data-label="الكابتن"><span className="captain-avatar">{(captain.fullName ?? "؟").slice(0, 1)}</span><strong>{captain.fullName ?? "بانتظار تفعيل الحساب"}</strong></td>
                  <td data-label="رقم الهاتف" dir="ltr">{captain.phone}</td>
                  <td data-label="الرصيد" className="money-cell">{money(captain.balanceJod)} د.أ</td>
                  <td data-label="الحالة"><span className={`status-pill ${captain.status.toLowerCase()}`}>{statusLabel(captain.status)}</span></td>
                  <td data-label="إجراءات"><div className="row-actions"><button className="button small credit" onClick={() => { setAdjustOpen(true); setAdjustAction("credit"); setAdjustCaptain(captain); }}><CircleDollarSign size={14} /> شحن</button><button className="button small ghost" disabled={busy} onClick={() => void toggleStatus(captain)}>{captain.status === "SUSPENDED" ? "تفعيل" : "إيقاف"}</button></div></td>
                </tr>
              ))}</tbody>
            </table>
            {!visibleCaptains.length && <div className="empty">لا يوجد كباتن مطابقون للبحث.</div>}
          </div>
        </section>
        <section className="panel activity-panel">
          <div className="panel-heading compact"><span className="panel-icon"><ArrowDownLeft size={19} /></span><div><h2>آخر الحركات المالية</h2><p>سجل الشحنات والخصومات المعتمدة</p></div></div>
          <div className="activity-list">{overview?.latestActivity.map((entry) => (
            <article key={entry.id} className="activity-row"><span className={`activity-symbol ${entry.amountJod >= 0 ? "in" : "out"}`}>{entry.amountJod >= 0 ? <ArrowDownLeft size={17} /> : <ArrowUpLeft size={17} />}</span><div className="activity-copy"><strong>{entry.description}</strong><span>{entry.captain.fullName ?? entry.captain.phone} · {new Intl.DateTimeFormat("ar-JO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt))}</span></div><b className={entry.amountJod >= 0 ? "positive" : "negative"}>{entry.amountJod > 0 ? "+" : ""}{money(entry.amountJod)} د.أ</b></article>
          ))}{!overview?.latestActivity.length && <div className="empty">لا توجد حركات مسجلة بعد.</div>}</div>
        </section>
      </div>
      <section className="panel activity-panel">
        <div className="panel-heading compact"><span className="panel-icon violet"><Wallet size={19} /></span><div><h2>طلبات شحن الرصيد</h2><p>طلبات الكباتن الواردة من التطبيق</p></div></div>
        <div className="topup-admin-list">
          {topUps.map((request) => (
            <article key={request.id} className="topup-admin-row">
              <div><strong>{request.captainName} · <span dir="ltr">{request.captainPhone}</span></strong><span>مبلغ {money(request.amountJod)} د.أ · {new Intl.DateTimeFormat("ar-JO", { dateStyle: "short", timeStyle: "short" }).format(new Date(request.createdAt))}</span></div>
              <div className="row-actions">
                {request.hasReceipt ? (
                  <button className="button small ghost" disabled={busy} onClick={() => void toggleReceipt(request.id)}>
                    {receiptPreview?.id === request.id ? "إخفاء الوصل" : "عرض الوصل"}
                  </button>
                ) : <span className="status-pill suspended">لا يوجد وصل</span>}
                {request.status === "PENDING" ? (
                  <>
                    <button className="button small credit" disabled={busy || !request.hasReceipt} onClick={() => void reviewTopUp(request.id, true)}>اعتماد</button>
                    <button className="button small debit" disabled={busy} onClick={() => void reviewTopUp(request.id, false)}>رفض</button>
                  </>
                ) : <span className={`status-pill ${request.status === "APPROVED" ? "active" : "suspended"}`}>{request.status === "APPROVED" ? "معتمد" : "مرفوض"}</span>}
              </div>
              {receiptPreview?.id === request.id && <img className="topup-receipt-preview" src={receiptPreview.url} alt={`وصل الشحن للكابتن ${request.captainName}`} />}
            </article>
          ))}
          {!topUps.length && <div className="empty">لا توجد طلبات شحن بعد.</div>}
        </div>
      </section>
      <section className="panel activity-panel">
        <div className="panel-heading compact"><span className="panel-icon"><Wallet size={19} /></span><div><h2>طرق الدفع</h2><p>أضف أرقام الحسابات التي تظهر للكباتن</p></div></div>
        <form className="payment-method-form" onSubmit={addPaymentMethod}>
          <input name="label" type="text" maxLength={60} placeholder="اسم البنك أو المحفظة (مثال: زين كاش)" required />
          <input name="details" type="text" dir="ltr" maxLength={120} placeholder="رقم الحساب / الهاتف / المعلومات" required />
          <button className="button primary" disabled={busy}><Wallet size={16} /> إضافة</button>
        </form>
        <div className="payment-method-list">
          {paymentMethods.map((method) => (
            <article key={method.id} className="payment-method-row">
              <div><strong>{method.label}</strong><span dir="ltr">{method.details}</span></div>
              <button className="button small ghost" disabled={busy} onClick={() => void removePaymentMethod(method.id)}><Trash2 size={14} /> حذف</button>
            </article>
          ))}
          {!paymentMethods.length && <div className="empty">لا توجد طرق دفع مضافة بعد.</div>}
        </div>
      </section>
      <footer className="admin-footer">Take &amp; Go <span>·</span> لوحة إدارة آمنة<div className="footer-credit">تم تطويره بواسطة <b>Hamza rajeh</b> · <a href="tel:0790905611" dir="ltr">0790905611</a></div></footer>
    </main>
  );
}

function Metric({ icon, label, value, color, detail, onClick }: { icon: React.ReactNode; label: string; value: string | number; color: string; detail: string; onClick?: () => void }) {
  return <article className={onClick ? "metric-card clickable" : "metric-card"} onClick={onClick} role={onClick ? "button" : undefined}><span className={`metric-icon ${color}`}>{icon}</span><span className="metric-label">{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function MoneyInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="money-input">{label}<span><input type="number" min="0" step="0.001" value={value} onChange={(event) => onChange(Number(event.target.value))} /><b>د.أ</b></span></label>;
}

function money(value: number): string {
  return new Intl.NumberFormat("ar-JO", { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(value);
}

function statusLabel(status: Captain["status"]): string {
  if (status === "ACTIVE") return "مفعل";
  if (status === "SUSPENDED") return "موقوف";
  return "بانتظار الاسم";
}
