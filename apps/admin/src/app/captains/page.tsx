"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpLeft, CircleDollarSign, KeyRound, RefreshCw, Wallet } from "lucide-react";
import { AdminFrame, api, LoginRequired, matchesCaptain, money, statusLabel, useAdminToken, type Captain } from "../admin-kit";
import { amountInput } from "../amount";
import { CaptainStatementSheet, CloseStatementButton, dateInputStyle, dateLabelStyle, defaultPeriod, downloadPdf, type CaptainWithStatement } from "../statement";

// Every captain in one list; "إدارة الكابتن" opens that captain's top-up form, account statement and account actions.

type AdjustAction = "credit" | "debit" | "debit_all";

export default function CaptainsPage() {
  const { token, missing } = useAdminToken();
  const [captains, setCaptains] = useState<Captain[]>([]);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (authToken: string) => {
    setCaptains(await api<Captain[]>("/admin/captains", authToken));
  }, []);

  useEffect(() => {
    if (!token) return;
    void load(token).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "تعذر تحميل الكباتن."));
  }, [token, load]);

  if (missing) return <LoginRequired />;

  async function perform(action: () => Promise<string>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setNotice(await action());
      await load(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تنفيذ العملية.");
    } finally {
      setBusy(false);
    }
  }

  const visible = captains.filter((captain) => matchesCaptain(captain, query));

  return (
    <AdminFrame title="إدارة الكباتن" subtitle="كل الكباتن عندك. اكبس «إدارة الكابتن» لتشحن رصيده أو تخصم منه أو تشوف كشف حسابه.">
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <section className="panel captains-panel">
        <div className="list-heading">
          <span className="panel-heading compact"><span><strong>كل الكباتن</strong><small>{captains.length} حساب</small></span></span>
          <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="بحث بالاسم أو الهاتف" />
          <button type="button" className="button ghost" disabled={busy} onClick={() => void load(token)}><RefreshCw size={16} /> تحديث</button>
        </div>
        <div className="table-wrap">
          <table><thead><tr><th>الكابتن / الهاتف</th><th>الرصيد</th><th>الحالة</th><th>إجراءات</th></tr></thead>
            <tbody>{visible.map((captain) => (
              <CaptainRow
                key={captain.id}
                captain={captain}
                token={token}
                open={openId === captain.id}
                busy={busy}
                onToggle={() => setOpenId(openId === captain.id ? null : captain.id)}
                perform={perform}
                onError={setError}
              />
            ))}</tbody>
          </table>
          {!visible.length && <div className="empty">{captains.length ? "لا يوجد كباتن مطابقون للبحث." : "جارٍ التحميل..."}</div>}
        </div>
      </section>
    </AdminFrame>
  );
}

