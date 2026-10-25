import { JobCategory, JobStatus, LedgerType, Prisma, ReplyStatus } from "@prisma/client";
import { prisma } from "./db";
import { MINIMUM_CAPTAIN_REPLY_BALANCE_FILS } from "./money";

type ProcessResult =
  | {
      result: "charged";
      captainName: string;
      amountFils: number;
      balanceFils: number;
      category: JobCategory;
      priceDinars: number;
      riderPriceDinars: number;
      orderPriceDinars: number;
    }
  | { result: "insufficient" | "unregistered" | "owner_unregistered" | "already_processed" | "not_tracked"; amountFils: number; category?: JobCategory; priceDinars?: number };

type CancelResult =
  | {
      result: "canceled";
      amountFils: number;
      balanceFils: number;
      priceDinars: number;
      riderPriceDinars: number;
      orderPriceDinars: number;
    }
  | { result: "already_canceled" | "not_charged" | "not_tracked" | "owner_insufficient"; amountFils: number };

/** Thrown inside a transaction to roll it back when it would leave a balance below zero. */
class NegativeBalanceError extends Error {}

async function assertNotNegative(tx: Prisma.TransactionClient, captainIds: string[]): Promise<void> {
  const negative = await tx.captain.count({ where: { id: { in: captainIds }, balanceFils: { lt: 0 } } });
  if (negative) throw new NegativeBalanceError("A commission movement would leave a balance below zero.");
}

