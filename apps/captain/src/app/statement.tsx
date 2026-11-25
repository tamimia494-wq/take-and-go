"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Account statements for the captain app and the admin dashboard (the same file lives in both apps). A statement is
// one week (Friday to Thursday, Amman time); "عرض المزيد" adds the week before. Each order is a card with the
// producer (who posted it), the consumer (who took it), the order and reply texts and their times. Dark background
// with white text, on screen and in the downloaded PDF.

export type CommissionSide = {
  riderJobs: number;
  orderJobs: number;
  riderFils: number;
  orderFils: number;
  refundedFils: number;
  transferredFils: number;
  totalFils: number;
};

export type Statement = {
  openingBalanceFils: number;
  closingBalanceFils: number;
  produced: CommissionSide;
  consumed: CommissionSide;
  topUpsFils: number;
  bonusesFils: number;
  withdrawalsFils: number;
  groupFloorsFils: number;
  spentFils: number;
};

export type StatementTransaction = {
  id: string;
  type: string;
  amountFils: number;
  balanceAfterFils: number;
  description: string;
  reference: string | null;
  idempotencyKey: string | null;
  createdAt: string;
};

export type CaptainWithStatement = {
  id: string;
  phone: string;
  fullName: string | null;
  status: string;
  balanceFils: number;
  statement: Statement;
  entries?: StatementTransaction[];
};

export type StatementTotals = {
  topUpsFils: number;
  bonusesFils: number;
  withdrawalsFils: number;
  groupFloorsFils: number;
  producedFils: number;
  consumedFils: number;
  balanceFils: number;
  netProfitFils: number;
};

export type StatementParty = { name: string | null; phone: string | null };

export type StatementDispute = { id: string; status: string; reason: string; adminNote: string | null; createdAt: string };

export type StatementJob = {
  jobId: string;
  role: "produced" | "consumed" | "both";
  amountFils: number;
  category: string;
  priceDinars: number;
  riderPriceDinars: number;
  orderPriceDinars: number;
  commissionFils: number;
  status: string;
  producer: StatementParty;
  consumer: StatementParty;
  orderText: string | null;
  orderAt: string;
  replyText: string | null;
  replyAt: string | null;
  chargedAt: string;
  dispute: StatementDispute | null;
};

export type WeekRange = { offset: number; start: string; end: string };

/** What every weekly statement response carries. */
export type WeekPage = { week: WeekRange; hasEarlier: boolean };

export type CaptainWeek = WeekPage & { captain: CaptainWithStatement; jobs: StatementJob[] };

export type AllCaptainsWeek = WeekPage & { captains: CaptainWithStatement[]; totals: StatementTotals; jobs?: StatementJob[] };

// ---------------------------------------------------------------------------------------------------------------
// Colours and shared styles

export const colors = {
  page: "#0b1220",
  card: "#141d30",
  cardSoft: "#1b2640",
  line: "#2b3a5a",
  text: "#ffffff",
  muted: "#b9c5dc",
  gold: "#f7b500",
  plus: "#3ddc84",
  minus: "#ff6b6b",
  blue: "#5aa2ff"
};

const sheet: React.CSSProperties = {
  background: colors.page,
  color: colors.text,
  padding: 16,
  borderRadius: 16,
  fontFamily: "inherit",
  direction: "rtl",
  lineHeight: 1.7,
  display: "grid",
  gap: 14
};

const button: React.CSSProperties = {
  background: colors.gold,
  color: "#14182a",
  border: "none",
  borderRadius: 12,
  padding: "11px 18px",
  fontFamily: "inherit",
  fontWeight: 800,
  fontSize: 14,
  cursor: "pointer"
};

const ghostButton: React.CSSProperties = {
  ...button,
  background: "transparent",
  color: colors.text,
  border: `1.5px solid ${colors.line}`
};

const sectionTitle: React.CSSProperties = { fontSize: 16, fontWeight: 800, margin: "6px 0 0", color: colors.gold };

