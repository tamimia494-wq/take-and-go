import { Prisma } from "@prisma/client";
import { prisma } from "./db";

// Baileys only delivers messages as they arrive and keeps no history, so every group message the link sees is kept
// here for 3 days, in the journal shape the recovery code reads: idMessage, senderId, timestamp, typeMessage,
// textMessage, quotedMessage.stanzaId and reactionMessageData.

export type JournalRecord = Record<string, unknown>;

const KEEP_MS = 3 * 24 * 60 * 60_000;

export async function saveGroupMessage(id: string, participant: string, timestamp: number, record: JournalRecord): Promise<void> {
  await prisma.whatsAppMessage.upsert({
    where: { id },
    create: { id, participant, timestamp, record: record as Prisma.InputJsonValue },
    update: {}
  });
}

/** Marks a message deleted, by the bot or by its sender, so recovery never brings it back. */
export async function markGroupMessageDeleted(id: string): Promise<void> {
  await prisma.whatsAppMessage.updateMany({ where: { id }, data: { isDeleted: true } });
}

/** The newest `count` stored group messages, newest first. */
export async function fetchGroupHistory(count: number): Promise<JournalRecord[]> {
  const rows = await prisma.whatsAppMessage.findMany({ orderBy: { timestamp: "desc" }, take: count });
  return rows.map(toJournal);
}

export async function fetchGroupMessage(id: string): Promise<JournalRecord | null> {
  const row = await prisma.whatsAppMessage.findUnique({ where: { id } });
  return row ? toJournal(row) : null;
}

/** The WhatsApp id of a message's sender, needed to delete it for everyone. */
export async function storedMessageParticipant(id: string): Promise<string | null> {
  const row = await prisma.whatsAppMessage.findUnique({ where: { id }, select: { participant: true } });
  return row?.participant ?? null;
}

export async function pruneGroupMessages(): Promise<void> {
  await prisma.whatsAppMessage.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_MS) } } });
}

function toJournal(row: { record: Prisma.JsonValue; isDeleted: boolean }): JournalRecord {
  const record = typeof row.record === "object" && row.record !== null && !Array.isArray(row.record)
    ? row.record as JournalRecord
    : {};
  return { ...record, isDeleted: row.isDeleted };
}
