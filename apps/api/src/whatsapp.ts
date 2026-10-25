import bcrypt from "bcryptjs";
import { JobCategory, Prisma, WebhookEventStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { config } from "./config";
import { prisma } from "./db";
import { deleteGroupMessage, fetchRecentIncomingMessages, getGroupMessageSenderPhone, getInstancePhone, getGroupParticipants, greenApiRequest, resolveGroupSenderPhone, sendGroupMessage } from "./green-api";
import {
  hasSufficientCaptainReplyBalance,
  MINIMUM_CAPTAIN_REPLY_BALANCE_FILS,
  normalizePhone,
  phoneFromChatId
} from "./money";
import { cancelChargedJob, processJobReaction } from "./accounting";
import { calculateCommissionFils, extractPriceAfterLabel } from "./pricing";
import { isCancellationReaction } from "./reactions";

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
    const terminal = ageMs >= 60 * 60 * 60 * 1000;
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
  if (isExcludedAdminPhone(senderPhone)) {
    return;
  }
  const text = messageText(data);
  if (!text) return;
  const sourceMessageId = quotedMessageId(data);
  const isCaptainConfirmation = isConfirmation(text) && Boolean(sourceMessageId);
  {
    const captain = await prisma.captain.findUnique({ where: { phone: senderPhone } });
    if (!captain || captain.status !== "ACTIVE") {
      if (isCaptainConfirmation && captain?.status === "PENDING_PROFILE") {
        throw new Error(`Captain ${senderPhone} must complete profile activation before confirmation ${messageId} can be processed.`);
      }
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

  if (isCaptainConfirmation && sourceMessageId) {
    const job = await prisma.whatsAppJob.findUnique({
      where: { groupId_sourceMessageId: { groupId, sourceMessageId } }
    });
    if (!job) throw new Error(`Source job ${sourceMessageId} for confirmation ${messageId} is not available yet.`);
    if (job.status !== "PENDING") return;

    if (!senderPhone) return;
    const captain = await prisma.captain.findUnique({ where: { phone: senderPhone } });
    await prisma.whatsAppReply.upsert({
      where: { messageId },
      update: {},
      create: {
        messageId,
        senderPhone,
        jobId: job.id,
        captainId: captain?.id,
        body: text
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

  const items = text.split(/\r?\n/).map((line) => {
    const priceDinars = extractPriceAfterLabel(line);
    return priceDinars === null ? null : { priceDinars, category: isOrder(line) ? JobCategory.ORDER : JobCategory.RIDER };
  }).filter((item) => item !== null);
  if (items.length === 0) return;
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
        groupId: chatId,
        sourceMessageId: messageId,
        sourceSenderPhone: senderPhone,
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
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
  const recognizedReaction = normalizedReaction === "👍" || normalizedReaction === "👍🏻" ||
    isCancellationReaction(normalizedReaction);
  if (recognizedReaction && (!targetMessageId || !actor)) {
    throw new Error(`Reaction ${webhook.idMessage ?? "unknown"} is missing its target message or actor.`);
  }
  if (!targetMessageId || !actor) return;

  if (normalizedReaction === "👍" || normalizedReaction === "👍🏻") {
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
    if (actor !== sourceSenderPhone) {
      console.warn(`Green API 👍 reaction ${webhook.idMessage ?? "unknown"} ignored: it was not sent by the job owner.`);
      return;
    }

    const result = await processJobReaction(targetMessageId);
    if (result.result === "not_tracked") return;
    if (result.result === "already_processed") {
      const storedReply = await prisma.whatsAppReply.findUnique({
        where: { messageId: targetMessageId },
        select: { status: true }
      });
      if (storedReply?.status === "REJECTED") await deleteRejectedReplyMessage(targetMessageId);
      return;
    }
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

  if (isCancellationReaction(normalizedReaction)) {
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
