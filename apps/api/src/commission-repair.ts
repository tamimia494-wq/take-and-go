import { LedgerType, Prisma } from "@prisma/client";
import { chargeApprovedUnchargedReplies } from "./accounting";
import { auditCommissionLedger } from "./commission-audit";
import { prisma } from "./db";
import { backfillReplyApprovalsFromHistory } from "./whatsapp";

export async function runCommissionAudit(db: Prisma.TransactionClient | typeof prisma) {
  const jobs = await db.whatsAppJob.findMany({
    select: {
      id: true,
      status: true,
      sourceSenderPhone: true,
      commissionFils: true,
      riderCommissionFils: true,
      orderCommissionFils: true,
      replies: { select: { captainId: true, status: true } }
    }
  });
  const ownerPhones = [...new Set(jobs
    .map((job) => job.sourceSenderPhone)
    .filter((phone): phone is string => phone !== null))];
  const jobIds = jobs.map((job) => job.id);
  const [captains, entries] = await Promise.all([
    db.captain.findMany({
      where: { phone: { in: ownerPhones } },
      select: { id: true, phone: true }
    }),
    db.ledgerEntry.findMany({
      where: {
        reference: { in: jobIds },
        type: { in: [LedgerType.ORDER_COMMISSION, LedgerType.RIDER_COMMISSION, LedgerType.ADJUSTMENT] }
      },
      select: { reference: true, captainId: true, type: true, amountFils: true }
    })
  ]);
  const issues = auditCommissionLedger(
    jobs,
    captains,
    entries.filter((entry) => !entry.reference?.startsWith("commission-transfer:"))
  );
  const inconsistentJobIds = new Set(issues.filter((issue) => issue.status !== "UNKNOWN").map((issue) => issue.jobId));
  return {
    checkedJobs: jobs.length,
    consistentJobs: jobs.length - inconsistentJobIds.size,
    issueCount: issues.length,
    repairableJobs: issues.filter((issue) => issue.repairable).length,
    issues
  };
}

/**
 * Takes every owner-liked commission that was never charged and completes any missing debit or credit of a charged
 * job. Runs on a schedule and from the admin dashboard; entries carry idempotency keys so repeated runs are safe.
 */
export async function repairCommissions(historyCount = 300) {
  let history: { reactionsFound: number; approvalsRecorded: number } | null = null;
  let historyError: string | null = null;
  try {
    history = await backfillReplyApprovalsFromHistory(historyCount);
  } catch (error) {
    historyError = error instanceof Error ? error.message : String(error);
  }
  const repaired = await prisma.$transaction(async (tx) => {
    const likes = await chargeApprovedUnchargedReplies(tx);
    const audit = await runCommissionAudit(tx);
    const runAt = Date.now();
    let entriesCreated = 0;
    let repairedJobs = 0;
    for (const issue of audit.issues) {
      if (!issue.repairable) continue;
      repairedJobs += 1;
      for (const [index, entry] of issue.missingEntries.entries()) {
        const captain = await tx.captain.update({
          where: { id: entry.captainId },
          data: { balanceFils: { increment: entry.amountFils } }
        });
        await tx.ledgerEntry.create({
          data: {
            captainId: captain.id,
            type: entry.type as LedgerType,
            amountFils: entry.amountFils,
            balanceAfterFils: captain.balanceFils,
            description: entry.amountFils > 0 ? "تصحيح جرد: إضافة عمولة لم تُضف" : "تصحيح جرد: خصم عمولة لم يُخصم",
            reference: issue.jobId,
            idempotencyKey: `audit-repair:${issue.jobId}:${entry.captainId}:${entry.type}:${entry.amountFils}:${runAt}:${index}`
          }
        });
        entriesCreated += 1;
      }
    }
    return { likedCharged: likes.charged, likedSkipped: likes.skipped, repairedJobs, entriesCreated };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000, maxWait: 10_000 });
  return { ...repaired, history, historyError, audit: await runCommissionAudit(prisma) };
}
