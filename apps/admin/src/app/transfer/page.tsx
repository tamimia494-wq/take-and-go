"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleDollarSign, RefreshCw } from "lucide-react";
import { AdminFrame, api, LoginRequired, matchesCaptain, money, statusLabel, useAdminToken, type Captain } from "../admin-kit";
import { amountInput } from "../amount";

// The commission-transfer form on its own page: every captain is listed, and the admin marks one as the consumer
// (the commission is taken from them) and one as the producer (it is added to them).

export default function TransferPage() {
  const { token, missing } = useAdminToken();
  const [captains, setCaptains] = useState<Captain[]>([]);
  const [query, setQuery] = useState("");
  const [consumer, setConsumer] = useState<Captain | null>(null);
  const [producer, setProducer] = useState<Captain | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const transferRequest = useRef<{ fingerprint: string; requestId: string } | null>(null);

  const load = useCallback(async (authToken: string) => {
    setCaptains(await api<Captain[]>("/admin/captains", authToken));
  }, []);

  useEffect(() => {
    if (!token) return;
    void load(token).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "تعذر تحميل الكباتن."));
  }, [token, load]);

  if (missing) return <LoginRequired />;

  function choose(captain: Captain, role: "consumer" | "producer") {
    setNotice("");
    if (role === "consumer") {
      setConsumer(consumer?.id === captain.id ? null : captain);
      if (producer?.id === captain.id) setProducer(null);
    } else {
      setProducer(producer?.id === captain.id ? null : captain);
      if (consumer?.id === captain.id) setConsumer(null);
    }
  }

  async function transfer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consumer || !producer) {
      setError("اختار مستهلك ومنتج من القائمة.");
      return;
    }
    const details = { consumerPhone: consumer.phone, productPhone: producer.phone, amount };
    const fingerprint = JSON.stringify(details);
    // The same request id for a retried identical transfer, so a double click cannot move the money twice.
    if (transferRequest.current?.fingerprint !== fingerprint) {
      transferRequest.current = { fingerprint, requestId: crypto.randomUUID() };
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ amountJod: number; consumer: { phone: string; balanceJod: number }; product: { phone: string; balanceJod: number } }>(
        "/admin/commission-transfer", token,
        { method: "POST", body: JSON.stringify({ ...details, requestId: transferRequest.current.requestId }) }
      );
      setNotice(
        `تم تحويل ${money(result.amountJod)} د.أ من المستهلك ${consumer.fullName ?? result.consumer.phone} إلى المنتج ${producer.fullName ?? result.product.phone}. ` +
        `الرصيد الجديد: المستهلك ${money(result.consumer.balanceJod)} د.أ، المنتج ${money(result.product.balanceJod)} د.أ.`
      );
      transferRequest.current = null;
      setConsumer(null);
      setProducer(null);
      setAmount("");
      await load(token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تحويل العمولة.");
    } finally {
      setBusy(false);
    }
  }

  const visible = captains.filter((captain) => matchesCaptain(captain, query));

  return (
    <AdminFrame title="تحويل عمولة من مستهلك إلى منتج" subtitle="اختار من القائمة مين المستهلك (بنخصم منه) ومين المنتج (بنضيفله)، واكتب المبلغ.">
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <section className="panel">
        <form className="commission-transfer-form" onSubmit={transfer}>
          <label>المستهلك (بنخصم منه)
            <input readOnly value={consumer ? `${consumer.fullName ?? "بدون اسم"} · ${consumer.phone} · ${money(consumer.balanceJod)} د.أ` : ""} placeholder="اختار من القائمة تحت" />
          </label>
          <label>المنتج (بنضيفله)
            <input readOnly value={producer ? `${producer.fullName ?? "بدون اسم"} · ${producer.phone} · ${money(producer.balanceJod)} د.أ` : ""} placeholder="اختار من القائمة تحت" />
          </label>
          <label>قيمة العمولة بالدينار
            <input type="text" inputMode="decimal" dir="ltr" value={amount} onChange={(event) => setAmount(amountInput(event.target.value))} placeholder="0.000" required />
          </label>
          <button className="button primary" disabled={busy || !consumer || !producer || !Number(amount)}>
            <CircleDollarSign size={16} /> {busy ? "جارٍ التحويل..." : "تنفيذ التحويل"}
          </button>
        </form>
        <p className="hint">لا يمكن أن يصبح رصيد أي حساب سالباً. تُسجل حركتا الخصم والإضافة في سجل الحسابين.</p>
      </section>
      <section className="panel captains-panel">
        <div className="list-heading">
          <span className="panel-heading compact"><span><strong>كل الكباتن</strong><small>{captains.length} حساب</small></span></span>
          <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="بحث بالاسم أو الهاتف" />
          <button type="button" className="button ghost" disabled={busy} onClick={() => void load(token)}><RefreshCw size={16} /> تحديث</button>
        </div>
        <div className="table-wrap">
          <table><thead><tr><th>الكابتن / الهاتف</th><th>الرصيد</th><th>الحالة</th><th>اختيار</th></tr></thead>
            <tbody>{visible.map((captain) => (
              <tr key={captain.id}>
                <td data-label="الكابتن / الهاتف"><span className="captain-avatar">{(captain.fullName ?? "؟").slice(0, 1)}</span><span className="captain-identity"><strong>{captain.fullName ?? "بانتظار تفعيل الحساب"}</strong><small dir="ltr">{captain.phone}</small></span></td>
                <td data-label="الرصيد" className="money-cell">{money(captain.balanceJod)} د.أ</td>
                <td data-label="الحالة"><span className={`status-pill ${captain.status.toLowerCase()}`}>{statusLabel(captain.status)}</span></td>
                <td data-label="اختيار"><div className="row-actions">
                  <button type="button" className={consumer?.id === captain.id ? "button small debit" : "button small ghost"} onClick={() => choose(captain, "consumer")}>
                    {consumer?.id === captain.id ? "✓ مستهلك" : "مستهلك"}
                  </button>
                  <button type="button" className={producer?.id === captain.id ? "button small credit" : "button small ghost"} onClick={() => choose(captain, "producer")}>
                    {producer?.id === captain.id ? "✓ منتج" : "منتج"}
                  </button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
          {!visible.length && <div className="empty">{captains.length ? "لا يوجد كباتن مطابقون للبحث." : "جارٍ التحميل..."}</div>}
        </div>
      </section>
    </AdminFrame>
  );
}