export function jod(fils: number): string {
  // The locale's own minus sign is easy to miss in right-to-left text, so a negative amount gets an explicit one.
  const amount = new Intl.NumberFormat("ar-JO", { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(Math.abs(fils) / 1000);
  return `${fils < 0 ? "‎-" : ""}${amount} د.أ`;
}

function signedJod(fils: number): string {
  return fils > 0 ? `‎+${jod(fils)}` : jod(fils);
}

/** 962791234567 → 0791234567, the way captains write their numbers. */
export function localPhone(phone: string | null): string {
  if (!phone) return "—";
  return /^962\d{9}$/.test(phone) ? `0${phone.slice(3)}` : phone;
}

const dayFormat = new Intl.DateTimeFormat("ar-JO", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Amman" });
const timeFormat = new Intl.DateTimeFormat("ar-JO", { weekday: "long", day: "numeric", month: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Amman" });

function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/** "الجمعة 20 نوفمبر – الخميس 26 نوفمبر": the week's first and last day. */
export function weekLabel(week: WeekRange): string {
  const lastDay = new Date(new Date(week.end).getTime() - 1);
  return `${dayFormat.format(new Date(week.start))} – ${dayFormat.format(lastDay)}`;
}

function weekTitle(week: WeekRange): string {
  return week.offset === 0 ? "هذا الأسبوع" : week.offset === 1 ? "الأسبوع الماضي" : `قبل ${week.offset} أسابيع`;
}

// ---------------------------------------------------------------------------------------------------------------
// PDF

/**
 * Saves a statement as a PDF. On phones that can share files (iPhone Safari) it opens the share sheet so the file
 * can be saved to Files; elsewhere it downloads. The file name stays ASCII, which Safari handles reliably.
 */
export async function downloadPdf(element: HTMLElement, fileName: string, landscape = false): Promise<void> {
  const html2pdf = (await import("html2pdf.js")).default;
  const blob: Blob = await html2pdf().set({
    margin: 4,
    image: { type: "jpeg", quality: 0.95 },
    html2canvas: { scale: 2, backgroundColor: colors.page },
    // @ts-expect-error html2pdf.js supports pagebreak, but its type definitions leave it out.
    pagebreak: { mode: ["css", "legacy"], avoid: "[data-pdf-keep]" },
    jsPDF: { unit: "mm", format: "a4", orientation: landscape ? "landscape" : "portrait" }
  }).from(element).outputPdf("blob");
  const file = new File([blob], fileName, { type: "application/pdf" });
  if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Phone input that stays readable on the apps' pages. */
export const dateLabelStyle: React.CSSProperties = { display: "grid", gap: 4, color: "#ffffff", fontWeight: 700 };
export const dateInputStyle: React.CSSProperties = {
  background: "#ffffff",
  color: "#0b1f4d",
  border: "2px solid #0b1f4d",
  borderRadius: 10,
  padding: "8px 10px",
  fontWeight: 700,
  colorScheme: "light"
};

// ---------------------------------------------------------------------------------------------------------------
// The week pager

/**
 * Loads this week's statement, and one more week back each time "عرض المزيد" is pressed. `render` draws one week.
 * The whole loaded statement can be saved as a PDF.
 */
export function WeeklyStatements<T extends WeekPage>({ load, render, pdfName, landscape = false, onClose }: {
  load: (offset: number) => Promise<T>;
  render: (page: T, update: (page: T) => void) => React.ReactNode;
  pdfName: string;
  landscape?: boolean;
  onClose?: () => void;
}) {
  const [pages, setPages] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const loadWeek = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      const page = await loadRef.current(offset);
      setPages((current) => [...current.filter((item) => item.week.offset !== offset), page].sort((a, b) => a.week.offset - b.week.offset));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تحميل كشف الحساب.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWeek(0);
  }, [loadWeek]);

  async function savePdf() {
    if (!contentRef.current) return;
    setLoading(true);
    try {
      await downloadPdf(contentRef.current, pdfName, landscape);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تنزيل ملف PDF.");
    } finally {
      setLoading(false);
    }
  }

  const last = pages[pages.length - 1];
  const update = (page: T) => setPages((current) => current.map((item) => (item.week.offset === page.week.offset ? page : item)));
  return (
    <div style={{ ...sheet, padding: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {pages.length > 0 && <button type="button" style={ghostButton} disabled={loading} onClick={() => void savePdf()}>تنزيل PDF</button>}
        </div>
        {onClose && <button type="button" aria-label="إغلاق الكشف" title="إغلاق الكشف" style={{ ...ghostButton, width: 44, height: 44, padding: 0, fontSize: 20 }} onClick={onClose}>✕</button>}
      </div>
      <div ref={contentRef} style={{ display: "grid", gap: 18, background: colors.page }}>
        {pages.map((page) => <div key={page.week.offset}>{render(page, update)}</div>)}
      </div>
      {error && <div role="alert" style={{ color: colors.minus, fontWeight: 700 }}>{error}</div>}
      {loading && <div style={{ color: colors.muted, textAlign: "center", fontWeight: 700 }}>جارٍ التحميل...</div>}
      {!loading && last && (last.hasEarlier ? (
        <button type="button" style={{ ...button, width: "100%", fontSize: 15, padding: 14 }} onClick={() => void loadWeek(last.week.offset + 1)}>
          عرض المزيد · الأسبوع اللي قبله
        </button>
      ) : (
        <div style={{ color: colors.muted, textAlign: "center", fontWeight: 700 }}>هذا أول أسبوع في الحساب.</div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Pieces

function WeekHeader({ week, heading, subtitle }: { week: WeekRange; heading: string; subtitle?: React.ReactNode }) {
  return (
    <div style={{ borderBottom: `2px solid ${colors.gold}`, paddingBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{weekTitle(week)}</div>
        <div style={{ fontSize: 13, color: colors.muted, fontWeight: 700 }}>Take &amp; Go · {heading}</div>
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: colors.text }}>{weekLabel(week)}</div>
      {subtitle && <div style={{ fontSize: 14, color: colors.muted, marginTop: 2 }}>{subtitle}</div>}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "plus" | "minus" | "gold" }) {
  const color = tone === "plus" ? colors.plus : tone === "minus" ? colors.minus : tone === "gold" ? colors.gold : colors.text;
  return (
    <div style={{ background: colors.card, border: `1px solid ${colors.line}`, borderRadius: 14, padding: "10px 12px" }}>
      <div style={{ fontSize: 12, color: colors.muted, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color, direction: "rtl" }}>{value}</div>
    </div>
  );
}

const tiles: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 };

function Party({ label, party, highlight }: { label: string; party: StatementParty; highlight: boolean }) {
  return (
    <div style={{ background: colors.cardSoft, borderRadius: 12, padding: "8px 10px", border: `1.5px solid ${highlight ? colors.gold : colors.line}` }}>
      <div style={{ fontSize: 12, color: colors.muted, fontWeight: 700 }}>{label}{highlight ? " (أنت)" : ""}</div>
      <div style={{ fontSize: 15, fontWeight: 800 }}>{party.name ?? "غير مسجل"}</div>
      <bdi dir="ltr" style={{ fontSize: 14, color: colors.text, fontWeight: 600 }}>{localPhone(party.phone)}</bdi>
    </div>
  );
}

function MessageBox({ label, text, time }: { label: string; text: string | null; time: string | null }) {
  return (
    <div style={{ background: colors.cardSoft, borderRadius: 12, padding: "8px 10px", border: `1px solid ${colors.line}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 12, color: colors.muted, fontWeight: 700 }}>
        <span>{label}</span>
        {time && <span>{formatTime(time)}</span>}
      </div>
      <div style={{ fontSize: 15, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: text ? colors.text : colors.muted }}>
        {text ?? "النص غير محفوظ لهذا الطلب."}
      </div>
    </div>
  );
}

const DISPUTE_LABELS: Record<string, string> = { OPEN: "قيد المراجعة", ACCEPTED: "مقبول", REJECTED: "مرفوض" };

function DisputeStatusBox({ dispute }: { dispute: StatementDispute }) {
  const color = dispute.status === "ACCEPTED" ? colors.plus : dispute.status === "REJECTED" ? colors.minus : colors.gold;
  return (
    <div style={{ border: `1.5px solid ${color}`, borderRadius: 12, padding: "8px 10px" }}>
      <div style={{ fontWeight: 800, color }}>اعتراض · {DISPUTE_LABELS[dispute.status] ?? dispute.status}</div>
      <div style={{ fontSize: 14 }}>{dispute.reason}</div>
      {dispute.adminNote && <div style={{ fontSize: 14, color: colors.muted }}>رد الإدارة: {dispute.adminNote}</div>}
    </div>
  );
}

function DisputeForm({ onSubmit }: { onSubmit: (reason: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  if (!open) {
    return <button type="button" data-html2canvas-ignore="true" style={{ ...ghostButton, borderColor: colors.gold, color: colors.gold }} onClick={() => setOpen(true)}>تقديم اعتراض</button>;
  }
  return (
    <form
      data-html2canvas-ignore="true"
      style={{ display: "grid", gap: 8 }}
      onSubmit={(event) => {
        event.preventDefault();
        setSending(true);
        setError("");
        onSubmit(reason.trim())
          .catch((reasonError: unknown) => setError(reasonError instanceof Error ? reasonError.message : "تعذر إرسال الاعتراض."))
          .finally(() => setSending(false));
      }}
    >
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="اكتب سبب الاعتراض، مثلاً: ما أخذت هذا الطلب، أو السعر غلط"
        minLength={3}
        maxLength={500}
        required
        rows={3}
        style={{ width: "100%", boxSizing: "border-box", background: colors.cardSoft, color: colors.text, border: `1.5px solid ${colors.line}`, borderRadius: 12, padding: 10, fontFamily: "inherit", fontSize: 15 }}
      />
      {error && <div role="alert" style={{ color: colors.minus, fontWeight: 700 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" style={button} disabled={sending || reason.trim().length < 3}>{sending ? "جارٍ الإرسال..." : "إرسال الاعتراض للإدارة"}</button>
        <button type="button" style={ghostButton} onClick={() => setOpen(false)}>إلغاء</button>
      </div>
    </form>
  );
}

function jobKind(job: StatementJob): string {
  const parts: string[] = [];
  if (job.riderPriceDinars > 0) parts.push(`راكب · ${job.riderPriceDinars} د.أ`);
  if (job.orderPriceDinars > 0) parts.push(`أوردر · ${job.orderPriceDinars} د.أ`);
  return parts.join(" + ") || `${job.priceDinars} د.أ`;
}

/** One order: producer and consumer on top, then the order, the reply, the times and the objection. */
export function JobCard({ job, viewerRole, onDispute }: {
  job: StatementJob;
  /** Highlights the side the statement belongs to. */
  viewerRole?: StatementJob["role"];
  onDispute?: (reason: string) => Promise<StatementDispute>;
}) {
  const [dispute, setDispute] = useState(job.dispute);
  const role = viewerRole ?? job.role;
  const canceled = job.status === "CANCELED";
  return (
    <article data-pdf-keep style={{ background: colors.card, border: `1px solid ${colors.line}`, borderRadius: 16, padding: 12, display: "grid", gap: 8, breakInside: "avoid" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Party label="المنتج (صاحب الطلب)" party={job.producer} highlight={role === "produced" || role === "both"} />
        <Party label="المستهلك (الكابتن)" party={job.consumer} highlight={role === "consumed" || role === "both"} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span style={{ background: colors.cardSoft, border: `1px solid ${colors.line}`, borderRadius: 999, padding: "3px 12px", fontWeight: 800, fontSize: 14 }}>{jobKind(job)}</span>
          <span style={{ background: colors.cardSoft, border: `1px solid ${colors.line}`, borderRadius: 999, padding: "3px 12px", fontWeight: 700, fontSize: 13, color: colors.muted }}>العمولة {jod(job.commissionFils)}</span>
          {canceled && <span style={{ border: `1.5px solid ${colors.minus}`, color: colors.minus, borderRadius: 999, padding: "3px 12px", fontWeight: 800, fontSize: 13 }}>ملغي · رجعت العمولة</span>}
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color: job.amountFils > 0 ? colors.plus : job.amountFils < 0 ? colors.minus : colors.muted }}>
          {signedJod(job.amountFils)}
        </div>
      </div>
      <MessageBox label="نص الطلب" text={job.orderText} time={job.orderAt} />
      <MessageBox label="رد الكابتن" text={job.replyText} time={job.replyAt} />
      {dispute ? <DisputeStatusBox dispute={dispute} /> : onDispute && <DisputeForm onSubmit={async (reason) => setDispute(await onDispute(reason))} />}
    </article>
  );
}

function transactionLabel(entry: StatementTransaction): string {
  if (entry.type === "CREDIT" && entry.idempotencyKey?.startsWith("activation-bonus:")) return "مكافأة تفعيل";
  if (entry.type === "CREDIT") return "شحن رصيد";
  if (entry.type === "GROUP_FLOOR") return "أرضية الجروب الأسبوعية";
  if (entry.type === "ADJUSTMENT" && entry.reference?.startsWith("commission-transfer:")) return "تحويل عمولة من الإدارة";
  if (isWithdrawalEntry(entry)) return "سحب رصيد";
  return entry.description || "تعديل رصيد";
}

const WITHDRAWAL_DESCRIPTIONS = new Set(["خصم رصيد", "سحب كامل الرصيد", "سحب رصيد"]);

function isWithdrawalEntry(entry: StatementTransaction): boolean {
  if (entry.type !== "ADJUSTMENT") return false;
  if (entry.reference?.startsWith("withdrawal:")) return true;
  return entry.reference === null && WITHDRAWAL_DESCRIPTIONS.has(entry.description);
}

/** Balance movements that are not orders: top-ups, withdrawals, floors, transfers and manual changes. */
function isOrderEntry(entry: StatementTransaction): boolean {
  return Boolean(entry.reference) && !entry.reference!.startsWith("commission-transfer:") && !entry.reference!.startsWith("withdrawal:");
}

function OtherMovements({ entries }: { entries: StatementTransaction[] }) {
  const rows = entries.filter((entry) => !isOrderEntry(entry)).reverse();
  if (!rows.length) return null;
  return (
    <>
      <div style={sectionTitle}>حركات الرصيد</div>
      <div style={{ display: "grid", gap: 6 }}>
        {rows.map((entry) => {
          // Older manual withdrawals were recorded as positive amounts despite reducing the balance.
          const amount = isWithdrawalEntry(entry) ? -Math.abs(entry.amountFils) : entry.amountFils;
          return (
            <div key={entry.id} data-pdf-keep style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", background: colors.card, border: `1px solid ${colors.line}`, borderRadius: 12, padding: "8px 12px" }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{transactionLabel(entry)}</div>
                <div style={{ fontSize: 13, color: colors.muted }}>{formatTime(entry.createdAt)} · الرصيد بعدها {jod(entry.balanceAfterFils)}</div>
              </div>
              <div style={{ fontWeight: 800, fontSize: 16, color: amount < 0 ? colors.minus : colors.plus }}>{signedJod(amount)}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Sheets

/** One captain's week: totals, every order as a card, then the other balance movements. */
export function CaptainWeekSheet({ page, onDispute }: {
  page: CaptainWeek;
  onDispute?: (jobId: string, reason: string) => Promise<StatementDispute>;
}) {
  const { captain, jobs, week } = page;
  const { statement } = captain;
  return (
    <section style={sheet}>
      <WeekHeader week={week} heading="كشف حساب" subtitle={<><strong style={{ color: colors.text }}>{captain.fullName ?? "كابتن"}</strong> · <bdi dir="ltr">{localPhone(captain.phone)}</bdi></>} />
      <div style={tiles}>
        <Tile label="الإنتاج (عمولات إلك)" value={signedJod(statement.produced.totalFils)} tone="plus" />
        <Tile label="الاستهلاك (عمولات عليك)" value={signedJod(-statement.consumed.totalFils)} tone="minus" />
        <Tile label="شحن رصيد" value={jod(statement.topUpsFils + statement.bonusesFils)} />
        <Tile label="سحب رصيد" value={jod(statement.withdrawalsFils)} />
        <Tile label="أرضية الجروب" value={jod(statement.groupFloorsFils)} />
        <Tile label="الرصيد آخر الأسبوع" value={jod(statement.closingBalanceFils)} tone="gold" />
      </div>
      <div style={sectionTitle}>الطلبات ({jobs.length})</div>
      {jobs.length ? (
        <div style={{ display: "grid", gap: 10 }}>
          {jobs.map((job) => (
            <JobCard key={job.jobId} job={job} onDispute={onDispute ? (reason) => onDispute(job.jobId, reason) : undefined} />
          ))}
        </div>
      ) : <div style={{ color: colors.muted, fontWeight: 700 }}>ما في طلبات بهذا الأسبوع.</div>}
      <OtherMovements entries={captain.entries ?? []} />
    </section>
  );
}

/** Every active captain's week in one list, with the admin's totals. */
export function AllCaptainsWeekSheet({ page }: { page: AllCaptainsWeek }) {
  const { totals, week } = page;
  const captains = page.captains.filter((captain) => captain.status === "ACTIVE" && hasActivity(captain));
  return (
    <section style={sheet}>
      <WeekHeader week={week} heading="كشف الكباتن" />
      <div style={tiles}>
        <Tile label="شحن رصيد (+)" value={jod(totals.topUpsFils)} tone="plus" />
        <Tile label="أرضيات الجروب (+)" value={jod(totals.groupFloorsFils)} tone="plus" />
        <Tile label="سحب رصيد (−)" value={jod(totals.withdrawalsFils)} tone="minus" />
        <Tile label="صافي الربح" value={jod(totals.netProfitFils)} tone="gold" />
        <Tile label="إجمالي الإنتاج" value={jod(totals.producedFils)} />
        <Tile label="إجمالي الاستهلاك" value={jod(totals.consumedFils)} />
      </div>
      <div style={sectionTitle}>الكباتن ({captains.length})</div>
      {captains.length ? (
        <div style={{ display: "grid", gap: 8 }}>
          {captains.map(({ id, fullName, phone, balanceFils, statement }) => (
            <article key={id} data-pdf-keep style={{ background: colors.card, border: `1px solid ${colors.line}`, borderRadius: 14, padding: 10, display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div><strong style={{ fontSize: 16 }}>{fullName ?? "—"}</strong> · <bdi dir="ltr">{localPhone(phone)}</bdi></div>
                <div style={{ fontWeight: 800, color: colors.gold }}>الرصيد {jod(balanceFils)}</div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 14 }}>
                <span>إنتاج: <b style={{ color: colors.plus }}>{statement.produced.riderJobs + statement.produced.orderJobs} طلب · {jod(statement.produced.totalFils)}</b></span>
                <span>استهلاك: <b style={{ color: colors.minus }}>{statement.consumed.riderJobs + statement.consumed.orderJobs} طلب · {jod(statement.consumed.totalFils)}</b></span>
                <span>شحن: <b>{jod(statement.topUpsFils)}</b></span>
                <span>سحب: <b>{jod(statement.withdrawalsFils)}</b></span>
                <span>أرضية: <b>{jod(statement.groupFloorsFils)}</b></span>
              </div>
            </article>
          ))}
        </div>
      ) : <div style={{ color: colors.muted, fontWeight: 700 }}>ما في حركات بهذا الأسبوع.</div>}
    </section>
  );
}

/** The admin's net profit for one week: top-ups and group floors in, withdrawals out. */
export function NetProfitWeekSheet({ page }: { page: AllCaptainsWeek }) {
  const { totals, week } = page;
  return (
    <section style={sheet}>
      <WeekHeader week={week} heading="صافي الربح" />
      <div style={tiles}>
        <Tile label="شحن رصيد (+)" value={jod(totals.topUpsFils)} tone="plus" />
        <Tile label="أرضيات الجروب (+)" value={jod(totals.groupFloorsFils)} tone="plus" />
        <Tile label="سحب رصيد (−)" value={jod(totals.withdrawalsFils)} tone="minus" />
        <Tile label="صافي الربح" value={jod(totals.netProfitFils)} tone="gold" />
      </div>
      <div style={{ fontSize: 13, color: colors.muted }}>صافي الربح = شحن الرصيد + أرضيات الجروب − سحب الرصيد. مكافآت التفعيل ({jod(totals.bonusesFils)}) لا تدخل في الحساب.</div>
    </section>
  );
}

/** Whether a captain had any movement inside the week. */
export function hasActivity({ statement }: CaptainWithStatement): boolean {
  return statement.produced.totalFils !== 0 || statement.consumed.totalFils !== 0 ||
    statement.topUpsFils !== 0 || statement.withdrawalsFils !== 0 || statement.groupFloorsFils !== 0 ||
    statement.bonusesFils !== 0;
}
