import bcrypt from "bcryptjs";
import { JobCategory, Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { config } from "./config";
import { prisma } from "./db";
import { deleteGroupMessage, getGroupMessageSenderPhone, getInstancePhone, getGroupParticipants, greenApiRequest, resolveGroupSenderPhone, sendGroupMessage } from "./green-api";
import {
  hasSufficientCaptainReplyBalance,
  MINIMUM_CAPTAIN_REPLY_BALANCE_FILS,
  normalizePhone,
  phoneFromChatId
} from "./money";
import { cancelChargedJob, processJobReaction } from "./accounting";
import { calculateCommissionFils, extractPriceAfterLabel } from "./pricing";

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

  try {
    await processIncomingWebhook(incoming);
    res.sendStatus(200);
  } catch (error) {
    console.error("Green API webhook processing failed:", error);
    res.status(500).json({ error: "Webhook processing failed." });
  }
}

function normalizeIncomingWebhook(webhook: Webhook): Webhook | null {
  if (webhook.typeWebhook === "incomingMessageReceived") return webhook;
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
    console.warn(`Green API message ${messageId} was not checked: sender ID could not be mapped to a phone number.`);
    return;
  }
  if (isExcludedAdminPhone(senderPhone)) {
    return;
  }
  {
    const captain = await prisma.captain.findUnique({ where: { phone: senderPhone } });
    if (!captain || captain.status !== "ACTIVE" || captain.balanceFils < MINIMUM_CAPTAIN_REPLY_BALANCE_FILS) {
      console.warn(
        `Deleting Green API message ${messageId}: sender account is ${!captain ? "unregistered" : captain.status.toLowerCase()}, ` +
        `balance=${captain ? captain.balanceFils : "unknown"} fils.`
      );
      await deleteRejectedReplyMessage(messageId);
      const reason = !captain || captain.status !== "ACTIVE"
        ? "رقمك غير مسجل أو حسابك غير مفعل"
        : "رصيدك أقل من الحد الأدنى 0.75 د.أ";
      await sendGroupMessage(`⚠️ تم حذف رسالتك. ${reason}. اشحن رصيدك أو تواصل مع الإدارة.`);
      return;
    }
  }

  const text = messageText(data);
  if (!text) return;
  const sourceMessageId = quotedMessageId(data);
  if (isConfirmation(text) && sourceMessageId) {
    const job = await prisma.whatsAppJob.findUnique({
      where: { groupId_sourceMessageId: { groupId, sourceMessageId } }
    });
    if (!job || job.status !== "PENDING") return;

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
        await sendRejectedReplyNotice(rejection, job.priceDinars, job.commissionFils);
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
  if (!targetMessageId || !actor) return;

  if (normalizedReaction === "👍" || normalizedReaction === "👍🏻") {
    const reply = await prisma.whatsAppReply.findUnique({
      where: { messageId: targetMessageId },
      include: { job: { select: { id: true, sourceMessageId: true, sourceSenderPhone: true } } }
    });
    if (!reply) {
      console.warn(`Green API 👍 reaction ${webhook.idMessage ?? "unknown"} targets an untracked message ${targetMessageId}.`);
      return;
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
      console.warn(`Green API 👍 reaction ${webhook.idMessage ?? "unknown"} skipped: job owner could not be resolved.`);
      return;
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
    if (result.result === "charged") {
      await sendGroupMessage(
        `✅ تم اعتماد الطلب للكابتن ${result.captainName}. تم خصم عمولة ${formatJod(result.amountFils)} د.أ من رصيده وإضافتها إلى رصيد صاحب الطلب. رصيد الكابتن ${result.captainName} الآن ${formatJod(result.balanceFils)} د.أ.`
      );
      return;
    }

    if (result.result === "owner_unregistered") {
      console.warn(`WhatsApp job reply ${targetMessageId} was not charged: the job owner has no captain account.`);
      await sendGroupMessage("تعذر تحديد حساب صاحب الطلب، لذلك لم يتم خصم العمولة أو إضافتها لأي رصيد.");
      return;
    }

    if (result.result === "insufficient" || result.result === "unregistered") {
      await deleteRejectedReplyMessage(targetMessageId);
      await sendRejectedReplyNotice(result.result, result.priceDinars ?? 0, result.amountFils);
    }
    return;
  }

  if (normalizedReaction === "❌") {
    const reply = await prisma.whatsAppReply.findUnique({
      where: { messageId: targetMessageId },
      include: { job: { select: { sourceSenderPhone: true } } }
    });
    if (!reply) return;
    const isOwner = actor === reply.senderPhone || actor === reply.job.sourceSenderPhone;
    if (!isOwner && !(await isGroupAdministrator(actor))) return;

    const result = await cancelChargedJob(targetMessageId, actor);
    if (result.result !== "canceled") return;
    await sendGroupMessage(
      `❌ تم إلغاء الطلب ${formatJobPrice(result.orderPriceDinars, result.riderPriceDinars)} وإرجاع العمولة ${formatJod(result.amountFils)} د.أ إلى رصيد الكابتن.`
    );
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
  rejection: "insufficient" | "unregistered",
  priceDinars: number,
  commissionFils: number
): Promise<void> {
  const reason = rejection === "insufficient"
    ? "رصيدك غير كافٍ. الحد الأدنى المطلوب 0.75 د.أ"
    : "رقمك غير مسجل أو حسابك غير مفعل";
  await sendGroupMessage(
    `⚠️ ${reason}. قيمة الطلب ${priceDinars} د.أ وعمولته ${formatJod(commissionFils)} د.أ. يرجى التواصل مع الإدارة وشحن الرصيد لتتمكن من أخذ الطلبات.`
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

function formatJobPrice(orderPriceDinars: number, riderPriceDinars: number): string {
  const parts: string[] = [];
  if (orderPriceDinars > 0) parts.push(`أوردر ${orderPriceDinars} د.أ`);
  if (riderPriceDinars > 0) parts.push(`راكب ${riderPriceDinars} د.أ`);
  return `القيمة: ${parts.join(" + ")}`;
}
