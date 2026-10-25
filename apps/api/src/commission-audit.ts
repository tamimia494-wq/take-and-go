type AuditJob = {
  id: string;
  status: string;
  sourceSenderPhone: string | null;
  commissionFils: number;
  riderCommissionFils: number;
  orderCommissionFils: number;
  replies: Array<{ captainId: string | null; status: string }>;
};

type AuditCaptain = { id: string; phone: string };

type AuditEntry = {
  reference: string | null;
  captainId: string;
  type: string;
  amountFils: number;
};

export type CommissionAuditIssue = {
  jobId: string;
  status: string;
  reasons: string[];
};

export function auditCommissionLedger(
  jobs: AuditJob[],
  captains: AuditCaptain[],
  entries: AuditEntry[]
): CommissionAuditIssue[] {
  const captainByPhone = new Map(captains.map((captain) => [captain.phone, captain]));
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const entriesByReference = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    if (!entry.reference) continue;
    const grouped = entriesByReference.get(entry.reference) ?? [];
    grouped.push(entry);
    entriesByReference.set(entry.reference, grouped);
  }

  const issues: CommissionAuditIssue[] = [];
  for (const job of jobs) {
    const actualEntries = entriesByReference.get(job.id) ?? [];
    if (job.status !== "CHARGED" && job.status !== "CANCELED") {
      if (actualEntries.length) {
        issues.push({
          jobId: job.id,
          status: job.status,
          reasons: ["طلب غير معتمد لديه حركات عمولة في دفتر الجرد."]
        });
      }
      continue;
    }

    const reasons: string[] = [];
    const expectedEntries: Array<{ captainId: string; type: string; amountFils: number }> = [];
    const expectedReplyStatus = job.status === "CHARGED" ? "CHARGED" : "CANCELED";
    const replies = job.replies.filter((reply) => reply.status === expectedReplyStatus && reply.captainId);
    if (replies.length !== 1) {
      reasons.push("لا يوجد رد كابتن معتمد وحيد مطابق لحالة الطلب.");
    }
    const reply = replies[0];
    const owner = job.sourceSenderPhone ? captainByPhone.get(job.sourceSenderPhone) : undefined;
    if (!owner) reasons.push("تعذر العثور على حساب صاحب الطلب.");
    if (job.commissionFils !== job.riderCommissionFils + job.orderCommissionFils) {
      reasons.push("إجمالي العمولة لا يساوي مجموع عمولتي الراكب والأوردر.");
    }

    if (reply?.captainId && owner) {
      const components = [
        { type: "RIDER_COMMISSION", amountFils: job.riderCommissionFils },
        { type: "ORDER_COMMISSION", amountFils: job.orderCommissionFils }
      ].filter((component) => component.amountFils > 0);
      for (const component of components) {
        expectedEntries.push({
          captainId: reply.captainId,
          type: component.type,
          amountFils: -component.amountFils
        });
        expectedEntries.push({
          captainId: owner.id,
          type: component.type,
          amountFils: component.amountFils
        });
      }
      if (job.status === "CANCELED") {
        expectedEntries.push({
          captainId: reply.captainId,
          type: "ADJUSTMENT",
          amountFils: job.commissionFils
        });
        for (const component of components) {
          expectedEntries.push({
            captainId: owner.id,
            type: "ADJUSTMENT",
            amountFils: -component.amountFils
          });
        }
      }
    }

    if (!sameEntries(expectedEntries, actualEntries)) {
      reasons.push("حركات الخصم والإضافة أو عكس العمولة لا تطابق الطلب.");
    }
    if (reasons.length) issues.push({ jobId: job.id, status: job.status, reasons });
    entriesByReference.delete(job.id);
  }

  for (const [reference, orphanEntries] of entriesByReference) {
    if (orphanEntries.length && !jobsById.has(reference)) {
      issues.push({
        jobId: reference,
        status: "UNKNOWN",
        reasons: ["حركات عمولة تشير إلى طلب غير موجود."]
      });
    }
  }
  return issues;
}

function sameEntries(
  expected: Array<{ captainId: string; type: string; amountFils: number }>,
  actual: AuditEntry[]
): boolean {
  const signature = (entry: { captainId: string; type: string; amountFils: number }) =>
    `${entry.captainId}|${entry.type}|${entry.amountFils}`;
  const expectedCounts = countBy(expected, signature);
  const actualCounts = countBy(actual, signature);
  if (expectedCounts.size !== actualCounts.size) return false;
  for (const [key, count] of expectedCounts) {
    if (actualCounts.get(key) !== count) return false;
  }
  return true;
}

function countBy<T>(values: T[], getKey: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = getKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
