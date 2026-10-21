import { JobCategory, JobStatus, LedgerType, Prisma, ReplyStatus } from "@prisma/client";
import { prisma } from "./db";

type ProcessResult =
  | { result: "charged"; amountFils: number; balanceFils: number; category: JobCategory; priceDinars: number }
  | { result: "insufficient" | "unregistered" | "already_processed" | "not_tracked"; amountFils: number; category?: JobCategory; priceDinars?: number };

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
    const entryType = reply.job.category === JobCategory.ORDER
      ? LedgerType.ORDER_COMMISSION
      : LedgerType.RIDER_COMMISSION;
    await tx.ledgerEntry.create({
      data: {
        captainId: captain.id,
        type: entryType,
        amountFils: -reply.job.commissionFils,
        balanceAfterFils: captain.balanceFils,
        description: `عمولة ${reply.job.category === JobCategory.ORDER ? "أوردر" : "راكب"} بقيمة ${reply.job.priceDinars} د.أ`,
        reference: reply.job.id,
        idempotencyKey: `job:${reply.job.id}`
      }
    });
    await tx.whatsAppJob.update({
      where: { id: reply.jobId },
      data: { status: JobStatus.CHARGED }
    });
    await tx.whatsAppReply.update({
      where: { id: reply.id },
      data: { status: ReplyStatus.CHARGED }
    });
    return {
      result: "charged",
      amountFils: reply.job.commissionFils,
      balanceFils: captain.balanceFils,
      category: reply.job.category,
      priceDinars: reply.job.priceDinars
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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
