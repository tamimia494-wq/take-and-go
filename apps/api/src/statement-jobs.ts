import { LedgerType, type Prisma } from "@prisma/client";
import { prisma } from "./db";

// The orders behind a captain's statement week: who posted each order (the producer, credited the commission) and
// who took it (the consumer, charged it), with the order text, the captain's reply and their times.

export type StatementParty = { name: string | null; phone: string | null };

export type StatementJob = {
  jobId: string;
  /** produced: the captain posted the order; consumed: the captain took it; both: they took their own order. */
  role: "produced" | "consumed" | "both";
  /** What the order changed in this captain's balance during the week: positive in, negative out. */
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
  /** When the commission moved for this captain, the newest movement in the week. */
  chargedAt: string;
  dispute: { id: string; status: string; reason: string; adminNote: string | null; createdAt: string } | null;
};

type WeekEntry = { reference: string | null; amountFils: number; createdAt: Date };

const COMMISSION_TYPES = [LedgerType.RIDER_COMMISSION, LedgerType.ORDER_COMMISSION];

/** Turns the week's ledger entries of one captain into one card per order, newest first. */
export async function loadStatementJobs(captainId: string, entries: WeekEntry[]): Promise<StatementJob[]> {
  const byJob = new Map<string, { amountFils: number; lastAt: Date }>();
  for (const entry of entries) {
    const reference = entry.reference;
    if (!reference || reference.startsWith("commission-transfer:") || reference.startsWith("withdrawal:")) continue;
    const current = byJob.get(reference) ?? { amountFils: 0, lastAt: entry.createdAt };
    current.amountFils += entry.amountFils;
    if (entry.createdAt > current.lastAt) current.lastAt = entry.createdAt;
    byJob.set(reference, current);
  }
  const jobIds = [...byJob.keys()];
  if (!jobIds.length) return [];

  const [jobs, commissionEntries, disputes] = await Promise.all([
    prisma.whatsAppJob.findMany({
      where: { id: { in: jobIds } },
      include: { replies: { select: { captainId: true, senderPhone: true, body: true, status: true, createdAt: true } } }
    }),
    prisma.ledgerEntry.findMany({
      where: { reference: { in: jobIds }, type: { in: COMMISSION_TYPES } },
      orderBy: { createdAt: "asc" },
      select: { reference: true, captainId: true, amountFils: true }
    }),
    prisma.statementDispute.findMany({ where: { captainId, jobId: { in: jobIds } } })
  ]);

  // The latest debit names the captain who took the order; the latest credit the owner who was paid.
  const consumerByJob = new Map<string, string>();
  const producerByJob = new Map<string, string>();
  for (const entry of commissionEntries) {
    if (!entry.reference) continue;
    (entry.amountFils < 0 ? consumerByJob : producerByJob).set(entry.reference, entry.captainId);
  }

  const missingText = jobs.filter((job) => !job.sourceText).map((job) => job.sourceMessageId);
  const storedMessages = missingText.length
    ? await prisma.whatsAppMessage.findMany({ where: { id: { in: missingText } }, select: { id: true, record: true } })
    : [];
  const storedText = new Map(storedMessages.map((message) => [message.id, recordText(message.record)]));

  const captainIds = new Set<string>([...consumerByJob.values(), ...producerByJob.values()]);
  const ownerPhones = jobs.map((job) => job.sourceSenderPhone).filter((phone): phone is string => Boolean(phone));
  const captains = await prisma.captain.findMany({
    where: { OR: [{ id: { in: [...captainIds] } }, { phone: { in: ownerPhones } }] },
    select: { id: true, phone: true, fullName: true }
  });
  const captainById = new Map(captains.map((captain) => [captain.id, captain]));
  const captainByPhone = new Map(captains.map((captain) => [captain.phone, captain]));
  const disputeByJob = new Map(disputes.map((dispute) => [dispute.jobId, dispute]));

  const cards = jobs.map((job): StatementJob => {
    const week = byJob.get(job.id)!;
    const consumerId = consumerByJob.get(job.id) ?? null;
    const producerId = producerByJob.get(job.id) ?? null;
    const consumer = consumerId ? captainById.get(consumerId) : undefined;
    const producer = (producerId ? captainById.get(producerId) : undefined) ??
      (job.sourceSenderPhone ? captainByPhone.get(job.sourceSenderPhone) : undefined);
    const reply = pickReply(job.replies, consumerId);
    const isConsumer = consumerId === captainId;
    const isProducer = producer?.id === captainId;
    const dispute = disputeByJob.get(job.id);
    return {
      jobId: job.id,
      role: isConsumer && isProducer ? "both" : isConsumer ? "consumed" : "produced",
      amountFils: week.amountFils,
      category: job.category,
      priceDinars: job.priceDinars,
      riderPriceDinars: job.riderPriceDinars,
      orderPriceDinars: job.orderPriceDinars,
      commissionFils: job.commissionFils,
      status: job.status,
      producer: { name: producer?.fullName ?? null, phone: producer?.phone ?? job.sourceSenderPhone },
      consumer: { name: consumer?.fullName ?? null, phone: consumer?.phone ?? reply?.senderPhone ?? null },
      orderText: job.sourceText ?? storedText.get(job.sourceMessageId) ?? null,
      orderAt: job.createdAt.toISOString(),
      replyText: reply?.body ?? null,
      replyAt: reply?.createdAt.toISOString() ?? null,
      chargedAt: week.lastAt.toISOString(),
      dispute: dispute
        ? { id: dispute.id, status: dispute.status, reason: dispute.reason, adminNote: dispute.adminNote, createdAt: dispute.createdAt.toISOString() }
        : null
    };
  });
  return cards.sort((left, right) => right.chargedAt.localeCompare(left.chargedAt));
}

type ReplyRow = { captainId: string | null; senderPhone: string; body: string; status: string; createdAt: Date };

/** The reply of the captain who took the order: the charged one, else their latest. */
function pickReply(replies: ReplyRow[], consumerId: string | null): ReplyRow | undefined {
  const own = consumerId ? replies.filter((reply) => reply.captainId === consumerId) : [];
  const pool = own.length ? own : replies.filter((reply) => reply.status === "CHARGED");
  return [...pool].sort((left, right) => {
    const rank = (reply: ReplyRow) => (reply.status === "CHARGED" ? 2 : reply.status === "CANCELED" ? 1 : 0);
    return rank(right) - rank(left) || right.createdAt.getTime() - left.createdAt.getTime();
  })[0];
}

function recordText(record: Prisma.JsonValue): string | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const text = (record as Record<string, unknown>).textMessage;
  return typeof text === "string" ? text : null;
}
