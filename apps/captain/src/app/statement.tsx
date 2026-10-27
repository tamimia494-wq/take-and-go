"use client";

// Account statement pages for the captain app and the admin dashboard (the same file lives in both apps). They are
// drawn as a white sheet so the screen and the downloaded PDF look the same.

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

export type CaptainWithStatement = {
  id: string;
  phone: string;
  fullName: string | null;
  status: string;
  balanceFils: number;
  statement: Statement;
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

export function jod(fils: number): string {
  return `${new Intl.NumberFormat("ar-JO", { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(fils / 1000)} د.أ`;
}

export function defaultPeriod(): { from: string; to: string } {
  const today = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return { from: day(new Date(today.getFullYear(), today.getMonth(), 1)), to: day(today) };
}

/**
 * Saves a statement sheet as a PDF. On phones that can share files (iPhone Safari) it opens the share sheet so the
 * file can be saved to Files; elsewhere it downloads. The file name stays ASCII, which Safari handles reliably.
 */
export async function downloadPdf(element: HTMLElement, fileName: string, landscape = false): Promise<void> {
  const html2pdf = (await import("html2pdf.js")).default;
  const blob: Blob = await html2pdf().set({
    margin: 6,
    image: { type: "jpeg", quality: 0.95 },
    html2canvas: { scale: 2, backgroundColor: "#ffffff" },
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

const sheet: React.CSSProperties = {
  background: "#ffffff",
  color: "#111827",
  padding: 20,
  borderRadius: 12,
  fontFamily: "inherit",
  direction: "rtl",
  lineHeight: 1.6
};
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", margin: "8px 0 16px", fontSize: 13 };
const cell: React.CSSProperties = { border: "1px solid #d1d5db", padding: "6px 8px", textAlign: "right" };
const head: React.CSSProperties = { ...cell, background: "#f3f4f6", fontWeight: 700 };
const title: React.CSSProperties = { fontSize: 15, fontWeight: 700, margin: "12px 0 4px", color: "#111827" };

function SheetHeader({ heading, period }: { heading: string; period: { from: string; to: string } }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "2px solid #f5b400", paddingBottom: 10, marginBottom: 8 }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 800 }}>Take &amp; Go</div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{heading}</div>
      </div>
      <div style={{ fontSize: 12, color: "#4b5563", textAlign: "left" }}>
        <div>الفترة: <bdi>{period.from}</bdi> إلى <bdi>{period.to}</bdi></div>
        <div>تاريخ الإصدار: {new Intl.DateTimeFormat("ar-JO", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}</div>
      </div>
    </div>
  );
}

function SideTable({ side }: { side: CommissionSide }) {
  return (
    <table style={table}>
      <thead><tr><th style={head}>البند</th><th style={head}>العدد</th><th style={head}>القيمة</th></tr></thead>
      <tbody>
        <tr><td style={cell}>ركاب</td><td style={cell}>{side.riderJobs}</td><td style={cell}>{jod(side.riderFils)}</td></tr>
        <tr><td style={cell}>أوردرات</td><td style={cell}>{side.orderJobs}</td><td style={cell}>{jod(side.orderFils)}</td></tr>
        {side.transferredFils > 0 && <tr><td style={cell}>عمولات محوّلة من الإدارة</td><td style={cell}>—</td><td style={cell}>{jod(side.transferredFils)}</td></tr>}
        {side.refundedFils > 0 && <tr><td style={cell}>مرتجع عمولات</td><td style={cell}>—</td><td style={cell}>-{jod(side.refundedFils)}</td></tr>}
        <tr><td style={head}>الإجمالي</td><td style={head}>{side.riderJobs + side.orderJobs}</td><td style={head}>{jod(side.totalFils)}</td></tr>
      </tbody>
    </table>
  );
}

/** One captain's statement. */
export function CaptainStatementSheet({ captain, period }: { captain: CaptainWithStatement; period: { from: string; to: string } }) {
  const { statement } = captain;
  return (
    <div style={sheet}>
      <SheetHeader heading="كشف حساب كابتن" period={period} />
      <div style={{ fontSize: 14 }}>
        <strong>{captain.fullName ?? "كابتن"}</strong> · <bdi dir="ltr">{captain.phone}</bdi>
      </div>

      <div style={title}>الرصيد</div>
      <table style={table}>
        <tbody>
          <tr><td style={cell}>رصيد نهاية الفترة</td><td style={cell}>{jod(statement.closingBalanceFils)}</td></tr>
          <tr><td style={head}>الرصيد الحالي</td><td style={head}>{jod(captain.balanceFils)}</td></tr>
        </tbody>
      </table>

      <div style={title}>الإنتاج (عمولات أُضيفت لك من طلباتك)</div>
      <SideTable side={statement.produced} />

      <div style={title}>الاستهلاك (عمولات خُصمت منك على طلبات أخذتها)</div>
      <SideTable side={statement.consumed} />

      <div style={title}>حركات الرصيد</div>
      <table style={table}>
        <tbody>
          <tr><td style={cell}>شحن رصيد</td><td style={cell}>{jod(statement.topUpsFils)}</td></tr>
          {statement.bonusesFils > 0 && <tr><td style={cell}>مكافأة تفعيل</td><td style={cell}>{jod(statement.bonusesFils)}</td></tr>}
          <tr><td style={cell}>سحب رصيد</td><td style={cell}>{jod(statement.withdrawalsFils)}</td></tr>
          <tr><td style={cell}>أرضية الجروب</td><td style={cell}>{jod(statement.groupFloorsFils)}</td></tr>
          <tr><td style={head}>إجمالي المستهلك من الرصيد</td><td style={head}>{jod(statement.spentFils)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/** The admin's net profit for a period: top-ups and group floors in, withdrawals out. */
export function NetProfitSheet({ totals, period }: { totals: StatementTotals; period: { from: string; to: string } }) {
  return (
    <div style={sheet}>
      <SheetHeader heading="كشف صافي الربح" period={period} />
      <table style={table}>
        <tbody>
          <tr><td style={cell}>إجمالي شحن الرصيد (+)</td><td style={cell}>{jod(totals.topUpsFils)}</td></tr>
          <tr><td style={cell}>إجمالي أرضيات الجروب (+)</td><td style={cell}>{jod(totals.groupFloorsFils)}</td></tr>
          <tr><td style={cell}>إجمالي سحب الرصيد (−)</td><td style={cell}>{jod(totals.withdrawalsFils)}</td></tr>
          <tr><td style={{ ...head, background: "#fef3c7", fontSize: 16 }}>صافي الربح</td><td style={{ ...head, background: "#fef3c7", fontSize: 16 }}>{jod(totals.netProfitFils)}</td></tr>
        </tbody>
      </table>
      <div style={{ fontSize: 12, color: "#4b5563" }}>صافي الربح = شحن الرصيد + أرضيات الجروب − سحب الرصيد. مكافآت التفعيل لا تدخل في الحساب.</div>
    </div>
  );
}

/** Every captain in one sheet, with the totals and, for the admin, the net profit. */
export function AllStatementsSheet({ captains, totals, period }: {
  captains: CaptainWithStatement[];
  totals: StatementTotals;
  period: { from: string; to: string };
}) {
  const small: React.CSSProperties = { ...cell, fontSize: 11, padding: "4px 5px" };
  const smallHead: React.CSSProperties = { ...head, fontSize: 11, padding: "4px 5px" };
  return (
    <div style={sheet}>
      <SheetHeader heading="كشف حساب الكباتن" period={period} />

      <div style={title}>ملخص الإدارة</div>
      <table style={table}>
        <tbody>
          <tr><td style={cell}>إجمالي شحن الرصيد (+)</td><td style={cell}>{jod(totals.topUpsFils)}</td></tr>
          <tr><td style={cell}>إجمالي أرضيات الجروب (+)</td><td style={cell}>{jod(totals.groupFloorsFils)}</td></tr>
          <tr><td style={cell}>إجمالي سحب الرصيد (−)</td><td style={cell}>{jod(totals.withdrawalsFils)}</td></tr>
          <tr><td style={{ ...head, background: "#fef3c7" }}>صافي الربح</td><td style={{ ...head, background: "#fef3c7" }}>{jod(totals.netProfitFils)}</td></tr>
          <tr><td style={cell}>إجمالي الإنتاج</td><td style={cell}>{jod(totals.producedFils)}</td></tr>
          <tr><td style={cell}>إجمالي الاستهلاك</td><td style={cell}>{jod(totals.consumedFils)}</td></tr>
          <tr><td style={cell}>مكافآت التفعيل (لا تدخل في الربح)</td><td style={cell}>{jod(totals.bonusesFils)}</td></tr>
          <tr><td style={cell}>مجموع أرصدة الكباتن الحالية</td><td style={cell}>{jod(totals.balanceFils)}</td></tr>
        </tbody>
      </table>

      <div style={title}>تفاصيل الكباتن</div>
      <table style={table}>
        <thead>
          <tr>
            <th style={smallHead}>الكابتن</th>
            <th style={smallHead}>إنتاج ركاب</th>
            <th style={smallHead}>إنتاج أوردرات</th>
            <th style={smallHead}>استهلاك ركاب</th>
            <th style={smallHead}>استهلاك أوردرات</th>
            <th style={smallHead}>شحن رصيد</th>
            <th style={smallHead}>سحب رصيد</th>
            <th style={smallHead}>أرضيات</th>
            <th style={smallHead}>الرصيد الحالي</th>
          </tr>
        </thead>
        <tbody>
          {captains.map(({ id, fullName, phone, balanceFils, statement }) => (
            <tr key={id}>
              <td style={small}>{fullName ?? "—"}<br /><bdi dir="ltr">{phone}</bdi></td>
              <td style={small}>{statement.produced.riderJobs} · {jod(statement.produced.riderFils)}</td>
              <td style={small}>{statement.produced.orderJobs} · {jod(statement.produced.orderFils)}</td>
              <td style={small}>{statement.consumed.riderJobs} · {jod(statement.consumed.riderFils)}</td>
              <td style={small}>{statement.consumed.orderJobs} · {jod(statement.consumed.orderFils)}</td>
              <td style={small}>{jod(statement.topUpsFils)}</td>
              <td style={small}>{jod(statement.withdrawalsFils)}</td>
              <td style={small}>{jod(statement.groupFloorsFils)}</td>
              <td style={small}>{jod(balanceFils)}</td>
            </tr>
          ))}
          {!captains.length && <tr><td style={small} colSpan={9}>لا توجد حركات في هذه الفترة.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** Whether a captain had any movement inside the period. */
export function hasActivity({ statement }: CaptainWithStatement): boolean {
  return statement.produced.totalFils !== 0 || statement.consumed.totalFils !== 0 ||
    statement.topUpsFils !== 0 || statement.withdrawalsFils !== 0 || statement.groupFloorsFils !== 0 ||
    statement.bonusesFils !== 0;
}
