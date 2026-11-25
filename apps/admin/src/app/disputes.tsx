"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquareWarning } from "lucide-react";
import { api } from "./admin-kit";
import { JobCard, colors, jod, localPhone, type StatementJob } from "./statement";

// Objections captains raise on orders in their statements. The admin reads the order, the reply and the reason,
// then accepts or rejects it with a note the captain sees on their statement. Money is corrected with the existing
// tools (commission transfer or balance adjustment); accepting does not move money by itself.

type Dispute = {
  id: string;
  status: "OPEN" | "ACCEPTED" | "REJECTED";
  reason: string;
  adminNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
  captain: { id: string; fullName: string | null; phone: string; balanceFils: number };
  job: StatementJob | null;
};

const STATUS_LABELS: Record<Dispute["status"], string> = { OPEN: "بانتظار المراجعة", ACCEPTED: "مقبول", REJECTED: "مرفوض" };

export function DisputesPanel({ token }: { token: string }) {
  const [showAll, setShowAll] = useState(false);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const result = await api<{ disputes: Dispute[]; openCount: number }>(`/admin/disputes${showAll ? "?status=ALL" : ""}`, token);
      setDisputes(result.disputes);
      setOpenCount(result.openCount);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تحميل الاعتراضات.");
    } finally {
      setLoading(false);
    }
  }, [token, showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(id: string, status: "ACCEPTED" | "REJECTED", note: string) {
    await api(`/admin/disputes/${id}/resolve`, token, { method: "POST", body: JSON.stringify({ status, note }) });
    await load();
  }

  return (
    <article className="panel" style={{ gridColumn: "1 / -1" }}>
      <div className="panel-heading">
        <span className="panel-icon"><MessageSquareWarning size={19} /></span>
        <div><h2>اعتراضات الكباتن {openCount > 0 && <span style={{ color: "#c0392b" }}>({openCount} جديد)</span>}</h2><p>اعتراضات على طلبات بكشف الحساب. راجع الطلب والرد وقرر، ورد الإدارة بيظهر للكابتن بكشفه.</p></div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <button type="button" className="button ghost" onClick={() => setShowAll((value) => !value)}>{showAll ? "عرض الجديدة فقط" : "عرض كل الاعتراضات"}</button>
        <button type="button" className="button ghost" disabled={loading} onClick={() => void load()}>{loading ? "جارٍ التحميل..." : "تحديث"}</button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div style={{ display: "grid", gap: 12, background: colors.page, color: colors.text, borderRadius: 16, padding: disputes.length ? 12 : 0 }}>
        {disputes.map((dispute) => <DisputeItem key={dispute.id} dispute={dispute} onResolve={resolve} />)}
      </div>
      {!loading && !disputes.length && <div className="empty">{showAll ? "ما في اعتراضات." : "ما في اعتراضات جديدة."}</div>}
    </article>
  );
}

function DisputeItem({ dispute, onResolve }: { dispute: Dispute; onResolve: (id: string, status: "ACCEPTED" | "REJECTED", note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const statusColor = dispute.status === "ACCEPTED" ? colors.plus : dispute.status === "REJECTED" ? colors.minus : colors.gold;

  async function decide(status: "ACCEPTED" | "REJECTED") {
    setBusy(true);
    setError("");
    try {
      await onResolve(dispute.id, status, note.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر حفظ القرار.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ display: "grid", gap: 8, border: `1.5px solid ${statusColor}`, borderRadius: 16, padding: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 15 }}>
          <strong>{dispute.captain.fullName ?? "كابتن"}</strong> · <bdi dir="ltr">{localPhone(dispute.captain.phone)}</bdi>
          <span style={{ color: colors.muted }}> · الرصيد {jod(dispute.captain.balanceFils)}</span>
        </div>
        <strong style={{ color: statusColor }}>{STATUS_LABELS[dispute.status]}</strong>
      </div>
      <div style={{ background: colors.cardSoft, borderRadius: 12, padding: "8px 10px", fontSize: 15 }}>
        <div style={{ color: colors.muted, fontSize: 12, fontWeight: 700 }}>سبب الاعتراض · {new Date(dispute.createdAt).toLocaleString("ar-JO", { timeZone: "Asia/Amman" })}</div>
        {dispute.reason}
      </div>
      {dispute.job ? <JobCard job={dispute.job} /> : <div style={{ color: colors.muted }}>تفاصيل الطلب غير متوفرة.</div>}
      {dispute.status === "OPEN" ? (
        <div style={{ display: "grid", gap: 8 }}>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            rows={2}
            placeholder="رد الإدارة للكابتن (اختياري)، مثلاً: رجعنا العمولة لرصيدك"
            style={{ width: "100%", boxSizing: "border-box", background: colors.cardSoft, color: colors.text, border: `1.5px solid ${colors.line}`, borderRadius: 12, padding: 10, fontFamily: "inherit", fontSize: 15 }}
          />
          {error && <div role="alert" style={{ color: colors.minus, fontWeight: 700 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="button primary" disabled={busy} onClick={() => void decide("ACCEPTED")}>قبول الاعتراض</button>
            <button type="button" className="button ghost" style={{ background: "#fff" }} disabled={busy} onClick={() => void decide("REJECTED")}>رفض الاعتراض</button>
          </div>
          <div style={{ color: colors.muted, fontSize: 13 }}>القبول ما بحرّك فلوس لحاله. إذا لازم ترجع عمولة، استخدم تحويل العمولة أو تعديل الرصيد من صفحة الكابتن.</div>
        </div>
      ) : dispute.adminNote && <div style={{ color: colors.muted, fontSize: 14 }}>رد الإدارة: {dispute.adminNote}</div>}
    </section>
  );
}