export async function processJobReaction(replyMessageId: string): Promise<ProcessResult> {
  return prisma.$transaction(async (tx) => {
    const reply = await tx.whatsAppReply.findUnique({
      where: { messageId: replyMessageId },
      include: { job: true, captain: true }
    });
    if (!reply) return { result: "not_tracked", amountFils: 0 };
    // A reply is rejected when another reply on the job was charged first; it becomes chargeable again once that like is removed.
    if (reply.status === ReplyStatus.CHARGED || reply.status === ReplyStatus.PROCESSING) {
      return {
        result: "already_processed",
        amountFils: reply.job.commissionFils,
        category: reply.job.category,
        priceDinars: reply.job.priceDinars
      };
    }
    if (!reply.captain || reply.captain.status !== "ACTIVE") {
      await tx.whatsAppReply.update({
        where: { id: reply.id },
        data: { status: ReplyStatus.REJECTED, approvedAt: null, approvedByPhone: null, likeRemovedAt: new Date() }
      });
      return {
        result: "unregistered",
        amountFils: reply.job.commissionFils,
        category: reply.job.category,
        priceDinars: reply.job.priceDinars
      };
    }
    const owner = reply.job.sourceSenderPhone
      ? await tx.captain.findUnique({ where: { phone: reply.job.sourceSenderPhone } })
      : null;
    if (!owner) {
      return {
        result: "owner_unregistered",
        amountFils: reply.job.commissionFils,
        category: reply.job.category,
        priceDinars: reply.job.priceDinars
      };
    }

    const replyClaim = await tx.whatsAppReply.updateMany({
      where: { id: reply.id, status: { in: [ReplyStatus.PENDING, ReplyStatus.REJECTED, ReplyStatus.CANCELED] } },
      data: { status: ReplyStatus.PROCESSING }
    });
    if (replyClaim.count !== 1) {
      return {
        result: "already_processed",
        amountFils: reply.job.commissionFils,
        category: reply.job.category,
        priceDinars: reply.job.priceDinars
      };
    }

    const claimed = await tx.whatsAppJob.updateMany({
      where: { id: reply.jobId, status: JobStatus.PENDING },
      data: { status: JobStatus.PROCESSING }
    });
    if (claimed.count !== 1) {
      // A reversed reply keeps its CANCELED status so the ledger audit still expects its reversal.
      await tx.whatsAppReply.update({
        where: { id: reply.id },
        data: { status: reply.status === ReplyStatus.CANCELED ? ReplyStatus.CANCELED : ReplyStatus.REJECTED }
      });
      return {
        result: "already_processed",
        amountFils: reply.job.commissionFils,
        category: reply.job.category,
        priceDinars: reply.job.priceDinars
      };
    }

    // A captain can only take a job when their balance covers its commission; balances never go below zero.
    const debited = await tx.captain.updateMany({
      where: { id: reply.captain.id, balanceFils: { gte: reply.job.commissionFils } },
      data: { balanceFils: { decrement: reply.job.commissionFils } }
    });
    if (debited.count !== 1) {
      await tx.whatsAppJob.update({
        where: { id: reply.jobId },
        data: { status: JobStatus.PENDING }
      });
      await tx.whatsAppReply.update({
        where: { id: reply.id },
        data: {
          status: reply.status === ReplyStatus.CANCELED ? ReplyStatus.CANCELED : ReplyStatus.REJECTED,
          approvedAt: null,
          approvedByPhone: null,
          // Stops the history backfill from bringing this like back after a later top-up.
          likeRemovedAt: new Date()
        }
      });
      return {
        result: "insufficient",
        amountFils: reply.job.commissionFils,
        category: reply.job.category,
        priceDinars: reply.job.priceDinars
      };
    }

    const captain = await tx.captain.findUniqueOrThrow({ where: { id: reply.captain.id } });
    const creditedOwner = await recordJobCharge(tx, reply.job, captain, owner.id, reply.id);
    return {
      result: "charged",
      captainName: reply.captain.fullName ?? reply.captain.phone,
      amountFils: reply.job.commissionFils,
      balanceFils: captain.id === creditedOwner.id ? creditedOwner.balanceFils : captain.balanceFils,
      category: reply.job.category,
      priceDinars: reply.job.priceDinars,
      riderPriceDinars: reply.job.riderPriceDinars,
      orderPriceDinars: reply.job.orderPriceDinars
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

type ChargeableJob = {
  id: string;
  commissionFils: number;
  riderCommissionFils: number;
  orderCommissionFils: number;
  riderPriceDinars: number;
  orderPriceDinars: number;
};

/** Credits the owner, writes both sides of the commission and marks the job and reply charged. The captain must already be debited. */
async function recordJobCharge(
  tx: Prisma.TransactionClient,
  job: ChargeableJob,
  captain: { id: string; balanceFils: number },
  ownerId: string,
  replyId: string
): Promise<{ id: string; balanceFils: number }> {
  const creditedOwner = await tx.captain.update({
    where: { id: ownerId },
    data: { balanceFils: { increment: job.commissionFils } }
  });
  // The first charge keeps the original per-job keys; a job handed to the next liker is keyed by that reply.
  const chargedBefore = await tx.ledgerEntry.count({
    where: { reference: job.id, type: { in: [LedgerType.RIDER_COMMISSION, LedgerType.ORDER_COMMISSION] } }
  });
  const keyPrefix = chargedBefore ? `job:${job.id}:reply:${replyId}:${chargedBefore}` : `job:${job.id}`;
  const commissionEntries = [
    {
      type: LedgerType.RIDER_COMMISSION,
      amountFils: job.riderCommissionFils,
      idempotencyKey: `${keyPrefix}:rider`
    },
    {
      type: LedgerType.ORDER_COMMISSION,
      amountFils: job.orderCommissionFils,
      idempotencyKey: `${keyPrefix}:order`
    }
  ].filter((entry) => entry.amountFils > 0);
  await tx.ledgerEntry.createMany({
    data: commissionEntries.map((entry) => ({
      captainId: captain.id,
      type: entry.type,
      amountFils: -entry.amountFils,
      balanceAfterFils: captain.balanceFils,
      description: describeJobPrice(job.riderPriceDinars, job.orderPriceDinars),
      reference: job.id,
      idempotencyKey: entry.idempotencyKey
    }))
  });
  await tx.ledgerEntry.createMany({
    data: commissionEntries.map((entry) => ({
      captainId: ownerId,
      type: entry.type,
      amountFils: entry.amountFils,
      balanceAfterFils: creditedOwner.balanceFils,
      description: `عمولة مستلمة: ${describeJobPrice(job.riderPriceDinars, job.orderPriceDinars)}`,
      reference: job.id,
      idempotencyKey: `${keyPrefix}:${entry.type.toLowerCase()}:owner`
    }))
  });
  await tx.whatsAppJob.update({
    where: { id: job.id },
    data: { status: JobStatus.CHARGED }
  });
  await tx.whatsAppReply.update({
    where: { id: replyId },
    data: { status: ReplyStatus.CHARGED }
  });
  await tx.whatsAppReply.updateMany({
    where: { jobId: job.id, id: { not: replyId }, status: ReplyStatus.PENDING },
    data: { status: ReplyStatus.REJECTED }
  });
  return creditedOwner;
}

export type ApprovedReplyCharge = { jobId: string; replyId: string; captainId: string; amountFils: number };

type SkippedApproval = { jobId: string; replyId: string; reason: string };

/**
 * Charges the earliest reply on a pending job that the owner approved with 👍 and whose active captain can cover
 * the commission. A liked captain who cannot loses the like, and the job moves on to the next one. The one-time
 * backlog charge passes `force` to take likes that were never charged regardless of balance or account status.
 */
async function chargeNextApprovedReply(
  tx: Prisma.TransactionClient,
  jobId: string,
  skipped: SkippedApproval[],
  force = false
): Promise<ApprovedReplyCharge | null> {
  const job = await tx.whatsAppJob.findUniqueOrThrow({ where: { id: jobId } });
  if (job.status !== JobStatus.PENDING) return null;
  const candidates = await tx.whatsAppReply.findMany({
    where: {
      jobId,
      approvedAt: { not: null },
      status: { in: [ReplyStatus.PENDING, ReplyStatus.REJECTED, ReplyStatus.CANCELED] }
    },
    orderBy: { approvedAt: "asc" }
  });
  if (!candidates.length) return null;
  const owner = job.sourceSenderPhone
    ? await tx.captain.findUnique({ where: { phone: job.sourceSenderPhone } })
    : null;
  if (!owner) {
    skipped.push({ jobId, replyId: candidates[0]!.id, reason: "صاحب الطلب ليس له حساب." });
    return null;
  }
  for (const reply of candidates) {
    if (!reply.captainId) {
      skipped.push({ jobId, replyId: reply.id, reason: "صاحب الرد ليس له حساب كابتن." });
      continue;
    }
    const debited = await tx.captain.updateMany({
      where: force
        ? { id: reply.captainId }
        : { id: reply.captainId, status: "ACTIVE", balanceFils: { gte: job.commissionFils } },
      data: { balanceFils: { decrement: job.commissionFils } }
    });
    if (debited.count !== 1) {
      await tx.whatsAppReply.update({
        where: { id: reply.id },
        data: {
          status: reply.status === ReplyStatus.CANCELED ? ReplyStatus.CANCELED : ReplyStatus.REJECTED,
          approvedAt: null,
          approvedByPhone: null,
          // Stops the history backfill from bringing this like back after a later top-up.
          likeRemovedAt: new Date()
        }
      });
      skipped.push({ jobId, replyId: reply.id, reason: "حساب الكابتن غير مفعل أو رصيده أقل من عمولة الطلب." });
      continue;
    }
    const captain = await tx.captain.findUniqueOrThrow({ where: { id: reply.captainId } });
    await recordJobCharge(tx, job, captain, owner.id, reply.id);
    return { jobId, replyId: reply.id, captainId: captain.id, amountFils: job.commissionFils };
  }
  return null;
}

/** Charges, for every pending job, the reply the owner approved with 👍 whose commission was never taken. */
export async function chargeApprovedUnchargedReplies(tx: Prisma.TransactionClient, force = false): Promise<{
  charged: ApprovedReplyCharge[];
  skipped: SkippedApproval[];
}> {
  const jobs = await tx.whatsAppReply.findMany({
    where: {
      approvedAt: { not: null },
      status: { in: [ReplyStatus.PENDING, ReplyStatus.REJECTED] },
      job: { status: JobStatus.PENDING }
    },
    distinct: ["jobId"],
    select: { jobId: true }
  });
  const charged: ApprovedReplyCharge[] = [];
  const skipped: SkippedApproval[] = [];
  for (const { jobId } of jobs) {
    const result = await chargeNextApprovedReply(tx, jobId, skipped, force);
    if (result) charged.push(result);
  }
  return { charged, skipped };
}

/** Refunds the charged captain and takes the commission back from the owner, writing both sides to the ledger. */
async function reverseJobCharge(
  tx: Prisma.TransactionClient,
  job: ChargeableJob,
  captainId: string,
  ownerId: string,
  keyPrefix: string,
  captainDescription: string,
  ownerDescription: string
): Promise<{ captainId: string; captainBalanceFils: number; ownerId: string; ownerBalanceFils: number }> {
  const captain = await tx.captain.update({
    where: { id: captainId },
    data: { balanceFils: { increment: job.commissionFils } }
  });
  await tx.ledgerEntry.create({
    data: {
      captainId: captain.id,
      type: LedgerType.ADJUSTMENT,
      amountFils: job.commissionFils,
      balanceAfterFils: captain.balanceFils,
      description: captainDescription,
      reference: job.id,
      idempotencyKey: keyPrefix
    }
  });
  const ownerAfterReversal = await tx.captain.update({
    where: { id: ownerId },
    data: { balanceFils: { decrement: job.commissionFils } }
  });
  const ownerReversalEntries = [
    { type: LedgerType.RIDER_COMMISSION, amountFils: job.riderCommissionFils },
    { type: LedgerType.ORDER_COMMISSION, amountFils: job.orderCommissionFils }
  ].filter((entry) => entry.amountFils > 0);
  await tx.ledgerEntry.createMany({
    data: ownerReversalEntries.map((entry) => ({
      captainId: ownerId,
      type: LedgerType.ADJUSTMENT,
      amountFils: -entry.amountFils,
      balanceAfterFils: ownerAfterReversal.balanceFils,
      description: ownerDescription,
      reference: job.id,
      idempotencyKey: `${keyPrefix}:owner:${entry.type.toLowerCase()}`
    }))
  });
  return {
    captainId,
    captainBalanceFils: captain.balanceFils,
    ownerId,
    ownerBalanceFils: ownerAfterReversal.balanceFils
  };
}

type LikeRemovalResult =
  | { result: "transferred"; fromCaptainId: string; toCaptainId: string; amountFils: number }
  | { result: "released"; fromCaptainId: string; amountFils: number }
  | { result: "approval_cleared" | "not_tracked" | "owner_insufficient" };

/**
 * The owner took their 👍 off a reply. A charged reply loses the job and is refunded, and the job moves to the next
 * reply the owner liked; a reply still waiting in that queue just loses its place.
 */
export async function removeJobLike(replyMessageId: string): Promise<LikeRemovalResult> {
  try {
    return await removeJobLikeInTransaction(replyMessageId);
  } catch (error) {
    if (error instanceof NegativeBalanceError) return { result: "owner_insufficient" };
    throw error;
  }
}

async function removeJobLikeInTransaction(replyMessageId: string): Promise<LikeRemovalResult> {
  return prisma.$transaction(async (tx) => {
    const reply = await tx.whatsAppReply.findUnique({
      where: { messageId: replyMessageId },
      include: { job: true }
    });
    if (!reply) return { result: "not_tracked" };
    await tx.whatsAppReply.update({
      where: { id: reply.id },
      data: { approvedAt: null, approvedByPhone: null }
    });
    if (reply.status !== ReplyStatus.CHARGED || reply.job.status !== JobStatus.CHARGED || !reply.captainId) {
      return { result: "approval_cleared" };
    }
    const owner = reply.job.sourceSenderPhone
      ? await tx.captain.findUnique({ where: { phone: reply.job.sourceSenderPhone } })
      : null;
    if (!owner) {
      throw new Error(`Charged WhatsApp job ${reply.jobId} has no registered owner account to move the commission.`);
    }
    await reverseJobCharge(
      tx,
      reply.job,
      reply.captainId,
      owner.id,
      `job-unlike:${reply.id}:${await tx.ledgerEntry.count({ where: { reference: reply.jobId, type: LedgerType.ADJUSTMENT } })}`,
      `إرجاع ${describeJobPrice(reply.job.riderPriceDinars, reply.job.orderPriceDinars)} بعد إزالة اللايك`,
      "عكس العمولة بعد إزالة اللايك"
    );
    await tx.whatsAppReply.update({
      where: { id: reply.id },
      data: { status: ReplyStatus.CANCELED }
    });
    await tx.whatsAppJob.update({
      where: { id: reply.jobId },
      data: { status: JobStatus.PENDING }
    });
    const next = await chargeNextApprovedReply(tx, reply.jobId, []);
    await assertNotNegative(tx, [owner.id]);
    return next
      ? { result: "transferred", fromCaptainId: reply.captainId, toCaptainId: next.captainId, amountFils: next.amountFils }
      : { result: "released", fromCaptainId: reply.captainId, amountFils: reply.job.commissionFils };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function cancelChargedJob(replyMessageId: string, actorPhone: string): Promise<CancelResult> {
  try {
    return await cancelChargedJobInTransaction(replyMessageId, actorPhone);
  } catch (error) {
    if (error instanceof NegativeBalanceError) return { result: "owner_insufficient", amountFils: 0 };
    throw error;
  }
}

async function cancelChargedJobInTransaction(replyMessageId: string, actorPhone: string): Promise<CancelResult> {
  return prisma.$transaction(async (tx) => {
    const reply = await tx.whatsAppReply.findUnique({
      where: { messageId: replyMessageId },
      include: { job: true, captain: true }
    });
    if (!reply) return { result: "not_tracked", amountFils: 0 };
    if (reply.job.status === JobStatus.CANCELED) {
      return { result: "already_canceled", amountFils: reply.job.commissionFils };
    }
    if (reply.job.status !== JobStatus.CHARGED) {
      return { result: "not_charged", amountFils: reply.job.commissionFils };
    }
    if (!reply.captain || reply.status !== ReplyStatus.CHARGED) {
      throw new Error(`Charged WhatsApp job ${reply.jobId} has no charged captain reply.`);
    }
    const owner = reply.job.sourceSenderPhone
      ? await tx.captain.findUnique({ where: { phone: reply.job.sourceSenderPhone } })
      : null;
    if (!owner) {
      throw new Error(`Charged WhatsApp job ${reply.jobId} has no registered owner account to reverse the commission.`);
    }

    const canceled = await tx.whatsAppJob.updateMany({
      where: { id: reply.jobId, status: JobStatus.CHARGED },
      data: { status: JobStatus.CANCELED }
    });
    if (canceled.count !== 1) {
      return { result: "already_canceled", amountFils: reply.job.commissionFils };
    }

    const canceledReply = await tx.whatsAppReply.updateMany({
      where: { id: reply.id, status: ReplyStatus.CHARGED },
      data: { status: ReplyStatus.CANCELED }
    });
    if (canceledReply.count !== 1) {
      throw new Error(`Charged WhatsApp reply ${reply.id} changed during cancellation.`);
    }
    await tx.whatsAppReply.updateMany({
      where: { jobId: reply.jobId, status: ReplyStatus.PENDING },
      data: { status: ReplyStatus.REJECTED }
    });

    const reversal = await reverseJobCharge(
      tx,
      reply.job,
      reply.captain.id,
      owner.id,
      `job-cancel:${reply.job.id}`,
      `عكس ${describeJobPrice(reply.job.riderPriceDinars, reply.job.orderPriceDinars)} بواسطة ${actorPhone}`,
      "عكس العمولة بسبب إلغاء الطلب"
    );
    await assertNotNegative(tx, [owner.id]);
    return {
      result: "canceled",
      amountFils: reply.job.commissionFils,
      balanceFils: reversal.captainId === reversal.ownerId ? reversal.ownerBalanceFils : reversal.captainBalanceFils,
      priceDinars: reply.job.priceDinars,
      riderPriceDinars: reply.job.riderPriceDinars,
      orderPriceDinars: reply.job.orderPriceDinars
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function describeJobPrice(riderPriceDinars: number, orderPriceDinars: number): string {
  const parts: string[] = [];
  if (orderPriceDinars > 0) parts.push(`أوردر ${orderPriceDinars} د.أ`);
  if (riderPriceDinars > 0) parts.push(`راكب ${riderPriceDinars} د.أ`);
  return `عمولة ${parts.join(" + ")}`;
}

export async function chargeWeeklyFloor(): Promise<void> {
  const now = new Date();
  const weekKey = getJordanWeekKey(now);
  await prisma.$transaction(async (tx) => {
    const settings = await tx.appSettings.findUnique({ where: { id: "default" } });
    if (!settings || settings.groupFloorFils <= 0) return;

    const existing = await tx.weeklyFloorCharge.findUnique({ where: { weekKey } });
    if (existing) return;

    const captains = await tx.captain.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, balanceFils: true }
    });
    for (const captain of captains) {
      const balanceAfterFils = captain.balanceFils - settings.groupFloorFils;
      await tx.captain.update({
        where: { id: captain.id },
        data: { balanceFils: balanceAfterFils }
      });
      await tx.ledgerEntry.create({
        data: {
          captainId: captain.id,
          type: LedgerType.GROUP_FLOOR,
          amountFils: -settings.groupFloorFils,
          balanceAfterFils,
          description: "خصم أرضية الجروب الأسبوعية",
          idempotencyKey: `floor:${weekKey}:${captain.id}`
        }
      });
    }
    await tx.weeklyFloorCharge.create({ data: { weekKey } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function chargeWeeklyFloorIfDue(): Promise<void> {
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Amman" }));
  const beforeThursdayDeadline =
    local.getDay() === 4 && (local.getHours() < 23 || (local.getHours() === 23 && local.getMinutes() < 59));
  if (!beforeThursdayDeadline) await chargeWeeklyFloor();
}

function getJordanWeekKey(date: Date): string {
  const local = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Amman" }));
  const day = local.getDay();
  const daysSinceThursday = (day + 3) % 7;
  local.setDate(local.getDate() - daysSinceThursday);
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
}
