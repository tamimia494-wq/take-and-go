"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AllStatementsSheet, CaptainStatementSheet, CloseStatementButton, NetProfitSheet, dateInputStyle, dateLabelStyle, defaultPeriod, downloadPdf, hasActivity, type CaptainWithStatement, type StatementTotals } from "./statement";
import { amountInput, blankZero } from "./amount";
import { ArrowDownLeft, ArrowUpLeft, BadgeCheck, CircleDollarSign, KeyRound, LogOut, RefreshCw, Settings2, ShieldCheck, Trash2, UserRoundPlus, Users, Wallet } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const API = API_URL.endsWith("/api") ? API_URL : `${API_URL.replace(/\/$/, "")}/api`;

type Settings = { groupFloorJod: number; riderCommissionPerFiveJod: number; orderCommissionPerFiveJod: number };
type Captain = { id: string; phone: string; fullName: string | null; status: "ACTIVE" | "PENDING_PROFILE" | "SUSPENDED"; balanceJod: number; createdAt: string };
type Activity = { id: string; description: string; type: string; amountJod: number; createdAt: string; captain: { fullName: string | null; phone: string } };
type PaymentMethod = { id: string; label: string; details: string };
type WithdrawalRequest = { id: string; captainName: string; captainPhone: string; amountJod: number; balanceJod: number; payoutAccount: string | null; createdAt: string };
type TopUpRequest = { id: string; captainName: string; captainPhone: string; amountJod: number; hasReceipt: boolean; status: string; createdAt: string };
type CaptainAccountRequest = { id: string; fullName: string; phone: string; createdAt: string };
type PhoneLookup = {
  phone: string;
  captain: { id: string; fullName: string | null; status: string; balanceJod: number; createdAt: string; updatedAt: string } | null;
  auditLog: Array<{
    id: string;
    action: string;
    oldStatus: string | null;
    newStatus: string | null;
    fullName: string | null;
    details: { oldPhone?: string; oldFullName?: string | null; passwordChanged?: boolean } | null;
    snapshot: { balanceFils?: number; amountFils?: number; description?: string; createdAt?: string } | null;
    dbUser: string | null;
    applicationName: string | null;
    createdAt: string;
  }>;
  accountRequests: Array<{ id: string; fullName: string; status: string; createdAt: string; reviewedAt: string | null }>;
  ledger: { count: number; firstAt: string | null; latest: Array<{ id: string; description: string; amountJod: number; balanceAfterJod: number; createdAt: string }> };
  repliesCount: number;
  ordersPosted: number;
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "مفعّل",
  SUSPENDED: "موقوف",
  PENDING_PROFILE: "لم يكمل التفعيل",
  PENDING: "قيد المراجعة",
  APPROVED: "معتمد",
  REJECTED: "مرفوض"
};

function auditLabel(entry: PhoneLookup["auditLog"][number]): string {
  const status = (value: string | null) => (value ? STATUS_LABELS[value] ?? value : "—");
  if (entry.action === "CREATED") return `إنشاء الحساب (${status(entry.newStatus)})`;
  if (entry.action === "DELETED") {
    const balance = entry.snapshot?.balanceFils;
    return `حذف الحساب${typeof balance === "number" ? ` وكان رصيده ${money(balance / 1000)} د.أ` : ""}`;
  }
  if (entry.action === "LEDGER_ENTRY_DELETED") {
    const amount = entry.snapshot?.amountFils;
    return `حذف حركة جرد: ${entry.snapshot?.description ?? ""}${typeof amount === "number" ? ` (${money(amount / 1000)} د.أ)` : ""}`;
  }
  const changes: string[] = [];
  if (entry.oldStatus !== entry.newStatus) changes.push(`الحالة من ${status(entry.oldStatus)} إلى ${status(entry.newStatus)}`);
  if (entry.details?.oldFullName !== undefined && entry.details.oldFullName !== entry.fullName) changes.push(`الاسم إلى ${entry.fullName ?? "—"}`);
  if (entry.details?.passwordChanged) changes.push("تغيير كلمة المرور");
  return `تعديل الحساب: ${changes.join("، ") || "تغيير بيانات"}`;
}
type Overview = { captainCount: number; activeCaptainCount: number; totalBalanceJod: number; settings: Settings; groupRemovalEnabled: boolean; latestActivity: Activity[] };
type GroupRemoval = {
  enabled: boolean;
  candidates?: Array<{ phone: string; fullName: string | null; reason: "inactive" | "zero_balance"; balanceJod: number }>;
  withoutAccount?: number;
  unresolved?: number;
  error?: string;
  lastRun: { at: string; removed: string[]; failed: Array<{ phone: string; error: string }>; added: string[]; addFailed: Array<{ phone: string; error: string }>; error: string | null } | null;
};
type CommissionAudit = {
  checkedJobs: number;
  consistentJobs: number;
  issueCount: number;
  repairableJobs: number;
  issues: Array<{ jobId: string; status: string; reasons: string[]; repairable: boolean }>;
};
type WhatsAppLink = {
  status: "not_linked" | "connecting" | "waiting_for_qr" | "connected" | "logged_out";
  phone: string | null;
  error: string | null;
  qrDataUrl: string | null;
};
type CommissionRepair = {
  likedCharged: Array<{ jobId: string }>;
  likedSkipped: Array<{ jobId: string; reason: string }>;
  repairedJobs: number;
  entriesCreated: number;
  history: { reactionsFound: number; approvalsRecorded: number } | null;
  historyError: string | null;
  audit: CommissionAudit;
};

