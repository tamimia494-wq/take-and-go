import { JobCategory, JobStatus, LedgerType, Prisma, ReplyStatus } from "@prisma/client";
import { prisma } from "./db";

type ProcessResult =
  | {
      result: "charged";
      amountFils: number;
      balanceFils: number;
      category: JobCategory;
      priceDinars: number;
      riderPriceDinars: number;
      orderPriceDinars: number;
    }
  | { result: "insufficient" | "unregistered" | "already_processed" | "not_tracked"; amountFils: number; category?: JobCategory; priceDinars?: number };

type CancelResult =
  | {
      result: "canceled";
      amountFils: number;
      balanceFils: number;
      priceDinars: number;
      riderPriceDinars: number;
      orderPriceDinars: number;
    }
  | { result: "already_canceled" | "not_charged" | "not_tracked"; amountFils: number };

export async function processJobReaction(replyMessageId: string): Promise<ProcessResult> {
  return prisma.$transaction(async (tx) => {
    const reply = await tx.whatsAppReply.findUnique({
      where: { messageId: replyMessageId },
      include: { job: true, captain: true }
    });
    if (!reply) return { result: "not_tracked", amountFils: 0 };
    if (reply.status !== ReplyStatus.PENDING) {
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
        data: { status: ReplyStatus.REJECTED }
      });
      return {
        result: "unregistered",
        amountFils: reply.job.commissionFils,
        category: reply.job.category,
        priceDinars: reply.job.priceDinars
      };
    }

    const replyClaim = await tx.whatsAppReply.updateMany({
      where: { id: reply.id, status: ReplyStatus.PENDING },
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
      await tx.whatsAppReply.update({
        where: { id: reply.id },
        data: { status: ReplyStatus.REJECTED }
      });
      return {
        result: "already_processed",
        amountFils: reply.job.commissionFils,
        category: reply.job.category,
        priceDinars: reply.job.priceDinars
      };
    }

    const debited = await tx.captain.updateMany({
      where: { id: reply.captain.id, balanceFils: { gte: Math.max(reply.job.commissionFils, 750) } },
      data: { balanceFils: { decrement: reply.job.commissionFils } }
    });
    if (debited.count !== 1) {
      await tx.whatsAppJob.update({
        where: { id: reply.jobId },
        data: { status: JobStatus.PENDING }
      });
      await tx.whatsAppReply.update({
        where: { id: reply.id },
        data: { status: ReplyStatus.REJECTED }
      });
      return {
        result: "insufficient",
        amountFils: reply.job.commissionFils,
        category: reply.job.category,
        priceDinars: reply.job.priceDinars
      };
    }

    const captain = await tx.captain.findUniqueOrThrow({ where: { id: reply.captain.id } });
    const commissionEntries = [
      {
        type: LedgerType.RIDER_COMMISSION,
        amountFils: reply.job.riderCommissionFils,
        idempotencyKey: `job:${reply.job.id}:rider`
      },
      {
        type: LedgerType.ORDER_COMMISSION,
        amountFils: reply.job.orderCommissionFils,
        idempotencyKey: `job:${reply.job.id}:order`
      }
    ].filter((entry) => entry.amountFils > 0);
    await tx.ledgerEntry.createMany({
      data: commissionEntries.map((entry) => ({
        captainId: captain.id,
        type: entry.type,
        amountFils: -entry.amountFils,
        balanceAfterFils: captain.balanceFils,
        description: describeJobPrice(reply.job.riderPriceDinars, reply.job.orderPriceDinars),
        reference: reply.job.id,
        idempotencyKey: entry.idempotencyKey
      }))
    });
    await tx.whatsAppJob.update({
      where: { id: reply.jobId },
      data: { status: JobStatus.CHARGED }
    });
    await tx.whatsAppReply.update({
      where: { id: reply.id },
      data: { status: ReplyStatus.CHARGED }
    });
    await tx.whatsAppReply.updateMany({
      where: { jobId: reply.jobId, id: { not: reply.id }, status: ReplyStatus.PENDING },
      data: { status: ReplyStatus.REJECTED }
    });
    return {
      result: "charged",
      amountFils: reply.job.commissionFils,
      balanceFils: captain.balanceFils,
      category: reply.job.category,
      priceDinars: reply.job.priceDinars,
      riderPriceDinars: reply.job.riderPriceDinars,
      orderPriceDinars: reply.job.orderPriceDinars
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function cancelChargedJob(replyMessageId: string, actorPhone: string): Promise<CancelResult> {
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

    const captain = await tx.captain.update({
      where: { id: reply.captain.id },
      data: { balanceFils: { increment: reply.job.commissionFils } }
    });
    await tx.ledgerEntry.create({
      data: {
        captainId: captain.id,
        type: LedgerType.ADJUSTMENT,
        amountFils: reply.job.commissionFils,
        balanceAfterFils: captain.balanceFils,
        description: `عكس ${describeJobPrice(reply.job.riderPriceDinars, reply.job.orderPriceDinars)} بواسطة ${actorPhone}`,
        reference: reply.job.id,
        idempotencyKey: `job-cancel:${reply.job.id}`
      }
    });
    return {
      result: "canceled",
      amountFils: reply.job.commissionFils,
      balanceFils: captain.balanceFils,
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
