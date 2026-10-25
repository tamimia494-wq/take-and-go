import bcrypt from "bcryptjs";
import { JobCategory, Prisma, WebhookEventStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { config } from "./config";
import { prisma } from "./db";
import { deleteGroupMessage, fetchGroupHistory, fetchRecentIncomingMessages, getGroupMessageSenderPhone, getInstancePhone, getGroupParticipants, GreenApiRequestError, greenApiRequest, resolveGroupSenderPhone, sendGroupMessage } from "./green-api";
import {
  hasSufficientCaptainReplyBalance,
  MINIMUM_CAPTAIN_REPLY_BALANCE_FILS,
  normalizePhone,
  phoneFromChatId
} from "./money";
import { cancelChargedJob, processJobReaction, removeJobLike } from "./accounting";
import { calculateCommissionFils, extractPriceAfterLabel } from "./pricing";
import { isCancellationReaction, isLikeReaction } from "./reactions";

type Webhook = {
  typeWebhook?: string;
  idMessage?: string;
  timestamp?: number;
  senderData?: { chatId?: string; sender?: string };
  messageData?: Record<string, unknown>;
  // Green API journal records can also be replayed to this endpoint.
  type?: string;
  chatId?: string;
  senderId?: string;
  typeMessage?: string;
  textMessage?: string;
  isDeleted?: boolean;
};

export async function importGroupCaptains(): Promise<{ imported: number; total: number; skipped: string[] }> {
  const participantIds = await getGroupParticipants();
  const phones = new Set<string>();
  for (const id of participantIds) {
    const phone = phoneFromChatId(id);
    if (phone) phones.add(phone);
  }

  // استثناء رقم الـ Instance نفسه (صاحب الجروب/الإدارة) وأرقام الإدارة الإضافية
  const excluded = new Set<string>();
  const instancePhone = await getInstancePhone().catch(() => null);
  if (instancePhone) excluded.add(instancePhone);
  for (const raw of config.excludedAdminPhones) {
    try {
      excluded.add(normalizePhone(raw));
    } catch {
      // تجاهل القيم غير الصالحة في متغير البيئة
    }
  }
  for (const phone of excluded) phones.delete(phone);

  const passwordHash = await bcrypt.hash("123456", 12);
  const created = await prisma.captain.createMany({
    data: [...phones].map((phone) => ({ phone, passwordHash })),
    skipDuplicates: true
  });
  return { imported: created.count, total: phones.size, skipped: [...excluded] };
}

export async function receiveGreenApiWebhook(req: Request, res: Response): Promise<void> {
  if (!config.webhookToken || !config.greenApiGroupId) {
    res.status(503).json({ error: "Green API integration is not configured." });
    return;
  }
  const auth = req.header("authorization") ?? "";
  const token = auth.replace(/^(Bearer|Basic)\s+/i, "");
  if (token !== config.webhookToken) {
    res.status(401).json({ error: "Unauthorized webhook." });
    return;
  }
  const webhook = req.body as Webhook;
  const incoming = normalizeIncomingWebhook(webhook);
  if (!incoming) {
    res.sendStatus(200);
    return;
  }

  let event: { id: string; status: WebhookEventStatus };
  try {
    event = await prisma.whatsAppWebhookEvent.upsert({
      where: { eventId: incoming.idMessage! },
      create: {
        eventId: incoming.idMessage!,
        payload: incoming as Prisma.InputJsonValue
      },
      update: {},
      select: { id: true, status: true }
    });
  } catch (error) {
    console.error("Could not persist Green API webhook for processing:", error);
    res.status(503).json({ error: "Webhook could not be safely stored; please retry." });
    return;
  }
  if (event.status !== WebhookEventStatus.PROCESSED && event.status !== WebhookEventStatus.FAILED) {
    await processWebhookEvent(event.id);
  }
  res.sendStatus(200);
}

export async function retryPendingGreenApiWebhooks(): Promise<void> {
  const now = new Date();
  const pending = await prisma.whatsAppWebhookEvent.findMany({
    where: { OR: [
      { status: WebhookEventStatus.PENDING, nextAttemptAt: { lte: now } },
      { status: WebhookEventStatus.PROCESSING, lockedAt: { lt: new Date(now.getTime() - 2 * 60_000) } }
    ] },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { id: true }
  });
  for (const event of pending) {
    await processWebhookEvent(event.id);
  }
  await prisma.whatsAppWebhookEvent.deleteMany({
    where: {
      status: { in: [WebhookEventStatus.PROCESSED, WebhookEventStatus.FAILED] },
      updatedAt: { lt: new Date(now.getTime() - 3 * 24 * 60 * 60_000) }
    }
  });
}

async function processWebhookEvent(eventId: string): Promise<void> {
  const now = new Date();
  const claim = await prisma.whatsAppWebhookEvent.updateMany({
    where: {
      id: eventId,
      OR: [
        { status: WebhookEventStatus.PENDING, nextAttemptAt: { lte: now } },
        { status: WebhookEventStatus.PROCESSING, lockedAt: { lt: new Date(now.getTime() - 2 * 60_000) } }
      ]
    },
    data: {
      status: WebhookEventStatus.PROCESSING,
      lockedAt: now,
      attempts: { increment: 1 }
    }
  });
  if (claim.count !== 1) return;

  const event = await prisma.whatsAppWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
  try {
    await processIncomingWebhook(event.payload as Webhook);
    await prisma.whatsAppWebhookEvent.update({
      where: { id: eventId },
      data: { status: WebhookEventStatus.PROCESSED, lockedAt: null, lastError: null, payload: {} }
    });
  } catch (error) {
    const ageMs = Date.now() - event.createdAt.getTime();
    const terminal = ageMs >= 60 * 60 * 60 * 1000 ||
      (error instanceof GreenApiRequestError && error.status === 466);
    const backoffMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(event.attempts, 5));
    await prisma.whatsAppWebhookEvent.update({
      where: { id: eventId },
      data: {
        status: terminal ? WebhookEventStatus.FAILED : WebhookEventStatus.PENDING,
        lockedAt: null,
        nextAttemptAt: new Date(Date.now() + backoffMs),
        lastError: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        ...(terminal ? { payload: {} } : {})
      }
    });
    if (terminal) {
      console.error(`Green API webhook ${event.eventId} failed after its retry window:`, error);
    } else {
      console.warn(`Green API webhook ${event.eventId} will be retried:`, error);
    }
  }
}