async function api<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers }
  });
  // A proxy error or a crash returns an HTML page; Safari then reports a cryptic "expected pattern" error.
  const body = await response.text();
  let data: { error?: string } & Record<string, unknown>;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`خطأ من الخادم (${response.status}). حاول مرة أخرى بعد قليل.`);
  }
  if (!response.ok) throw new Error(data.error ?? `تعذر إكمال الطلب (${response.status}).`);
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
  const [showCaptains, setShowCaptains] = useState(false);
  const [settings, setSettings] = useState<Settings>({ groupFloorJod: 0, riderCommissionPerFiveJod: 0.75, orderCommissionPerFiveJod: 1 });
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustAction, setAdjustAction] = useState<"credit" | "debit" | "debit_all">("credit");
  const [adjustCaptain, setAdjustCaptain] = useState<Captain | null>(null);
  const [query, setQuery] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [topUps, setTopUps] = useState<TopUpRequest[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [accountRequests, setAccountRequests] = useState<CaptainAccountRequest[]>([]);
  const [receiptPreview, setReceiptPreview] = useState<{ id: string; url: string } | null>(null);
  const [commissionAudit, setCommissionAudit] = useState<CommissionAudit | null>(null);
  const [diagnosePhone, setDiagnosePhone] = useState("");
  const [whatsAppLink, setWhatsAppLink] = useState<WhatsAppLink | null>(null);
  const [groupRemoval, setGroupRemoval] = useState<GroupRemoval | null>(null);
  const [statementPeriod, setStatementPeriod] = useState(defaultPeriod);
  const [statements, setStatements] = useState<{ captains: CaptainWithStatement[]; totals: StatementTotals; from: string; to: string } | null>(null);
  const [statementView, setStatementView] = useState<"captains" | "profit">("captains");
  const [statementPhone, setStatementPhone] = useState("");
  const [auditPhone, setAuditPhone] = useState("");
  const [phoneLookup, setPhoneLookup] = useState<PhoneLookup | null>(null);
  const [searchedStatementPhone, setSearchedStatementPhone] = useState("");
  const statementsRef = useRef<HTMLDivElement>(null);
  const transferRequest = useRef<{ fingerprint: string; requestId: string } | null>(null);

  const refresh = useCallback(async (authToken: string) => {
    const [home, list, methods, topUpList, requestList, withdrawalList] = await Promise.all([
      api<Overview>("/admin/dashboard", authToken),
      api<Captain[]>("/admin/captains", authToken),
      api<PaymentMethod[]>("/payment-methods", ""),
      api<TopUpRequest[]>("/admin/topups", authToken),
      api<CaptainAccountRequest[]>("/admin/captain-account-requests", authToken),
      api<WithdrawalRequest[]>("/admin/withdrawals", authToken)
    ]);
    setOverview(home);
    setSettings(home.settings);
    setCaptains(list);
    setPaymentMethods(methods);
    setTopUps(topUpList);
    setAccountRequests(requestList);
    setWithdrawals(withdrawalList);
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
      void api<CaptainAccountRequest[]>("/admin/captain-account-requests", token)
        .then(setAccountRequests)
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "تعذر تحديث طلبات الحسابات."));
      void api<WithdrawalRequest[]>("/admin/withdrawals", token)
        .then(setWithdrawals)
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "تعذر تحديث طلبات السحب."));
    }, 15000);
    return () => window.clearInterval(interval);
  }, [token]);

  useEffect(() => () => {
    if (receiptPreview) URL.revokeObjectURL(receiptPreview.url);
  }, [receiptPreview]);

  // Poll the WhatsApp link while it waits for the QR scan or connects, so the QR stays current.
  useEffect(() => {
    if (!token || (whatsAppLink?.status !== "waiting_for_qr" && whatsAppLink?.status !== "connecting")) return;
    const interval = window.setInterval(() => {
      void api<WhatsAppLink>("/admin/whatsapp-link", token).then(setWhatsAppLink).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [token, whatsAppLink?.status]);

  useEffect(() => {
    if (!token) return;
    void api<WhatsAppLink>("/admin/whatsapp-link", token).then(setWhatsAppLink).catch(() => undefined);
  }, [token]);

  async function runPhoneLookup() {
    setBusy(true);
    setError("");
    try {
      setPhoneLookup(await api<PhoneLookup>(`/admin/phone-lookup?phone=${encodeURIComponent(auditPhone.trim())}`, token));
    } catch (reason) {
      setPhoneLookup(null);
      setError(reason instanceof Error ? reason.message : "تعذر فحص الرقم.");
    } finally {
      setBusy(false);
    }
  }

  async function loadStatements(view: "captains" | "profit", phone?: string) {
    setStatementView(view);
    setSearchedStatementPhone(phone ?? "");
    setBusy(true);
    setError("");
    if (phone) setStatements(null);
    try {
      const params = new URLSearchParams({ from: statementPeriod.from, to: statementPeriod.to });
      if (phone) params.set("phone", phone.trim());
      setStatements(await api<{ captains: CaptainWithStatement[]; totals: StatementTotals; from: string; to: string }>(
        `/admin/statements?${params.toString()}`,
        token,
        { signal: AbortSignal.timeout(30000) }
      ));
    } catch (reason) {
      if (phone) setStatements(null);
      setError(reason instanceof Error ? reason.message : "تعذر تحميل كشف الحساب.");
    } finally {
      setBusy(false);
    }
  }

  async function saveStatementsPdf() {
    if (!statementsRef.current || !statements) return;
    setBusy(true);
    try {
      const captainPhone = searchedStatementPhone ? statements.captains[0]?.phone : undefined;
      const fileName = captainPhone
        ? `captain-statement-${captainPhone}-${statements.from}-${statements.to}.pdf`
        : `${statementView === "profit" ? "net-profit" : "captains-statement"}-${statements.from}-${statements.to}.pdf`;
      await downloadPdf(statementsRef.current, fileName, statementView === "captains" && !captainPhone);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تنزيل ملف PDF.");
    } finally {
      setBusy(false);
    }
  }

  async function startWhatsAppLink() {
    setError("");
    try {
      await api("/admin/whatsapp-link/start", token, { method: "POST" });
      setWhatsAppLink(await api<WhatsAppLink>("/admin/whatsapp-link", token));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر بدء ربط الواتساب.");
    }
  }

  async function logoutWhatsAppLink() {
    if (!window.confirm("فصل ربط الواتساب؟ النظام ما رح يقرأ الجروب ولا يحذف رسائل لحد ما تربطه من جديد.")) return;
    setError("");
    try {
      await api("/admin/whatsapp-link/logout", token, { method: "POST" });
      setWhatsAppLink(await api<WhatsAppLink>("/admin/whatsapp-link", token));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر فصل الربط.");
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
      const result = await api<Record<string, unknown>>(
        `/admin/whatsapp/diagnose${diagnosePhone.trim() ? `?phone=${encodeURIComponent(diagnosePhone.trim())}` : ""}`,
        token
      );
      const lines: string[] = [];
      if (result.groupConfigured !== true) lines.push("⚠️ معرّف الجروب (WHATSAPP_GROUP_ID) غير مضبوط على الخادم.");
      lines.push(result.socket === "connected"
        ? `✅ واتساب مربوط${typeof result.botPhone === "string" ? ` برقم ${result.botPhone}` : ""}.`
        : `❌ واتساب غير مربوط (الحالة: ${String(result.socket)}). اربط رقم البوت من قسم «ربط واتساب».${result.socketError ? ` آخر خطأ: ${String(result.socketError)}` : ""}`);
      if (result.groupFound === true) lines.push(`✅ الجروب موجود وعدد المشاركين: ${String(result.participantCount)}.`);
      if (result.groupError) lines.push(`❌ فشل قراءة الجروب: ${String(result.groupError)} — تأكد من WHATSAPP_GROUP_ID وإن البوت عضو بالجروب.`);
      if (result.groupFound === true) {
        lines.push(result.botIsAdmin === true
          ? "✅ رقم البوت أدمن في الجروب ويقدر يحذف الرسائل ويشيل الأعضاء."
          : result.botInGroup === true
            ? "❌ رقم البوت مش أدمن في الجروب، فما بيقدر يحذف رسائل الأعضاء ولا يشيلهم. خلّيه أدمن."
            : "❌ رقم البوت مش موجود بين أعضاء الجروب.");
      }
      if (Array.isArray(result.excludedPhones)) lines.push(`🛡️ أرقام مستثناة من الحذف: ${result.excludedPhones.join("، ") || "لا يوجد"}`);
      if (result.webhookQueue && typeof result.webhookQueue === "object") {
        lines.push(`📥 طابور الرسائل: ${Object.entries(result.webhookQueue as Record<string, number>).map(([status, count]) => `${status}: ${count}`).join("، ") || "فارغ"}`);
      }
      const webhookErrors = Array.isArray(result.latestWebhookErrors) ? result.latestWebhookErrors as Array<{ lastError: string }> : [];
      if (webhookErrors.length) lines.push(`⚠️ آخر أخطاء المعالجة: ${webhookErrors.map((item) => item.lastError).join(" ؛ ")}`);
      const lastDeletion = result.lastDeletion as { at?: string; error?: string | null } | null;
      if (lastDeletion) {
        lines.push(`🗑️ آخر محاولة حذف (${new Date(lastDeletion.at ?? "").toLocaleTimeString("ar-JO")}): ${lastDeletion.error ? `فشلت — ${lastDeletion.error}` : "نجحت"}.`);
      } else {
        lines.push("⏳ لم تُسجل محاولة حذف منذ آخر تشغيل.");
      }
      const sweep = result.lastSweep as { at: string; deleted: number; unresolvedSenders: number; error: string | null } | null;
      lines.push(sweep
        ? sweep.error ? `❌ آخر فحص حذف فشل: ${sweep.error}` : `🧹 آخر فحص حذف: ${new Date(sweep.at).toLocaleTimeString("ar-JO")} وحذف ${sweep.deleted} رسالة.`
        : "⏳ فحص الحذف لم يعمل بعد منذ آخر تشغيل.");
      if (sweep?.unresolvedSenders) {
        lines.push(`❌ ${sweep.unresolvedSenders} رسالة ما قدر النظام يعرف رقم مرسلها (معرّف واتساب بدل الرقم)، فما بيقدر يقرر يحذفها.`);
      }
      const deletionIssues = Array.isArray(result.recentDeletionIssues) ? result.recentDeletionIssues as Array<{ error: string }> : [];
      if (deletionIssues.length) lines.push(`❌ آخر أخطاء الحذف: ${deletionIssues.slice(0, 3).map((item) => item.error).join(" ؛ ")}`);
      const phoneCheck = result.phoneCheck as { phone?: string; excluded?: boolean; hasAccount?: boolean; status?: string | null; balanceJod?: number | null; shouldDelete?: boolean; error?: string } | undefined;
      if (phoneCheck?.error) lines.push(`❌ فحص الرقم: ${phoneCheck.error}`);
      else if (phoneCheck) {
        lines.push(`🔎 ${phoneCheck.phone}: ${phoneCheck.excluded ? "مستثنى (رقم إدارة) فما بتنحذف رسائله" : !phoneCheck.hasAccount ? "ما إله حساب" : `الحالة ${phoneCheck.status}، الرصيد ${phoneCheck.balanceJod} د.أ`} — ${phoneCheck.shouldDelete ? "رسائله لازم تنحذف" : "رسائله مسموحة"}.`);
      }
      setNotice(lines.join(" | ") || JSON.stringify(result));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر فحص اتصال واتساب.");
    } finally {
      setBusy(false);
    }
  }

  async function loadGroupRemoval() {
    setBusy(true);
    setError("");
    try {
      setGroupRemoval(await api<GroupRemoval>("/admin/group-removal", token));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر قراءة أعضاء الجروب.");
    } finally {
      setBusy(false);
    }
  }

  async function addToppedUp() {
    if (!window.confirm("إضافة كل اللي حسابهم مفعّل ورصيدهم أكثر من صفر ومش موجودين بالجروب؟")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ added: string[]; failed: Array<{ phone: string; error: string }>; alreadyIn: number }>(
        "/admin/group-removal/add-topped-up", token, { method: "POST" }
      );
      const lines = [result.added.length ? `✅ انضاف ${result.added.length} للجروب.` : "ما في حدا جديد لازم ينضاف."];
      if (result.failed.length) {
        lines.push(`❌ ما قدر يضيف ${result.failed.length}: ${result.failed.slice(0, 10).map((item) => `${item.phone} (${item.error})`).join("، ")}`);
      }
      setNotice(lines.join(" | "));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر الإضافة للجروب.");
    } finally {
      setBusy(false);
    }
  }

  async function exemptFromGroupRemoval(phone: string) {
    setBusy(true);
    setError("");
    try {
      await api("/admin/group-removal/exempt", token, { method: "PUT", body: JSON.stringify({ phone, exempt: true }) });
      setNotice(`تم استثناء ${phone} من الإزالة، وما رح ينشال من الجروب أبداً.`);
      if (groupRemoval) setGroupRemoval({ ...groupRemoval, candidates: groupRemoval.candidates?.filter((candidate) => candidate.phone !== phone) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر الاستثناء.");
    } finally {
      setBusy(false);
    }
  }

  async function setGroupRemovalEnabled(enabled: boolean) {
    if (enabled && !window.confirm("تشغيل الإزالة؟ كل عضو حسابه غير مفعل أو رصيده صفر رح ينشال من الجروب هسا مرة وحدة، وبعدها أي حدا بصير هيك بنشال خلال دقيقة.")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ run: GroupRemoval["lastRun"] }>("/admin/group-removal", token, { method: "PUT", body: JSON.stringify({ enabled }) });
      const run = result.run;
      setNotice(!enabled ? "تم إيقاف الإزالة التلقائية من الجروب."
        : run?.error ? `تم التشغيل، بس الإزالة فشلت: ${run.error}`
        : `تم التشغيل وانشال ${run?.removed.length ?? 0} عضو${run?.failed.length ? `، وفشل ${run.failed.length} (${run.failed[0]!.error})` : ""}.`);
      await refresh(token);
      if (groupRemoval) setGroupRemoval({ ...groupRemoval, enabled });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر حفظ الإعداد.");
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

  async function createCaptain(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const captain = await api<{ fullName: string; phone: string }>("/admin/captains", token, {
        method: "POST",
        body: JSON.stringify({ fullName: form.get("fullName"), phone: form.get("phone") })
      });
      setNotice(`تم إنشاء حساب ${captain.fullName} (${captain.phone}). كلمة المرور المؤقتة: 123456.`);
      formElement.reset();
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر إنشاء حساب الكابتن.");
    } finally {
      setBusy(false);
    }
  }

  async function reviewCaptainAccountRequest(requestId: string, action: "approve" | "reject") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ status: "APPROVED" | "REJECTED"; captain?: { fullName: string; phone: string } }>(
        `/admin/captain-account-requests/${encodeURIComponent(requestId)}/review`,
        token,
        { method: "POST", body: JSON.stringify({ action }) }
      );
      setNotice(result.status === "APPROVED" && result.captain
        ? `تمت الموافقة وإنشاء حساب ${result.captain.fullName} (${result.captain.phone}). كلمة المرور المؤقتة: 123456.`
        : "تم رفض طلب إنشاء الحساب.");
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذرت مراجعة طلب إنشاء الحساب.");
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
    if (adjustAction === "debit_all" &&
        !window.confirm(`تأكيد سحب كامل الرصيد (${money(adjustCaptain.balanceJod)} د.أ)؟`)) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ fullName: string | null; phone: string; amountJod: number; balanceJod: number }>("/admin/captains/adjust", token, {
        method: "POST",
        body: JSON.stringify({
          phone: adjustCaptain.phone,
          ...(adjustAction === "debit_all" ? {} : { amount: form.get("amount") }),
          action: adjustAction,
          description: adjustAction === "credit" ? "شحن رصيد" : adjustAction === "debit_all" ? "سحب كامل الرصيد" : "خصم رصيد"
        })
      });
      setNotice(adjustAction === "debit_all"
        ? `تم سحب مبلغ ${money(result.amountJod)} د.أ من حساب ${result.fullName ?? result.phone}. الرصيد المتبقي: ${money(result.balanceJod)} د.أ.`
        : `${adjustAction === "credit" ? "تم شحن" : "تم خصم"} ${money(result.amountJod)} د.أ ${adjustAction === "credit" ? "على" : "من"} حساب ${result.fullName ?? result.phone}. الرصيد الجديد: ${money(result.balanceJod)} د.أ`);
      setAdjustCaptain(null);
      setAdjustOpen(false);
      setAdjustAction("credit");
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تنفيذ العملية.");
    } finally {
      setBusy(false);
    }
  }

  async function transferCommission(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const transferDetails = {
      consumerPhone: String(form.get("consumerPhone") ?? ""),
      productPhone: String(form.get("productPhone") ?? ""),
      amount: String(form.get("amount") ?? "")
    };
    const fingerprint = JSON.stringify(transferDetails);
    if (transferRequest.current?.fingerprint !== fingerprint) {
      transferRequest.current = { fingerprint, requestId: crypto.randomUUID() };
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{
        amountJod: number;
        consumer: { phone: string; balanceJod: number };
        product: { phone: string; balanceJod: number };
      }>("/admin/commission-transfer", token, {
        method: "POST",
        body: JSON.stringify({
          consumerPhone: form.get("consumerPhone"),
          productPhone: form.get("productPhone"),
          amount: form.get("amount"),
          requestId: transferRequest.current.requestId
        })
      });
      setNotice(
        `تم تحويل عمولة ${money(result.amountJod)} د.أ من المستهلك ${result.consumer.phone} إلى المنتج ${result.product.phone}. ` +
        `الرصيد الجديد: المستهلك ${money(result.consumer.balanceJod)} د.أ، المنتج ${money(result.product.balanceJod)} د.أ.`
      );
      transferRequest.current = null;
      formElement.reset();
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تحويل العمولة.");
    } finally {
      setBusy(false);
    }
  }

  async function runCommissionAudit() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<CommissionAudit>("/admin/commission-audit", token, {
        signal: AbortSignal.timeout(20000)
      });
      setCommissionAudit(result);
      setNotice(result.checkedJobs === 0
        ? "لا توجد طلبات لإجراء تدقيق العمولات عليها."
        : result.issueCount
          ? `انتهى فحص ${result.checkedJobs} طلباً، ووجد ${result.issueCount} حالة تحتاج مراجعة. لم يتم تعديل أي رصيد.`
          : `انتهى فحص ${result.checkedJobs} طلباً؛ الحركات متطابقة ولا توجد فروقات.`);
    } catch (reason) {
      setError(reason instanceof DOMException && reason.name === "TimeoutError"
        ? "استغرق فحص العمولات أكثر من 20 ثانية. انتهى الطلب تلقائياً؛ أعد المحاولة بعد قليل."
        : reason instanceof Error ? reason.message : "تعذر فحص العمولات.");
    } finally {
      setBusy(false);
    }
  }

  async function repairCommissionAudit() {
    if (!window.confirm("سيتم خصم العمولة من كل كابتن أخذ لايك من صاحب الطلب ولم تُخصم منه، وإضافتها لصاحب الطلب، وإكمال أي حركة خصم أو إضافة ناقصة. متابعة؟")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<CommissionRepair>("/admin/commission-audit/repair", token, {
        method: "POST",
        signal: AbortSignal.timeout(60000)
      });
      setCommissionAudit(result.audit);
      setNotice([
        `تم خصم ${result.likedCharged.length} طلباً أخذ لايك ولم يُخصم.`,
        `تم تصحيح ${result.repairedJobs} طلباً بإضافة ${result.entriesCreated} حركة خصم وإضافة.`,
        result.likedSkipped.length ? `لم يُخصم ${result.likedSkipped.length} لايك: ${[...new Set(result.likedSkipped.map((item) => item.reason))].join(" ")}` : "",
        result.historyError ? `تعذر قراءة سجل الجروب: ${result.historyError}` : "",
        `المتبقي للمراجعة اليدوية: ${result.audit.issueCount}.`
      ].filter(Boolean).join(" "));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تصحيح العمولات.");
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

  async function setCaptainPassword(captain: Captain) {
    const who = captain.fullName ? `${captain.fullName} (${captain.phone})` : captain.phone;
    const password = window.prompt(`كلمة السر الجديدة للكابتن ${who}\n(6 أحرف على الأقل)`, "")?.trim();
    if (!password) return;
    if (password.length < 6) {
      setError("كلمة السر يجب أن تكون 6 أحرف على الأقل.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/admin/captains/${captain.id}/password`, token, { method: "PUT", body: JSON.stringify({ password }) });
      setNotice(`تم تغيير كلمة سر ${who}. كلمة السر الجديدة: ${password}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تغيير كلمة السر.");
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

  async function reviewWithdrawal(request: WithdrawalRequest, approve: boolean) {
    if (approve && !window.confirm(`اعتماد سحب ${money(request.amountJod)} د.أ من رصيد ${request.captainName}؟`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/admin/withdrawals/${request.id}/${approve ? "approve" : "reject"}`, token, { method: "POST" });
      setNotice(approve
        ? `تم اعتماد طلب السحب وسحب ${money(request.amountJod)} د.أ من رصيد ${request.captainName}.`
        : "تم رفض طلب السحب.");
      await refresh(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر معالجة طلب السحب.");
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
            <a className="button ghost" href="/booking">إدارة الحجوزات</a>
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
          <Metric icon={<BadgeCheck size={20} />} label="حالة التكامل" value="واتساب مباشر" color="green" detail="ربط مجموعة واتساب" />
        </section>
        <div className="admin-account-shortcuts" style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: "-2px 0 16px" }}>
          <a className="button primary" href="#captain-account-create"><UserRoundPlus size={16} /> إنشاء حساب كابتن</a>
          <a className="button ghost" href="#captain-account-requests"><Users size={16} /> طلبات الانضمام ({accountRequests.length})</a>
        </div>
        <section className="admin-grid">
          <article className="panel" id="captain-account-create">
            <div className="panel-heading"><span className="panel-icon blue"><UserRoundPlus size={19} /></span><div><h2>إنشاء حساب كابتن مباشرة</h2><p>أدخل الاسم ورقم الهاتف لإنشاء الحساب فوراً من الإدارة.</p></div></div>
            <form className="commission-transfer-form" onSubmit={createCaptain}>
              <label>اسم الكابتن<input name="fullName" type="text" autoComplete="name" minLength={3} maxLength={100} required /></label>
              <label>رقم الهاتف<input name="phone" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" minLength={8} maxLength={24} placeholder="079xxxxxxx" required /></label>
              <button className="button primary" disabled={busy}><UserRoundPlus size={16} /> إنشاء الحساب</button>
            </form>
            <p className="hint">كلمة المرور الأولية للحساب الجديد هي <bdi>123456</bdi>، ويُنصح بتغييرها فور تسجيل الدخول.</p>
          </article>
          <article className="panel" id="captain-account-requests">
            <div className="panel-heading"><span className="panel-icon"><Users size={19} /></span><div><h2>طلبات انضمام الكباتن ({accountRequests.length})</h2><p>راجع طلبات الانضمام ووافق لإنشاء الحساب أو ارفض الطلب. تتحدث القائمة تلقائياً.</p></div></div>
            {accountRequests.length ? accountRequests.map((request) => (
              <div key={request.id} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--line)" }}>
                <div>
                  <strong>{request.fullName}</strong>
                  <div dir="ltr" style={{ textAlign: "right", marginTop: 4 }}><bdi>{request.phone}</bdi></div>
                  <small className="hint">{new Date(request.createdAt).toLocaleString("ar-JO")}</small>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="button primary" disabled={busy} onClick={() => void reviewCaptainAccountRequest(request.id, "approve")}>موافقة وإنشاء الحساب</button>
                  <button className="button ghost" disabled={busy} onClick={() => void reviewCaptainAccountRequest(request.id, "reject")}>رفض</button>
                </div>
              </div>
            )) : <p className="hint">لا توجد طلبات إنشاء حساب معلقة حالياً.</p>}
          </article>
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
          <article className="panel">
            <div className="panel-heading"><span className="panel-icon"><ShieldCheck size={19} /></span><div><h2>ربط واتساب</h2><p>رقم البوت: قراءة الجروب وحذف الرسائل وإزالة الأعضاء والتنبيهات</p></div></div>
            {whatsAppLink?.status === "connected" ? (
              <>
                <p className="hint">✅ متصل برقم <bdi>{whatsAppLink.phone}</bdi>. كل شغل الجروب بيمر عبر هذا الربط.</p>
                <button className="button ghost full" onClick={() => void logoutWhatsAppLink()}>فصل الربط</button>
              </>
            ) : whatsAppLink?.status === "waiting_for_qr" && whatsAppLink.qrDataUrl ? (
              <>
                <img src={whatsAppLink.qrDataUrl} alt="رمز QR لربط الواتساب" style={{ width: "100%", maxWidth: 280, display: "block", margin: "0 auto", background: "#fff", borderRadius: 12 }} />
                <p className="hint">من جوال رقم البوت (الأدمن في الجروب): واتساب ← الأجهزة المرتبطة ← ربط جهاز، وامسح الرمز. الرمز يتجدد تلقائياً.</p>
              </>
            ) : whatsAppLink?.status === "connecting" ? (
              <p className="hint">⏳ جارٍ الاتصال...</p>
            ) : (
              <>
                <p className="hint">⚠️ غير مربوط حالياً، فالنظام ما بيقرأ الجروب ولا بيحذف رسائل.{whatsAppLink?.error ? ` آخر خطأ: ${whatsAppLink.error}` : ""}</p>
                <button className="button primary full" onClick={() => void startWhatsAppLink()}>ربط رقم البوت (عرض QR)</button>
              </>
            )}
          </article>
          <article className="panel">
            <div className="panel-heading"><span className="panel-icon"><Users size={19} /></span><div><h2>إزالة من الجروب</h2><p>الحساب غير المفعل أو الرصيد صفر: الكل مرة وحدة، وبعدها خلال دقيقة</p></div></div>
            <p className="hint">
              {overview?.groupRemovalEnabled ? "✅ الإزالة التلقائية شغالة." : "⏸️ الإزالة التلقائية موقفة."} أرقام الإدارة والبوت ومشرفي الجروب والأرقام بدون حساب ما بتنشال.
              اللي بنشال بيرجع للجروب تلقائياً أول ما يشحن ويكون حسابه مفعّل، وإذا رجّعت حدا بإيدك النظام بيستثنيه وما بيشيله مرة ثانية. يضل 0.5 د.أ محجوزة عند كل كابتن لأرضية الجروب، ومعها بيضل بالجروب ويقدر ينزّل طلبات، بس ما بياخذ طلب إلا إذا ضل معه 0.5 بعد العمولة.
            </p>
            <button className="button ghost full" disabled={busy} onClick={() => void loadGroupRemoval()}><Users size={17} /> عرض مين رح ينشال</button>
            <button className="button ghost full" disabled={busy} onClick={() => void addToppedUp()}><UserRoundPlus size={17} /> إضافة اللي شحنوا رصيدهم</button>
            <button className={`button full ${overview?.groupRemovalEnabled ? "ghost" : "primary"}`} disabled={busy} onClick={() => void setGroupRemovalEnabled(!overview?.groupRemovalEnabled)}>
              {overview?.groupRemovalEnabled ? "إيقاف الإزالة التلقائية" : "تشغيل الإزالة التلقائية"}
            </button>
            {groupRemoval && (
              <div className="hint">
                {groupRemoval.error ? <p>❌ تعذر قراءة الجروب: {groupRemoval.error}</p> : (
                  <>
                    <p>{groupRemoval.candidates?.length ? `${groupRemoval.candidates.length} عضو رح ينشال:` : "ما في حدا لازم ينشال حالياً."}</p>
                    {groupRemoval.candidates?.length ? (
                      <ul>
                        {groupRemoval.candidates.slice(0, 50).map((candidate) => (
                          <li key={candidate.phone}><bdi>{candidate.fullName ?? candidate.phone}</bdi> (<bdi dir="ltr">{candidate.phone}</bdi>) — {candidate.reason === "inactive" ? "الحساب غير مفعل" : "الرصيد صفر"}{" "}
                            <button type="button" className="button ghost" disabled={busy} onClick={() => void exemptFromGroupRemoval(candidate.phone)}>استثناء</button></li>
                        ))}
                      </ul>
                    ) : null}
                    {groupRemoval.withoutAccount ? <p>{groupRemoval.withoutAccount} عضو ما إلهم حساب (ما بنشالوا؛ اعمل مزامنة لأعضاء المجموعة).</p> : null}
                    {groupRemoval.unresolved ? <p>{groupRemoval.unresolved} عضو ما قدر النظام يعرف رقمهم.</p> : null}
                  </>
                )}
                {groupRemoval.lastRun && (
                  <p>آخر تشغيل {new Date(groupRemoval.lastRun.at).toLocaleTimeString("ar-JO")}: انشال {groupRemoval.lastRun.removed.length}
                    {groupRemoval.lastRun.failed.length ? `، وفشل ${groupRemoval.lastRun.failed.length} (${groupRemoval.lastRun.failed[0]!.error})` : ""}
                    {groupRemoval.lastRun.added?.length ? `، ورجع ${groupRemoval.lastRun.added.length} بعد الشحن` : ""}
                    {groupRemoval.lastRun.addFailed?.length ? `، وما قدر يرجّع ${groupRemoval.lastRun.addFailed.length} (${groupRemoval.lastRun.addFailed[0]!.error})` : ""}
                    {groupRemoval.lastRun.error ? ` — ${groupRemoval.lastRun.error}` : ""}.</p>
                )}
              </div>
            )}
          </article>
          <article className="panel import-panel">
            <div className="panel-heading"><span className="panel-icon blue"><UserRoundPlus size={19} /></span><div><h2>إضافة الكباتن</h2><p>استيراد المشاركين من جروب الواتساب المحدد</p></div></div>
            <div className="import-visual"><div className="avatar-stack"><span>ك</span><span>ر</span><span>م</span><b>+</b></div><span>إضافة آمنة للمجموعة المحددة <span className="flag-small">🇯🇴</span></span></div>
            <input className="search" value={diagnosePhone} onChange={(event) => setDiagnosePhone(event.target.value)} placeholder="رقم لفحص سبب عدم حذف رسائله (اختياري)" />
            <button className="button ghost full" disabled={busy} onClick={() => void diagnose()}><BadgeCheck size={17} /> فحص اتصال واتساب والحذف</button>
            <button className="button primary full" disabled={busy} onClick={() => void importCaptains()}><UserRoundPlus size={17} /> {busy ? "جارٍ الاستيراد..." : "مزامنة أعضاء المجموعة"}</button>
            <p className="hint">الحسابات الجديدة تبدأ بكلمة مرور مؤقتة <bdi>123456</bdi> ورصيد صفر، وتحتاج إدخال الاسم عند أول دخول.</p>
          </article>
        </section>
        <section className="admin-grid commission-tools">
          <article className="panel">
            <div className="panel-heading"><span className="panel-icon"><CircleDollarSign size={19} /></span><div><h2>تحويل عمولة من مستهلك إلى منتج</h2><p>يُخصم المبلغ من حساب المستهلك ويُضاف للمنتج كعملية واحدة مسجلة.</p></div></div>
            <form className="commission-transfer-form" onSubmit={transferCommission}>
              <label>رقم المستهلك<input name="consumerPhone" type="tel" inputMode="tel" dir="ltr" placeholder="رقم حساب المستهلك" required /></label>
              <label>رقم المنتج<input name="productPhone" type="tel" inputMode="tel" dir="ltr" placeholder="رقم حساب المنتج" required /></label>
              <label>قيمة العمولة بالدينار<input name="amount" type="number" min="0.001" step="0.001" placeholder="0.000" required /></label>
              <button className="button primary" disabled={busy}><CircleDollarSign size={16} /> تنفيذ التحويل</button>
            </form>
            <p className="hint">يشترط وجود الحسابين وتوفر رصيد كافٍ لدى المستهلك؛ لا يمكن أن يصبح رصيد أي حساب سالباً. تُسجل حركتا الخصم والإضافة في سجل الحسابين.</p>
          </article>
          <article className="panel" style={{ gridColumn: "1 / -1" }}>
            <div className="panel-heading"><span className="panel-icon"><BadgeCheck size={19} /></span><div><h2>فحص رقم</h2><p>حالة الحساب وسجل إنشائه وتعديله وحذفه وحركات الجرد عليه</p></div></div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", margin: "8px 0 12px" }}>
              <label style={dateLabelStyle}>رقم الهاتف <input style={dateInputStyle} type="tel" inputMode="tel" dir="ltr" value={auditPhone} onChange={(event) => setAuditPhone(event.target.value)} placeholder="079xxxxxxx" /></label>
              <button type="button" className="button primary" disabled={busy || !auditPhone.trim()} onClick={() => void runPhoneLookup()}>فحص الرقم</button>
              {phoneLookup && <button type="button" className="button ghost" onClick={() => setPhoneLookup(null)}>✕ إغلاق</button>}
            </div>
            {phoneLookup && (
              <div className="hint" style={{ display: "grid", gap: 10 }}>
                <div>
                  <strong><bdi dir="ltr">{phoneLookup.phone}</bdi>: </strong>
                  {phoneLookup.captain
                    ? <>له حساب باسم {phoneLookup.captain.fullName ?? "—"} · الحالة {STATUS_LABELS[phoneLookup.captain.status] ?? phoneLookup.captain.status} · الرصيد {money(phoneLookup.captain.balanceJod)} د.أ · أُنشئ الحساب الحالي {new Date(phoneLookup.captain.createdAt).toLocaleString("ar-JO")}</>
                    : <>لا يوجد له حساب حالياً.</>}
                </div>
                <div>
                  حركات الجرد: {phoneLookup.ledger.count}{phoneLookup.ledger.firstAt ? ` · أول حركة ${new Date(phoneLookup.ledger.firstAt).toLocaleString("ar-JO")}` : ""} · ردود على طلبات: {phoneLookup.repliesCount} · طلبات نزّلها: {phoneLookup.ordersPosted}
                </div>
                <div>
                  <strong>سجل الحساب</strong>
                  {phoneLookup.auditLog.length ? (
                    <ul style={{ margin: "4px 0", paddingInlineStart: 18 }}>
                      {phoneLookup.auditLog.map((entry) => (
                        <li key={entry.id}>
                          {new Date(entry.createdAt).toLocaleString("ar-JO")} — {auditLabel(entry)}
                          {entry.applicationName ? ` · من: ${entry.applicationName}` : entry.dbUser ? ` · من: ${entry.dbUser}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : <div>لا يوجد سجل بعد. السجل يبدأ من وقت تفعيل هذه الميزة، وما قبلها غير محفوظ.</div>}
                </div>
                {phoneLookup.accountRequests.length > 0 && (
                  <div>
                    <strong>طلبات إنشاء الحساب</strong>
                    <ul style={{ margin: "4px 0", paddingInlineStart: 18 }}>
                      {phoneLookup.accountRequests.map((request) => (
                        <li key={request.id}>{new Date(request.createdAt).toLocaleString("ar-JO")} — {request.fullName} · {STATUS_LABELS[request.status] ?? request.status}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {phoneLookup.ledger.latest.length > 0 && (
                  <div>
                    <strong>آخر حركات الجرد</strong>
                    <ul style={{ margin: "4px 0", paddingInlineStart: 18 }}>
                      {phoneLookup.ledger.latest.map((entry) => (
                        <li key={entry.id}>{new Date(entry.createdAt).toLocaleString("ar-JO")} — {entry.description} · {money(entry.amountJod)} د.أ · الرصيد بعدها {money(entry.balanceAfterJod)} د.أ</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </article>
          <article className="panel" style={{ gridColumn: "1 / -1" }}>
            <div className="panel-heading"><span className="panel-icon"><Wallet size={19} /></span><div><h2>كشف حساب الكباتن</h2><p>الإنتاج والاستهلاك والشحن والسحب والأرضيات وصافي الربح لكل الكباتن بكبسة وحدة</p></div></div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", margin: "8px 0 12px" }}>
              <label style={dateLabelStyle}>من <input style={dateInputStyle} type="date" value={statementPeriod.from} max={statementPeriod.to} onChange={(event) => setStatementPeriod({ ...statementPeriod, from: event.target.value })} /></label>
              <label style={dateLabelStyle}>إلى <input style={dateInputStyle} type="date" value={statementPeriod.to} min={statementPeriod.from} onChange={(event) => setStatementPeriod({ ...statementPeriod, to: event.target.value })} /></label>
              <button type="button" className="button primary" disabled={busy || !statementPeriod.from || !statementPeriod.to} onClick={() => void loadStatements("captains")}>عرض كشف الكباتن</button>
              <button type="button" className="button primary" disabled={busy || !statementPeriod.from || !statementPeriod.to} onClick={() => void loadStatements("profit")}>كشف صافي الربح</button>
              <label style={dateLabelStyle}>كشف حساب برقم الهاتف <input style={dateInputStyle} type="tel" inputMode="tel" dir="ltr" value={statementPhone} onChange={(event) => setStatementPhone(event.target.value)} placeholder="079xxxxxxx" /></label>
              <button type="button" className="button primary" disabled={busy || !statementPeriod.from || !statementPeriod.to || !statementPhone.trim()} onClick={() => void loadStatements("captains", statementPhone)}>بحث عن كشف الحساب</button>
              {statements && <button type="button" className="button ghost" disabled={busy} onClick={() => void saveStatementsPdf()}>تنزيل PDF</button>}
            </div>
            {statements && (
              <div style={{ overflowX: "auto" }}>
                <div ref={statementsRef} style={{ minWidth: statementView === "captains" && !searchedStatementPhone ? 900 : undefined }}>
                  <CloseStatementButton onClose={() => setStatements(null)} />
                  {statementView === "profit" ? (
                    <NetProfitSheet totals={statements.totals} period={{ from: statements.from, to: statements.to }} />
                  ) : searchedStatementPhone ? (
                    statements.captains[0] ? (
                      <CaptainStatementSheet captain={statements.captains[0]} period={{ from: statements.from, to: statements.to }} />
                    ) : <div className="empty">لا يوجد حساب مسجل بهذا الرقم.</div>
                  ) : (
                    <AllStatementsSheet
                      captains={statements.captains.filter((captain) => captain.status === "ACTIVE" && hasActivity(captain))}
                      totals={statements.totals}
                      period={{ from: statements.from, to: statements.to }}
                    />
                  )}
                </div>
              </div>
            )}
          </article>
          <article className="panel commission-audit-panel">
            <div className="panel-heading"><span className="panel-icon"><BadgeCheck size={19} /></span><div><h2>تدقيق دفتر العمولات</h2><p>مطابقة خصم الكابتن وإضافة صاحب الطلب وعكس الإلغاء. يُخصم تلقائياً كل 5 دقائق أي رد عليه لايك ولم تُخصم عمولته.</p></div></div>
            <button className="button ghost full" disabled={busy} onClick={() => void runCommissionAudit()}>
              <RefreshCw size={16} /> {busy ? "جارٍ الفحص..." : "فحص جميع العمولات"}
            </button>
            {commissionAudit && (
              <div className="commission-audit-result" role="status">
                <strong>{commissionAudit.consistentJobs} من {commissionAudit.checkedJobs} طلباً متطابقة</strong>
                <button className="button primary full" disabled={busy} onClick={() => void repairCommissionAudit()}>
                  <CircleDollarSign size={16} /> خصم وإضافة العمولات الناقصة{commissionAudit.repairableJobs > 0 ? ` (${commissionAudit.repairableJobs} طلب)` : ""}
                </button>
                {commissionAudit.issueCount > 0 ? (
                  <div className="commission-audit-issues">
                    {commissionAudit.issues.map((issue, index) => (
                      <article key={`${issue.jobId}-${index}`}>
                        <bdi>#{issue.jobId}</bdi> · {issue.status}{issue.repairable ? " · قابل للتصحيح" : " · مراجعة يدوية"}
                        <ul>{issue.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                      </article>
                    ))}
                  </div>
                ) : <span>لا توجد فروقات في دفتر العمولات.</span>}
              </div>
            )}
          </article>
        </section>
        <section className="panel captains-panel">
          <div className="list-heading">
            <button
              type="button"
              className="captains-toggle"
              aria-expanded={showCaptains}
              onClick={() => setShowCaptains((value) => !value)}
            >
              <span className="panel-heading compact"><span className="panel-icon"><Users size={19} /></span><span><strong>إدارة الكباتن</strong><small>{captains.length} حساب مسجل</small></span></span>
              <span className="button ghost">{showCaptains ? "إخفاء الحسابات" : "عرض الحسابات"}</span>
            </button>
            {showCaptains && <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="بحث بالاسم أو الهاتف" />}
          </div>
          {showCaptains && <>
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
                    <button type="button" className={adjustAction === "debit_all" ? "button small debit" : "button small ghost"} disabled={adjustCaptain.balanceJod <= 0} onClick={() => setAdjustAction("debit_all")}><ArrowUpLeft size={14} /> سحب كامل الرصيد</button>
                  </div>
                  {adjustAction !== "debit_all" && <input name="amount" type="number" min="0.001" step="0.001" placeholder={adjustAction === "credit" ? "قيمة الشحن بالدينار" : "قيمة الخصم بالدينار"} required />}
                  <button className="button primary" disabled={busy}><CircleDollarSign size={16} /> {adjustAction === "credit" ? "اعتماد الشحن" : adjustAction === "debit_all" ? "تأكيد سحب كامل الرصيد" : "اعتماد الخصم"}</button>
                  <button type="button" className="button ghost" onClick={() => setAdjustCaptain(null)}>رجوع</button>
                </form>
              )}
            </div>
          )}
          <div className="table-wrap">
            <table><thead><tr><th>الكابتن / الهاتف</th><th>الرصيد</th><th>الحالة</th><th>إجراءات</th></tr></thead>
              <tbody>{visibleCaptains.map((captain) => (
                <tr key={captain.id}>
                  <td data-label="الكابتن / الهاتف"><span className="captain-avatar">{(captain.fullName ?? "؟").slice(0, 1)}</span><span className="captain-identity"><strong>{captain.fullName ?? "بانتظار تفعيل الحساب"}</strong><small dir="ltr">{captain.phone}</small></span></td>
                  <td data-label="الرصيد" className="money-cell">{money(captain.balanceJod)} د.أ</td>
                  <td data-label="الحالة"><span className={`status-pill ${captain.status.toLowerCase()}`}>{statusLabel(captain.status)}</span></td>
                  <td data-label="إجراءات"><div className="row-actions"><button className="button small credit" onClick={() => { setAdjustOpen(true); setAdjustAction("credit"); setAdjustCaptain(captain); }}><CircleDollarSign size={14} /> شحن</button><button className="button small ghost" disabled={busy} onClick={() => void toggleStatus(captain)}>{captain.status === "SUSPENDED" ? "تفعيل" : "إيقاف"}</button><button className="button small ghost" disabled={busy} onClick={() => void setCaptainPassword(captain)}><KeyRound size={14} /> كلمة السر</button></div></td>
                </tr>
              ))}</tbody>
            </table>
            {!visibleCaptains.length && <div className="empty">لا يوجد كباتن مطابقون للبحث.</div>}
          </div>
          </>}
        </section>
        <section className="panel activity-panel">
          <div className="panel-heading compact"><span className="panel-icon"><ArrowDownLeft size={19} /></span><div><h2>حركات الجرد آخر 24 ساعة</h2><p>كل الشحنات والخصومات والعمولات خلال آخر 24 ساعة</p></div></div>
          <button type="button" className="button ghost full" aria-expanded={showActivity} onClick={() => setShowActivity((open) => !open)}>{showActivity ? "إخفاء الحركات" : `عرض الحركات (${overview?.latestActivity.length ?? 0})`}</button>
          {showActivity && <div className="activity-list">{overview?.latestActivity.map((entry) => (
            <article key={entry.id} className="activity-row"><span className={`activity-symbol ${entry.amountJod >= 0 ? "in" : "out"}`}>{entry.amountJod >= 0 ? <ArrowDownLeft size={17} /> : <ArrowUpLeft size={17} />}</span><div className="activity-copy"><strong>{entry.description}</strong><span>{entry.captain.fullName ?? entry.captain.phone} · {new Intl.DateTimeFormat("ar-JO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt))}</span></div><b className={entry.amountJod >= 0 ? "positive" : "negative"}>{entry.amountJod > 0 ? "+" : ""}{money(entry.amountJod)} د.أ</b></article>
          ))}{!overview?.latestActivity.length && <div className="empty">لا توجد حركات مسجلة بعد.</div>}</div>}
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
          {!topUps.length && <div className="empty">لا توجد طلبات شحن معلقة.</div>}
        </div>
      </section>
      <section className="panel activity-panel">
        <div className="panel-heading compact"><span className="panel-icon violet"><ArrowUpLeft size={19} /></span><div><h2>طلبات سحب الرصيد</h2><p>عند الاعتماد يُسحب المبلغ من رصيد الكابتن</p></div></div>
        <div className="topup-admin-list">
          {withdrawals.map((request) => (
            <article key={request.id} className="topup-admin-row">
              <div>
                <strong>{request.captainName} · <span dir="ltr">{request.captainPhone}</span></strong>
                <span>يطلب سحب {money(request.amountJod)} د.أ · رصيده الحالي {money(request.balanceJod)} د.أ · {new Intl.DateTimeFormat("ar-JO", { dateStyle: "short", timeStyle: "short" }).format(new Date(request.createdAt))}</span>
                <span>💳 محفظته / كليك: {request.payoutAccount ? <bdi dir="ltr">{request.payoutAccount}</bdi> : "ما كتب رقم"}</span>
              </div>
              <div className="row-actions">
                <button className="button small credit" disabled={busy || request.balanceJod < request.amountJod} onClick={() => void reviewWithdrawal(request, true)}>اعتماد</button>
                <button className="button small debit" disabled={busy} onClick={() => void reviewWithdrawal(request, false)}>رفض</button>
              </div>
            </article>
          ))}
          {!withdrawals.length && <div className="empty">لا توجد طلبات سحب معلقة.</div>}
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
      <footer className="admin-footer">Take &amp; Go <span>·</span> لوحة إدارة آمنة</footer>
    </main>
  );
}

function Metric({ icon, label, value, color, detail, onClick }: { icon: React.ReactNode; label: string; value: string | number; color: string; detail: string; onClick?: () => void }) {
  return <article className={onClick ? "metric-card clickable" : "metric-card"} onClick={onClick} role={onClick ? "button" : undefined}><span className={`metric-icon ${color}`}>{icon}</span><span className="metric-label">{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function MoneyInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  // Text box that starts empty instead of 0; resyncs only when the value changes from outside (e.g. after a reload).
  const [text, setText] = useState(blankZero(value));
  useEffect(() => {
    setText((current) => (Number(current || 0) === value ? current : blankZero(value)));
  }, [value]);
  return <label className="money-input">{label}<span><input type="text" inputMode="decimal" dir="ltr" value={text} placeholder="0" onChange={(event) => {
    const next = amountInput(event.target.value);
    setText(next);
    onChange(Number(next || 0));
  }} /><b>د.أ</b></span></label>;
}

function money(value: number): string {
  return new Intl.NumberFormat("ar-JO", { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(value);
}

function statusLabel(status: Captain["status"]): string {
  if (status === "ACTIVE") return "مفعل";
  if (status === "SUSPENDED") return "موقوف";
  return "بانتظار الاسم";
}