function CaptainRow({ captain, token, open, busy, onToggle, perform, onError }: {
  captain: Captain;
  token: string;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  perform: (action: () => Promise<string>) => Promise<void>;
  onError: (message: string) => void;
}) {
  const who = captain.fullName ?? captain.phone;
  return (
    <>
      <tr>
        <td data-label="الكابتن / الهاتف"><span className="captain-avatar">{(captain.fullName ?? "؟").slice(0, 1)}</span><span className="captain-identity"><strong>{captain.fullName ?? "بانتظار تفعيل الحساب"}</strong><small dir="ltr">{captain.phone}</small></span></td>
        <td data-label="الرصيد" className="money-cell">{money(captain.balanceJod)} د.أ</td>
        <td data-label="الحالة"><span className={`status-pill ${captain.status.toLowerCase()}`}>{statusLabel(captain.status)}</span></td>
        <td data-label="إجراءات"><div className="row-actions">
          <button type="button" className={open ? "button small primary" : "button small ghost"} aria-expanded={open} onClick={onToggle}>
            <Wallet size={14} /> {open ? "إغلاق" : "إدارة الكابتن"}
          </button>
        </div></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4}>
            <div style={{ display: "grid", gap: 16 }}>
              <AdjustForm captain={captain} token={token} busy={busy} perform={perform} />
              <StatementBox captain={captain} token={token} onError={onError} />
              <div className="row-actions">
                <button type="button" className="button small ghost" disabled={busy} onClick={() => void perform(async () => {
                  const status = captain.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED";
                  await api(`/admin/captains/${captain.id}/status`, token, { method: "PATCH", body: JSON.stringify({ status }) });
                  return status === "ACTIVE" ? `تم تفعيل حساب ${who}.` : `تم إيقاف حساب ${who}.`;
                })}>{captain.status === "SUSPENDED" ? "تفعيل الحساب" : "إيقاف الحساب"}</button>
                <button type="button" className="button small ghost" disabled={busy} onClick={() => {
                  const password = window.prompt(`كلمة السر الجديدة للكابتن ${who}\n(6 أحرف على الأقل)`, "")?.trim();
                  if (!password) return;
                  if (password.length < 6) {
                    onError("كلمة السر يجب أن تكون 6 أحرف على الأقل.");
                    return;
                  }
                  void perform(async () => {
                    await api(`/admin/captains/${captain.id}/password`, token, { method: "PUT", body: JSON.stringify({ password }) });
                    return `تم تغيير كلمة سر ${who}. كلمة السر الجديدة: ${password}`;
                  });
                }}><KeyRound size={14} /> كلمة السر</button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AdjustForm({ captain, token, busy, perform }: {
  captain: Captain;
  token: string;
  busy: boolean;
  perform: (action: () => Promise<string>) => Promise<void>;
}) {
  const [action, setAction] = useState<AdjustAction>("credit");
  const [amount, setAmount] = useState("");
  const who = captain.fullName ?? captain.phone;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (action === "debit_all" && !window.confirm(`تأكيد سحب كامل الرصيد (${money(captain.balanceJod)} د.أ) من ${who}؟`)) return;
    void perform(async () => {
      const result = await api<{ amountJod: number; balanceJod: number }>("/admin/captains/adjust", token, {
        method: "POST",
        body: JSON.stringify({
          phone: captain.phone,
          ...(action === "debit_all" ? {} : { amount }),
          action,
          description: action === "credit" ? "شحن رصيد" : action === "debit_all" ? "سحب كامل الرصيد" : "خصم رصيد"
        })
      });
      setAmount("");
      return action === "credit"
        ? `تم شحن ${money(result.amountJod)} د.أ على حساب ${who}. الرصيد الجديد: ${money(result.balanceJod)} د.أ`
        : `تم خصم ${money(result.amountJod)} د.أ من حساب ${who}. الرصيد الجديد: ${money(result.balanceJod)} د.أ`;
    });
  }

  return (
    <div className="credit-form">
      <form onSubmit={submit}>
        <div><strong>نموذج الشحن · {who}</strong><span>الرصيد الحالي: {money(captain.balanceJod)} د.أ</span></div>
        <div className="adjust-toggle">
          <button type="button" className={action === "credit" ? "button small credit" : "button small ghost"} onClick={() => setAction("credit")}><CircleDollarSign size={14} /> شحن</button>
          <button type="button" className={action === "debit" ? "button small debit" : "button small ghost"} onClick={() => setAction("debit")}><ArrowUpLeft size={14} /> خصم</button>
          <button type="button" className={action === "debit_all" ? "button small debit" : "button small ghost"} disabled={captain.balanceJod <= 0} onClick={() => setAction("debit_all")}><ArrowUpLeft size={14} /> سحب كامل الرصيد</button>
        </div>
        {action !== "debit_all" && (
          <input type="text" inputMode="decimal" dir="ltr" value={amount} onChange={(event) => setAmount(amountInput(event.target.value))} placeholder={action === "credit" ? "قيمة الشحن بالدينار" : "قيمة الخصم بالدينار"} required />
        )}
        <button className="button primary" disabled={busy || (action !== "debit_all" && !Number(amount))}>
          <CircleDollarSign size={16} /> {action === "credit" ? "اعتماد الشحن" : action === "debit_all" ? "تأكيد سحب كامل الرصيد" : "اعتماد الخصم"}
        </button>
      </form>
    </div>
  );
}

function StatementBox({ captain, token, onError }: { captain: Captain; token: string; onError: (message: string) => void }) {
  const [period, setPeriod] = useState(defaultPeriod);
  const [statement, setStatement] = useState<{ captain: CaptainWithStatement; from: string; to: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  async function show() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: period.from, to: period.to, phone: captain.phone });
      const result = await api<{ captains: CaptainWithStatement[]; from: string; to: string }>(`/admin/statements?${params.toString()}`, token);
      const found = result.captains[0];
      if (!found) throw new Error("ما في كشف حساب لهذا الكابتن.");
      setStatement({ captain: found, from: result.from, to: result.to });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "تعذر تحميل كشف الحساب.");
    } finally {
      setLoading(false);
    }
  }

  async function savePdf() {
    if (!sheetRef.current || !statement) return;
    try {
      await downloadPdf(sheetRef.current, `captain-statement-${captain.phone}-${statement.from}-${statement.to}.pdf`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "تعذر تنزيل ملف PDF.");
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <strong>كشف حساب</strong>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end" }}>
        <label style={dateLabelStyle}>من<input type="date" style={dateInputStyle} value={period.from} onChange={(event) => setPeriod({ ...period, from: event.target.value })} /></label>
        <label style={dateLabelStyle}>إلى<input type="date" style={dateInputStyle} value={period.to} onChange={(event) => setPeriod({ ...period, to: event.target.value })} /></label>
        <button type="button" className="button ghost" disabled={loading} onClick={() => void show()}><Wallet size={16} /> {loading ? "جارٍ التحميل..." : "عرض كشف الحساب"}</button>
        {statement && <button type="button" className="button ghost" onClick={() => void savePdf()}>تنزيل PDF</button>}
      </div>
      {statement && (
        <div ref={sheetRef}>
          <CloseStatementButton onClose={() => setStatement(null)} />
          <CaptainStatementSheet captain={statement.captain} period={{ from: statement.from, to: statement.to }} />
        </div>
      )}
    </div>
  );
}
