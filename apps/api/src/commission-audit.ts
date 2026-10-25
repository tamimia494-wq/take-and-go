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

export type ExpectedCommissionEntry = { captainId: string; type: string; amountFils: number };

export type CommissionAuditIssue = {
  jobId: string;
  status: string;
  reasons: string[];
  missingEntries: ExpectedCommissionEntry[];
  unexpectedEntries: ExpectedCommissionEntry[];
  repairable: boolean;
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
    const reasons: string[] = [];
    const expectedEntries: ExpectedCommissionEntry[] = [];
    // A job can move between captains when the owner removes a like: every CANCELED reply was charged and reversed,
    // and at most one CHARGED reply holds the job now.
    const chargedReplies = job.replies.filter((reply) => reply.status === "CHARGED");
    const reversedReplies = job.replies.filter((reply) => reply.status === "CANCELED");
    if (job.status === "CHARGED" && chargedReplies.length !== 1) {
      reasons.push("لا يوجد رد كابتن معتمد وحيد مطابق لحالة الطلب.");
    } else if (job.status !== "CHARGED" && chargedReplies.length) {
      reasons.push("يوجد رد معتمد على طلب غير معتمد.");
    } else if (job.status === "CANCELED" && !reversedReplies.length) {
      reasons.push("لا يوجد رد كابتن ملغى مطابق لحالة الطلب.");
    }
    if ([...chargedReplies, ...reversedReplies].some((reply) => !reply.captainId)) {
      reasons.push("رد معتمد بدون حساب كابتن.");
    }
    const needsOwner = chargedReplies.length + reversedReplies.length > 0;
    const owner = job.sourceSenderPhone ? captainByPhone.get(job.sourceSenderPhone) : undefined;
    if (needsOwner && !owner) reasons.push("تعذر العثور على حساب صاحب الطلب.");
    if (needsOwner && job.commissionFils !== job.riderCommissionFils + job.orderCommissionFils) {
      reasons.push("إجمالي العمولة لا يساوي مجموع عمولتي الراكب والأوردر.");
    }

    if (owner) {
      const components = [
        { type: "RIDER_COMMISSION", amountFils: job.riderCommissionFils },
        { type: "ORDER_COMMISSION", amountFils: job.orderCommissionFils }
      ].filter((component) => component.amountFils > 0);
      // A captain can be charged, refunded after the like is removed, and charged again when it comes back.
      const captainIds = new Set([...chargedReplies, ...reversedReplies].flatMap((reply) => reply.captainId ? [reply.captainId] : []));
      for (const captainId of captainIds) {
        const recordedReversals = actualEntries.filter((entry) =>
          entry.captainId === captainId && entry.type === "ADJUSTMENT" && entry.amountFils === job.commissionFils
        ).length;
        const reversals = Math.max(recordedReversals, reversedReplies.filter((reply) => reply.captainId === captainId).length);
        const charges = reversals + chargedReplies.filter((reply) => reply.captainId === captainId).length;
        for (let charge = 0; charge < charges; charge += 1) {
          for (const component of components) {
            expectedEntries.push({ captainId, type: component.type, amountFils: -component.amountFils });
            expectedEntries.push({ captainId: owner.id, type: component.type, amountFils: component.amountFils });
          }
        }
        for (let reversal = 0; reversal < reversals; reversal += 1) {
          expectedEntries.push({ captainId, type: "ADJUSTMENT", amountFils: job.commissionFils });
          for (const component of components) {
            expectedEntries.push({ captainId: owner.id, type: "ADJUSTMENT", amountFils: -component.amountFils });
          }
        }
      }
    }

    // Entries can only be rebuilt when the charged captain, the owner and the commission split are all known.
    const canRebuild = reasons.length === 0;
    const missingEntries = canRebuild ? subtractEntries(expectedEntries, actualEntries) : [];
    const unexpectedEntries = subtractEntries(actualEntries.map(toSignatureEntry), expectedEntries);
    if (missingEntries.length) {
      reasons.push(`ينقص ${missingEntries.length} حركة خصم أو إضافة حسب قاعدة العمولة.`);
    }
    if (unexpectedEntries.length) {
      reasons.push(needsOwner
        ? "توجد حركات عمولة زائدة أو مختلفة عن قاعدة الطلب وتحتاج مراجعة يدوية."
        : "طلب غير معتمد لديه حركات عمولة في دفتر الجرد.");
    }
    if (reasons.length) {
      issues.push({
        jobId: job.id,
        status: job.status,
        reasons,
        missingEntries,
        unexpectedEntries,
        repairable: missingEntries.length > 0
      });
    }
    entriesByReference.delete(job.id);
  }

  for (const [reference, orphanEntries] of entriesByReference) {
    if (orphanEntries.length && !jobsById.has(reference)) {
      issues.push({
        jobId: reference,
        status: "UNKNOWN",
        reasons: ["حركات عمولة تشير إلى طلب غير موجود."],
        missingEntries: [],
        unexpectedEntries: orphanEntries.map(toSignatureEntry),
        repairable: false
      });
    }
  }
  return issues;
}

function toSignatureEntry(entry: AuditEntry): ExpectedCommissionEntry {
  return { captainId: entry.captainId, type: entry.type, amountFils: entry.amountFils };
}

/** Multiset difference: entries of `from` that have no matching counterpart in `remove`. */
function subtractEntries(from: ExpectedCommissionEntry[], remove: ExpectedCommissionEntry[]): ExpectedCommissionEntry[] {
  const remaining = countBy(remove, signature);
  const result: ExpectedCommissionEntry[] = [];
  for (const entry of from) {
    const key = signature(entry);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else result.push(entry);
  }
  return result;
}

function signature(entry: ExpectedCommissionEntry): string {
  return `${entry.captainId}|${entry.type}|${entry.amountFils}`;
}

function countBy<T>(values: T[], getKey: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = getKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
