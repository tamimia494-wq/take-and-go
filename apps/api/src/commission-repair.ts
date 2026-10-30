import { LedgerType, Prisma } from "@prisma/client";
import { chargeApprovedUnchargedReplies } from "./accounting";
import { auditCommissionLedger } from "./commission-audit";
import { prisma } from "./db";
import { backfillReplyApprovalsFromHistory } from "./whatsapp";

const LIKE_BACKLOG_RUN_ID = "2026-10-25-charge-uncharged-likes";

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
  const [captains, entries] = await Promise.all([
    db.captain.findMany({
      where: { phone: { in: ownerPhones } },
      select: { id: true, phone: true }
    }),
    db.ledgerEntry.findMany({
      where: {
        reference: { not: null },
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
  let history: Awaited<ReturnType<typeof backfillReplyApprovalsFromHistory>> | null = null;
  let historyError: string | null = null;
  try {
    const backlogPending = !(await prisma.maintenanceRun.findUnique({ where: { id: LIKE_BACKLOG_RUN_ID } }));
    history = await backfillReplyApprovalsFromHistory(backlogPending ? Math.max(historyCount, 1000) : historyCount);
  } catch (error) {
    historyError = error instanceof Error ? error.message : String(error);
  }
  const repaired = await prisma.$transaction(async (tx) => {
    const backlogDone = await tx.maintenanceRun.findUnique({ where: { id: LIKE_BACKLOG_RUN_ID } });
    const likes = await chargeApprovedUnchargedReplies(tx);
    if (!backlogDone) await tx.maintenanceRun.create({ data: { id: LIKE_BACKLOG_RUN_ID } });
    const audit = await runCommissionAudit(tx);
    const runAt = Date.now();
    let entriesCreated = 0;
    let repairedJobs = 0;
    const insufficientJobs: string[] = [];
    for (const issue of audit.issues) {
      if (!issue.repairable) continue;
      // Skip a job whose missing debits would push any balance below zero.
      const netByCaptain = new Map<string, number>();
      for (const entry of issue.missingEntries) {
        netByCaptain.set(entry.captainId, (netByCaptain.get(entry.captainId) ?? 0) + entry.amountFils);
      }
      const balances = await tx.captain.findMany({
        where: { id: { in: [...netByCaptain.keys()] } },
        select: { id: true, balanceFils: true }
      });
      if (balances.some((captain) => captain.balanceFils + (netByCaptain.get(captain.id) ?? 0) < 0)) {
        insufficientJobs.push(issue.jobId);
        continue;
      }
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
    return { likedCharged: likes.charged, likedSkipped: likes.skipped, repairedJobs, entriesCreated, insufficientJobs };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000, maxWait: 10_000 });
  return { ...repaired, history, historyError, audit: await runCommissionAudit(prisma) };
}
