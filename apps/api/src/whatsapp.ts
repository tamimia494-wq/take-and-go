import bcrypt from "bcryptjs";
import { JobCategory, Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { config } from "./config";
import { prisma } from "./db";
import { deleteGroupMessage, getInstancePhone, getGroupParticipants, greenApiRequest, sendGroupMessage } from "./green-api";
import { normalizePhone, phoneFromChatId } from "./money";
import { cancelChargedJob, processJobReaction } from "./accounting";
import { calculateCommissionFils, extractPriceAfterLabel } from "./pricing";

type Webhook = {
  typeWebhook?: string;
  idMessage?: string;
  senderData?: { chatId?: string; sender?: string };
  messageData?: Record<string, unknown>;
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
  if (webhook.typeWebhook !== "incomingMessageReceived") {
    res.sendStatus(200);
    return;
  }

  try {
    await processIncomingWebhook(webhook);
    res.sendStatus(200);
  } catch (error) {
    console.error("Green API webhook processing failed:", error);
    res.status(500).json({ error: "Webhook processing failed." });
  }
}

async function processIncomingWebhook(webhook: Webhook): Promise<void> {
  const groupId = config.greenApiGroupId;
  const chatId = webhook.senderData?.chatId;
  const data = webhook.messageData;
  const messageId = webhook.idMessage;
  if (!groupId || chatId !== groupId || !data || !messageId) return;

  const type = stringValue(data.typeMessage);
  if (type === "reactionMessage") {
    await handleReaction(webhook, data);
    return;
  }

  const text = messageText(data);
  if (!text) return;
  const sourceMessageId = quotedMessageId(data);
  if (isConfirmation(text) && sourceMessageId) {
    const job = await prisma.whatsAppJob.findUnique({
      where: { groupId_sourceMessageId: { groupId, sourceMessageId } }
    });
    if (!job || job.status !== "PENDING") return;

    const senderPhone = phoneFromChatId(webhook.senderData?.sender ?? "");
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
      : captain.balanceFils < Math.max(job.commissionFils, 750) ? "insufficient" : null;
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
        sourceSenderPhone: phoneFromChatId(webhook.senderData?.sender ?? "") ?? undefined,
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
  const reactionData = objectValue(data.reactionMessageData) ?? {};
  const reaction = stringValue(reactionData.text) ?? stringValue(reactionData.reaction);
  const normalizedReaction = reaction?.replace(/\uFE0F/g, "");
  const actor = phoneFromChatId(webhook.senderData?.sender ?? "");
  const targetMessageId =
    stringValue(reactionData.stanzaId) ??
    stringValue(reactionData.idMessage) ??
    stringValue(reactionData.targetMessageId);
  if (!targetMessageId || !actor) return;

  if (normalizedReaction === "👍" || normalizedReaction === "👍🏻") {
    const reply = await prisma.whatsAppReply.findUnique({
      where: { messageId: targetMessageId },
      include: { job: { select: { sourceSenderPhone: true } } }
    });
    if (!reply || !reply.job.sourceSenderPhone || actor !== reply.job.sourceSenderPhone) return;

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
        `✅ تم اعتماد الطلب للكابتن. ${formatJobPrice(result.orderPriceDinars, result.riderPriceDinars)}. العمولة ${formatJod(result.amountFils)} د.أ. الرصيد المتبقي ${formatJod(result.balanceFils)} د.أ.`
      );
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
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await deleteGroupMessage(messageId);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  console.error(`Green API could not delete rejected captain reply ${messageId} after 3 attempts:`, lastError);
  throw new Error("Could not delete rejected captain reply from the WhatsApp group.", { cause: lastError });
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