export async function replayRecentMessages(minutes = 15): Promise<{ replayed: number; skipped: number }> {
  let history: unknown[] = [];
  try {
    history = await fetchRecentIncomingMessages(minutes);
  } catch (error) {
    console.error("Could not fetch chat history for replay:", error);
    return { replayed: 0, skipped: 0 };
  }
  let replayed = 0;
  let skipped = 0;
  for (const entry of [...history].reverse()) {
    const record = entry as Record<string, unknown>;
    const messageId = stringValue(record.idMessage);
    if (!messageId) { skipped += 1; continue; }
    try {
      const senderId = stringValue(record.senderId) ?? "";
      const text = stringValue(record.textMessage) ??
        stringValue(objectValue(record.textMessageData)?.textMessage) ??
        stringValue(objectValue(record.extendedTextMessageData)?.text);
      const messageData = {
        ...record,
        ...objectValue(record.messageData),
        typeMessage: stringValue(record.typeMessage) ?? stringValue(record.type),
        ...(text === undefined ? {} : {
          textMessageData: {
            ...objectValue(record.textMessageData),
            textMessage: text
          }
        })
      };
      const webhook: Webhook = {
        typeWebhook: "incomingMessageReceived",
        idMessage: messageId,
        timestamp: typeof record.timestamp === "number" ? record.timestamp : undefined,
        senderData: { chatId: config.greenApiGroupId, sender: senderId },
        messageData
      };
      const event = await prisma.whatsAppWebhookEvent.upsert({
        where: { eventId: messageId },
        create: { eventId: messageId, payload: webhook as Prisma.InputJsonValue },
        update: {},
        select: { id: true }
      });
      await prisma.whatsAppWebhookEvent.updateMany({
        where: { id: event.id, status: WebhookEventStatus.PENDING },
        data: { payload: webhook as Prisma.InputJsonValue }
      });
      await processWebhookEvent(event.id);
      replayed += 1;
    } catch (error) {
      skipped += 1;
      console.error(`Replay of message ${messageId} failed:`, error);
    }
  }
  console.log(`Chat history replay finished: ${replayed} processed, ${skipped} skipped.`);
  return { replayed, skipped };
}

/** Stores a group message with prices as a job. Returns false when it has no price or is already stored. */
async function recordJobFromMessage(
  groupId: string,
  messageId: string,
  senderPhone: string,
  text: string,
  createdAt?: Date
): Promise<boolean> {
  const items = text.split(/\r?\n/).map((line) => {
    const priceDinars = extractPriceAfterLabel(line);
    return priceDinars === null ? null : { priceDinars, category: isOrder(line) ? JobCategory.ORDER : JobCategory.RIDER };
  }).filter((item) => item !== null);
  if (items.length === 0) return false;
  const riderPriceDinars = items
    .filter((item) => item.category === JobCategory.RIDER)
    .reduce((sum, item) => sum + item.priceDinars, 0);
  const orderPriceDinars = items
    .filter((item) => item.category === JobCategory.ORDER)
    .reduce((sum, item) => sum + item.priceDinars, 0);
  const priceDinars = riderPriceDinars + orderPriceDinars;
  if (!Number.isSafeInteger(priceDinars) || priceDinars > 2_147_483_647) {
    throw new Error("The WhatsApp job price exceeds the supported range.");
  }
  const category = riderPriceDinars > 0 && orderPriceDinars > 0
    ? JobCategory.MIXED
    : orderPriceDinars > 0 ? JobCategory.ORDER : JobCategory.RIDER;
  const settings = await prisma.appSettings.findUnique({ where: { id: "default" } });
  if (!settings) throw new Error("Application settings have not been initialized.");
  const riderCommissionFils = calculateCommissionFils(
    items.filter((item) => item.category === JobCategory.RIDER).map((item) => item.priceDinars),
    settings.riderCommissionPerFiveFils
  );
  const orderCommissionFils = calculateCommissionFils(
    items.filter((item) => item.category === JobCategory.ORDER).map((item) => item.priceDinars),
    settings.orderCommissionPerFiveFils
  );
  const commissionFils = riderCommissionFils + orderCommissionFils;
  if (!Number.isSafeInteger(commissionFils) || commissionFils > 2_147_483_647) {
    throw new Error("The configured commission exceeds the supported range.");
  }

  try {
    await prisma.whatsAppJob.create({
      data: {
        groupId,
        sourceMessageId: messageId,
        sourceSenderPhone: senderPhone,
        ...(createdAt ? { createdAt } : {}),
        priceDinars,
        riderPriceDinars,
        orderPriceDinars,
        category,
        commissionFils,
        riderCommissionFils,
        orderCommissionFils
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
  return true;
}

/**
 * Rebuilds orders and "تم" confirmations that are still in the group but never reached the database, for example
 * when a webhook was lost. It never deletes messages or posts notices; messages the bot removed are skipped.
 */
async function recoverJobsAndRepliesFromHistory(
  history: Array<Record<string, unknown>>
): Promise<{ jobsRecorded: number; repliesRecorded: number }> {
  const groupId = config.greenApiGroupId;
  if (!groupId) return { jobsRecorded: 0, repliesRecorded: 0 };
  const oldestTimestamp = Date.now() / 1000 - 60 * 60 * 60;
  const messages = history
    .filter((entry) => stringValue(entry.type) === "incoming" && entry.isDeleted !== true)
    .filter((entry) => (stringValue(entry.typeMessage) ?? "") !== "reactionMessage")
    .filter((entry) => Number(entry.timestamp ?? 0) >= oldestTimestamp)
    .sort((left, right) => Number(left.timestamp ?? 0) - Number(right.timestamp ?? 0));
  let jobsRecorded = 0;
  let repliesRecorded = 0;
  for (const entry of messages) {
    const messageId = stringValue(entry.idMessage);
    const text = stringValue(entry.textMessage) ??
      stringValue(objectValue(entry.extendedTextMessage)?.text) ??
      stringValue(objectValue(entry.textMessageData)?.textMessage) ??
      stringValue(objectValue(entry.extendedTextMessageData)?.text);
    const senderId = stringValue(entry.senderId) ?? "";
    if (!messageId || !senderId) continue;
    const senderPhone = phoneFromChatId(senderId) ?? await resolveGroupSenderPhone(senderId);
    if (!senderPhone) continue;
    const captain = await prisma.captain.findUnique({ where: { phone: senderPhone }, select: { id: true, status: true } });
    if (!captain) continue;
    const sourceMessageId = stringValue(objectValue(entry.quotedMessage)?.stanzaId) ??
      stringValue(objectValue(entry.quotedMessage)?.idMessage) ??
      stringValue(objectValue(entry.extendedTextMessage)?.stanzaId);
    const createdAt = new Date(Number(entry.timestamp) * 1000);

    const job = sourceMessageId
      ? await prisma.whatsAppJob.findUnique({
        where: { groupId_sourceMessageId: { groupId, sourceMessageId } },
        select: { id: true }
      })
      : null;
    if (job) {
      // Replies from accounts that are not active are deleted live, and admins do not take orders.
      if (captain.status !== "ACTIVE" || isExcludedAdminPhone(senderPhone)) continue;
      const existing = await prisma.whatsAppReply.findUnique({ where: { messageId }, select: { id: true } });
      if (existing) continue;
      await prisma.whatsAppReply.create({
        data: {
          messageId,
          senderPhone,
          jobId: job.id,
          captainId: captain.id,
          body: text ?? `[${stringValue(entry.typeMessage) ?? "message"}]`,
          createdAt
        }
      });
      repliesRecorded += 1;
      continue;
    }
    if (!text || (captain.status !== "ACTIVE" && !isExcludedAdminPhone(senderPhone))) continue;
    if (await recordJobFromMessage(groupId, messageId, senderPhone, text, createdAt)) jobsRecorded += 1;
  }
  return { jobsRecorded, repliesRecorded };
}

/**
 * Recovers owner 👍 approvals from the group history, for likes that arrived before approvals were stored.
 * Only the latest reaction of each person on a reply counts, so a removed like or a later ❌ is not an approval.
 */
export async function backfillReplyApprovalsFromHistory(count = 300): Promise<{
  jobsRecorded: number;
  repliesRecorded: number;
  reactionsFound: number;
  approvalsRecorded: number;
}> {
  const history = await fetchGroupHistory(count);
  const { jobsRecorded, repliesRecorded } = await recoverJobsAndRepliesFromHistory(history);
  const latestReaction = new Map<string, { actor: string; targetMessageId: string; reaction: string; timestamp: number }>();
  const latestCancellation = new Map<string, { actor: string; timestamp: number }>();
  const reactions = history
    .filter((entry) => (stringValue(entry.typeMessage) ?? stringValue(entry.type)) === "reactionMessage")
    .sort((left, right) => Number(left.timestamp ?? 0) - Number(right.timestamp ?? 0));
  for (const entry of reactions) {
    const reactionData = objectValue(entry.reactionMessageData) ?? objectValue(entry.reactionMessage) ??
      objectValue(entry.extendedTextMessageData) ?? objectValue(entry.extendedTextMessage) ?? {};
    const reaction = (stringValue(reactionData.text) ?? stringValue(reactionData.reaction) ??
      stringValue(entry.textMessage) ?? "").replace(/\uFE0F/g, "").trim();
    const targetMessageId = stringValue(reactionData.stanzaId) ?? stringValue(reactionData.idMessage) ??
      stringValue(reactionData.targetMessageId) ?? stringValue(objectValue(entry.quotedMessage)?.stanzaId) ??
      stringValue(objectValue(entry.quotedMessage)?.idMessage);
    const senderId = stringValue(entry.senderId) ?? "";
    const actor = phoneFromChatId(senderId) ?? (senderId ? await resolveGroupSenderPhone(senderId) : null);
    if (!targetMessageId || !actor) continue;
    if (isCancellationReaction(reaction)) {
      latestCancellation.set(targetMessageId, { actor, timestamp: Number(entry.timestamp ?? 0) });
    }
    latestReaction.set(`${actor}|${targetMessageId}`, {
      actor,
      targetMessageId,
      reaction,
      timestamp: Number(entry.timestamp ?? 0)
    });
  }

  let approvalsRecorded = 0;
  for (const [targetMessageId, cancellation] of latestCancellation) {
    const reply = await prisma.whatsAppReply.findUnique({
      where: { messageId: targetMessageId },
      include: { job: { select: { sourceSenderPhone: true } } }
    });
    if (!reply) continue;
    const ownerReaction = reply.job.sourceSenderPhone
      ? [...latestReaction.values()].find((reaction) =>
        reaction.targetMessageId === targetMessageId && samePhone(reaction.actor, reply.job.sourceSenderPhone!))
      : undefined;
    // A fresh owner like after the ❌ wins.
    if (ownerReaction && isLikeReaction(ownerReaction.reaction) && ownerReaction.timestamp > cancellation.timestamp) continue;
    const authorized = [reply.senderPhone, reply.job.sourceSenderPhone].some((phone) => phone && samePhone(phone, cancellation.actor)) ||
      await isGroupAdministrator(cancellation.actor);
    if (!authorized) continue;
    if (reply.status === "CHARGED") {
      await cancelChargedJob(reply.messageId, cancellation.actor);
    } else if (reply.approvedAt) {
      await prisma.whatsAppReply.update({
        where: { id: reply.id },
        data: { approvedAt: null, approvedByPhone: null, likeRemovedAt: new Date(cancellation.timestamp * 1000) }
      });
    }
  }
  for (const { actor, targetMessageId, reaction, timestamp } of latestReaction.values()) {
    if (!isLikeReaction(reaction)) continue;
    const cancellation = latestCancellation.get(targetMessageId);
    if (cancellation && cancellation.timestamp >= timestamp) continue;
    const reply = await prisma.whatsAppReply.findUnique({
      where: { messageId: targetMessageId },
      include: { job: { select: { sourceSenderPhone: true } } }
    });
    if (!reply?.job.sourceSenderPhone || !samePhone(reply.job.sourceSenderPhone, actor)) continue;
    const likedAt = timestamp ? new Date(timestamp * 1000) : new Date();
    if (reply.likeRemovedAt && reply.likeRemovedAt >= likedAt) continue;
    const recorded = await prisma.whatsAppReply.updateMany({
      where: { id: reply.id, approvedAt: null },
      data: { approvedAt: likedAt, approvedByPhone: actor }
    });
    approvalsRecorded += recorded.count;
  }
  return { jobsRecorded, repliesRecorded, reactionsFound: reactions.length, approvalsRecorded };
}

const sweptMessageIds = new Set<string>();

/**
 * Deletes recent group messages that live processing missed: anything from a number without an active account,
 * and fresh messages the system never recorded from captains below the minimum balance.
 */
export async function sweepUnauthorizedMessages(count = 100): Promise<{ deleted: number }> {
  const groupId = config.greenApiGroupId;
  if (!groupId) return { deleted: 0 };
  const history = await fetchGroupHistory(count);
  const nowSeconds = Date.now() / 1000;
  let deleted = 0;
  for (const entry of history) {
    const messageId = stringValue(entry.idMessage);
    const senderId = stringValue(entry.senderId) ?? "";
    const timestamp = Number(entry.timestamp ?? 0);
    if (!messageId || !senderId || sweptMessageIds.has(messageId)) continue;
    if (stringValue(entry.type) !== "incoming" || entry.isDeleted === true) continue;
    if (stringValue(entry.typeMessage) === "reactionMessage" || stringValue(entry.typeMessage) === "deletedMessage") continue;
    if (nowSeconds - timestamp > 60 * 60 * 60) continue;
    const senderPhone = phoneFromChatId(senderId) ?? await resolveGroupSenderPhone(senderId);
    if (!senderPhone || isExcludedAdminPhone(senderPhone)) continue;
    const captain = await prisma.captain.findUnique({
      where: { phone: senderPhone },
      select: { status: true, balanceFils: true }
    });
    let unauthorized = !captain || captain.status !== "ACTIVE";
    if (!unauthorized && captain!.balanceFils < MINIMUM_CAPTAIN_REPLY_BALANCE_FILS && nowSeconds - timestamp <= 10 * 60) {
      // A charged captain's balance can drop after a valid message, so only messages the system never recorded count.
      const [job, reply] = await Promise.all([
        prisma.whatsAppJob.findUnique({ where: { groupId_sourceMessageId: { groupId, sourceMessageId: messageId } }, select: { id: true } }),
        prisma.whatsAppReply.findUnique({ where: { messageId }, select: { id: true } })
      ]);
      unauthorized = !job && !reply;
    }
    if (!unauthorized) continue;
    try {
      await deleteGroupMessage(messageId);
      deleted += 1;
    } catch (error) {
      console.warn(`Sweep could not delete message ${messageId}:`, error);
    }
    sweptMessageIds.add(messageId);
  }
  if (sweptMessageIds.size > 5000) sweptMessageIds.clear();
  return { deleted };
}

function normalizeIncomingWebhook(webhook: Webhook): Webhook | null {
  if (webhook.typeWebhook === "incomingMessageReceived") return webhook.idMessage ? webhook : null;
  if (webhook.type !== "incoming" || webhook.isDeleted || !webhook.idMessage || !webhook.chatId) return null;
  return {
    typeWebhook: "incomingMessageReceived",
    idMessage: webhook.idMessage,
    timestamp: webhook.timestamp,
    senderData: { chatId: webhook.chatId, sender: webhook.senderId },
    messageData: {
      typeMessage: webhook.typeMessage,
      ...(webhook.textMessage === undefined ? {} : { textMessageData: { textMessage: webhook.textMessage } })
    }
  };
}

async function processIncomingWebhook(webhook: Webhook): Promise<void> {
  const groupId = config.greenApiGroupId;
  const chatId = webhook.senderData?.chatId;
  const data = webhook.messageData;
  const messageId = webhook.idMessage;
  if (!groupId || chatId !== groupId || !data || !messageId) return;

  if (typeof webhook.timestamp === "number") {
    const ageMs = Date.now() - webhook.timestamp * 1000;
    const allParticipantsDeleteWindowMs = 60 * 60 * 60 * 1000;
    if (ageMs > allParticipantsDeleteWindowMs) {
      console.warn(`Skipping Green API message ${messageId}: it is older than WhatsApp's 60-hour delete window.`);
      return;
    }
    if (ageMs < -5 * 60 * 1000) {
      console.warn(`Skipping Green API message ${messageId}: its timestamp is more than 5 minutes in the future.`);
      return;
    }
  }

  const type = stringValue(data.typeMessage);
  if (type === "reactionMessage") {
    await handleReaction(webhook, data);
    return;
  }

  const senderId = webhook.senderData?.sender ?? webhook.senderData?.chatId ?? "";
  const senderPhone = phoneFromChatId(senderId) ?? (senderId ? await resolveGroupSenderPhone(senderId) : null);
  if (!senderPhone) {
    throw new Error(`Sender ID for Green API message ${messageId} could not be mapped to a phone number yet.`);
  }
  const text = messageText(data);
  const sourceMessageId = quotedMessageId(data);
  // Any reply to an order counts, whatever it says; the owner's 👍 on it is what charges the commission.
  const quotedJob = sourceMessageId
    ? await prisma.whatsAppJob.findUnique({ where: { groupId_sourceMessageId: { groupId, sourceMessageId } } })
    : null;
  if (sourceMessageId && !quotedJob && text && isConfirmation(text)) {
    throw new Error(`Source job ${sourceMessageId} for confirmation ${messageId} is not available yet.`);
  }
  const isCaptainConfirmation = Boolean(quotedJob);
  // Admin numbers are never deleted or balance-checked, but an admin who also has a captain account still posts
  // orders that earn them the commission.
  const excludedAdmin = isExcludedAdminPhone(senderPhone);
  if (excludedAdmin) {
    if (isCaptainConfirmation) return;
    const adminCaptain = await prisma.captain.findUnique({ where: { phone: senderPhone }, select: { id: true } });
    if (!adminCaptain) return;
  }
  if (!excludedAdmin) {
    const captain = await prisma.captain.findUnique({ where: { phone: senderPhone } });
    if (!captain || captain.status !== "ACTIVE") {
      console.warn(
        `Deleting Green API message ${messageId}: sender account is ${!captain ? "unregistered" : captain.status.toLowerCase()}, ` +
        `balance=${captain?.balanceFils ?? "unknown"} fils.`
      );
      await deleteRejectedReplyMessage(messageId);
      await sendGroupMessage("⚠️ تم حذف رسالتك. رقمك غير مسجل أو حسابك غير مفعل. تواصل مع الإدارة.");
      return;
    }
    if (captain.balanceFils < MINIMUM_CAPTAIN_REPLY_BALANCE_FILS) {
      console.warn(`Deleting Green API message ${messageId}: captain balance=${captain.balanceFils} fils is below the minimum.`);
      await deleteRejectedReplyMessage(messageId);
      return;
    }
  }
  if (!text && !quotedJob) return;

  if (quotedJob) {
    // Replies to a job that is already taken are kept too, so the job can move to them if the owner's like moves.
    const job = quotedJob;
    const captain = await prisma.captain.findUnique({ where: { phone: senderPhone } });
    await prisma.whatsAppReply.upsert({
      where: { messageId },
      update: {},
      create: {
        messageId,
        senderPhone,
        jobId: job.id,
        captainId: captain?.id,
        body: text ?? `[${stringValue(data.typeMessage) ?? "message"}]`
      }
    });
    const rejection = !captain || captain.status !== "ACTIVE"
      ? "unregistered"
      : !hasSufficientCaptainReplyBalance(captain.balanceFils, job.commissionFils) ? "insufficient" : null;
    if (rejection) {
      const rejectedReply = await prisma.whatsAppReply.updateMany({
        where: { messageId, status: "PENDING" },
        data: { status: "REJECTED" }
      });
      if (rejectedReply.count === 1) {
        await deleteRejectedReplyMessage(messageId);
        if (rejection === "unregistered") {
          await sendRejectedReplyNotice(job.priceDinars, job.commissionFils);
        }
      }
    }
    return;
  }

  if (text) await recordJobFromMessage(chatId, messageId, senderPhone, text);
}

async function handleReaction(webhook: Webhook, data: Record<string, unknown>): Promise<void> {
  const reactionData = objectValue(data.reactionMessageData) ?? objectValue(data.extendedTextMessageData) ?? {};
  const reaction = stringValue(reactionData.text) ?? stringValue(reactionData.reaction);
  const normalizedReaction = reaction?.replace(/\uFE0F/g, "");
  const actorId = webhook.senderData?.sender ?? webhook.senderData?.chatId ?? "";
  const actor = phoneFromChatId(actorId) ?? (actorId ? await resolveGroupSenderPhone(actorId) : null);
  const targetMessageId =
    stringValue(reactionData.stanzaId) ??
    stringValue(reactionData.idMessage) ??
    stringValue(reactionData.targetMessageId) ??
    stringValue(objectValue(data.quotedMessage)?.stanzaId) ??
    stringValue(objectValue(data.quotedMessage)?.idMessage);
  const recognizedReaction = isLikeReaction(normalizedReaction) ||
    isCancellationReaction(normalizedReaction);
  if (recognizedReaction && (!targetMessageId || !actor)) {
    throw new Error(`Reaction ${webhook.idMessage ?? "unknown"} is missing its target message or actor.`);
  }
  if (!targetMessageId || !actor) return;

  if (isLikeReaction(normalizedReaction)) {
    const reply = await prisma.whatsAppReply.findUnique({
      where: { messageId: targetMessageId },
      include: { job: { select: { id: true, sourceMessageId: true, sourceSenderPhone: true } } }
    });
    if (!reply) {
      throw new Error(`Target reply ${targetMessageId} for 👍 reaction ${webhook.idMessage ?? "unknown"} is not available yet.`);
    }
    let sourceSenderPhone = reply.job.sourceSenderPhone;
    if (!sourceSenderPhone) {
      try {
        sourceSenderPhone = await getGroupMessageSenderPhone(reply.job.sourceMessageId);
        if (sourceSenderPhone) {
          await prisma.whatsAppJob.updateMany({
            where: { id: reply.job.id, sourceSenderPhone: null },
            data: { sourceSenderPhone }
          });
        }
      } catch (error) {
        console.error(`Could not recover owner of WhatsApp job ${reply.job.id} from Green API history:`, error);
      }
    }
    if (!sourceSenderPhone) {
      throw new Error(`Owner phone for job ${reply.job.id} could not be resolved yet.`);
    }
    if (!samePhone(actor, sourceSenderPhone)) {
      console.warn(`Green API 👍 reaction ${webhook.idMessage ?? "unknown"} ignored: it was not sent by the job owner.`);
      return;
    }
    // Keep the owner's approval so an audit can still charge this reply if the charge below does not go through.
    await prisma.whatsAppReply.updateMany({
      where: { id: reply.id, approvedAt: null },
      data: { approvedAt: new Date(), approvedByPhone: actor }
    });

    const result = await processJobReaction(targetMessageId);
    if (result.result === "not_tracked") return;
    if (result.result === "already_processed") return;
    if (result.result === "charged") return;

    if (result.result === "owner_unregistered") {
      console.warn(`WhatsApp job reply ${targetMessageId} was not charged: the job owner has no captain account.`);
      return;
    }

    if (result.result === "insufficient" || result.result === "unregistered") {
      await deleteRejectedReplyMessage(targetMessageId);
      if (result.result === "unregistered") {
        await sendRejectedReplyNotice(result.priceDinars ?? 0, result.amountFils);
      }
    }
    return;
  }

  if (!isCancellationReaction(normalizedReaction)) {
    const reply = await prisma.whatsAppReply.findUnique({
      where: { messageId: targetMessageId },
      include: { job: { select: { sourceSenderPhone: true } } }
    });
    if (!reply?.job.sourceSenderPhone || !samePhone(reply.job.sourceSenderPhone, actor)) return;
    if (!reply.approvedAt && reply.status !== "CHARGED") return;
    await prisma.whatsAppReply.update({ where: { id: reply.id }, data: { likeRemovedAt: new Date() } });
    const result = await removeJobLike(targetMessageId);
    if (result.result === "transferred") {
      console.info(`WhatsApp job ${reply.jobId} moved from captain ${result.fromCaptainId} to ${result.toCaptainId} after the owner removed 👍.`);
    } else if (result.result === "released") {
      console.info(`WhatsApp job ${reply.jobId} was refunded to captain ${result.fromCaptainId}; no other reply has the owner's 👍.`);
    }
    return;
  }

  {
    let reply = await prisma.whatsAppReply.findUnique({
      where: { messageId: targetMessageId },
      include: { job: { select: { id: true, sourceMessageId: true, sourceSenderPhone: true } } }
    });
    if (!reply) {
      const matchingReplies = await prisma.whatsAppReply.findMany({
        where: {
          job: {
            groupId: config.greenApiGroupId!,
            sourceMessageId: targetMessageId
          },
          status: { in: ["CHARGED", "CANCELED"] }
        },
        include: { job: { select: { id: true, sourceMessageId: true, sourceSenderPhone: true } } },
        take: 2
      });
      if (matchingReplies.length === 1) {
        [reply] = matchingReplies;
      } else {
        throw new Error(
          `Target ${targetMessageId} for X reaction ${webhook.idMessage ?? "unknown"} is not available yet.`
        );
      }
    }
    const isOwnerOrReplyingCaptain = [reply.senderPhone, reply.job.sourceSenderPhone]
      .some((phone) => phone && samePhone(phone, actor));
    if (!isOwnerOrReplyingCaptain && !(await isGroupAdministrator(actor))) {
      console.warn(`Green API X reaction ${webhook.idMessage ?? "unknown"} ignored: actor is not authorized.`);
      return;
    }

    const result = await cancelChargedJob(reply.messageId, actor);
    if (result.result === "canceled") {
      console.info(`WhatsApp job ${reply.job.id} commission was reversed after an authorized X reaction.`);
    } else if (result.result === "not_charged") {
      console.warn(`WhatsApp job ${reply.job.id} was not reversed after X: it was not charged.`);
      await prisma.whatsAppReply.updateMany({
        where: { id: reply.id },
        data: { approvedAt: null, approvedByPhone: null, likeRemovedAt: new Date() }
      });
    }
  }
}

function samePhone(left: string, right: string): boolean {
  try {
    return normalizePhone(left) === normalizePhone(right);
  } catch {
    return false;
  }
}

async function isGroupAdministrator(phone: string): Promise<boolean> {
  const data = await greenApiRequest<{ participants?: Array<{ id?: string; participantId?: string; phoneNumber?: string; isAdmin?: boolean; isSuperAdmin?: boolean }> }>(
    "getGroupData",
    { groupId: config.greenApiGroupId }
  );
  return (data.participants ?? []).some((participant) => {
    const id = participant.phoneNumber?.trim() || participant.id || participant.participantId || "";
    return phoneFromChatId(id) === phone && (participant.isAdmin === true || participant.isSuperAdmin === true);
  });
}

function messageText(data: Record<string, unknown>): string | null {
  const textData = objectValue(data.textMessageData);
  const extendedData = objectValue(data.extendedTextMessageData);
  return stringValue(textData?.textMessage) ?? stringValue(extendedData?.text) ?? null;
}

function quotedMessageId(data: Record<string, unknown>): string | null {
  const extended = objectValue(data.extendedTextMessageData);
  const candidates = [
    stringValue(extended?.stanzaId),
    stringValue(extended?.quotedMessageId),
    stringValue(objectValue(extended?.contextInfo)?.stanzaId),
    stringValue(objectValue(data.quotedMessage)?.idMessage),
    stringValue(objectValue(data.quotedMessage)?.stanzaId)
  ];
  return candidates.find(Boolean) ?? null;
}

async function deleteRejectedReplyMessage(messageId: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await deleteGroupMessage(messageId);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof GreenApiRequestError && error.status === 466) break;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  console.error(`Green API could not delete rejected captain message ${messageId} after 5 attempts:`, lastError);
  throw new Error("Could not delete rejected captain reply from the WhatsApp group.", { cause: lastError });
}

function isExcludedAdminPhone(phone: string): boolean {
  return [config.adminContactPhone, ...config.excludedAdminPhones]
    .some((value) => phoneFromChatId(value) === phone);
}

async function sendRejectedReplyNotice(
  priceDinars: number,
  commissionFils: number
): Promise<void> {
  await sendGroupMessage(
    `⚠️ رقمك غير مسجل أو حسابك غير مفعل. قيمة الطلب ${priceDinars} د.أ وعمولته ${formatJod(commissionFils)} د.أ. يرجى التواصل مع الإدارة وشحن الرصيد لتتمكن من أخذ الطلبات.`
  );
}

function isOrder(text: string): boolean {
  const normalized = text
    .replace(/[أإآ]/g, "ا")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إ]/g, "ا");
  return /(?:ال)?اوردر(?:ين|ات)?/i.test(normalized);
}

function isConfirmation(text: string): boolean {
  return text.trim().replace(/[!؟?.,،؛\s]/g, "") === "تم";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function formatJod(fils: number): string {
  return (fils / 1000).toFixed(3).replace(/\.?0+$/, "");
}
