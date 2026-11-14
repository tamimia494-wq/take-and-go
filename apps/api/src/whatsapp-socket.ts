import type { AuthenticationCreds, SignalDataTypeMap, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { config } from "./config";
import { prisma } from "./db";
import { markGroupMessageDeleted, saveGroupMessage, storedMessageParticipant } from "./message-store";

// The direct WhatsApp Web connection (Baileys) for the bot number: the only link to WhatsApp. Group messages come in
// through it, are kept in the message store and go through the processing pipeline; sending, deleting messages and
// removing members go out through it. It starts once an admin links it from the dashboard with a QR code.

type Baileys = typeof import("@whiskeysockets/baileys");
type IncomingWebhook = {
  typeWebhook: "incomingMessageReceived";
  idMessage: string;
  timestamp?: number;
  senderData: { chatId: string; sender: string };
  messageData: Record<string, unknown>;
};
export type SocketStatus = "not_linked" | "connecting" | "waiting_for_qr" | "connected" | "logged_out";

// Baileys is an ES module; a plain import() keeps it loadable from this CommonJS build on any Node version.
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Baileys>;

let baileys: Baileys | null = null;
let socket: WASocket | null = null;
let status: SocketStatus = "not_linked";
let lastQr: string | null = null;
let lastError: string | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let incomingHandler: ((webhook: IncomingWebhook) => Promise<void>) | null = null;
const participantByMessageId = new Map<string, string>();

type SocketLogger = {
  level: string;
  child(obj: Record<string, unknown>): SocketLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

const quietLogger: SocketLogger = {
  level: "warn",
  child: () => quietLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: (obj, msg) => console.warn("[whatsapp-socket]", msg ?? "", obj instanceof Error ? obj.message : ""),
  error: (obj, msg) => console.error("[whatsapp-socket]", msg ?? "", obj instanceof Error ? obj.message : "")
};

export function onSocketGroupMessage(handler: (webhook: IncomingWebhook) => Promise<void>): void {
  incomingHandler = handler;
}

/** The sender of a group message is needed to delete it for everyone. */
export function rememberMessageParticipant(messageId: string, senderId: string, overwrite = false): void {
  if (!messageId || !senderId || (!overwrite && participantByMessageId.has(messageId))) return;
  participantByMessageId.set(messageId, senderId.replace(/@c\.us$/, "@s.whatsapp.net"));
  if (participantByMessageId.size > 10_000) {
    const oldest = participantByMessageId.keys().next().value;
    if (oldest) participantByMessageId.delete(oldest);
  }
}

export function isSocketConnected(): boolean {
  return status === "connected" && socket !== null;
}

export function getSocketState(): { status: SocketStatus; qr: string | null; phone: string | null; error: string | null } {
  const userId = socket?.user?.id ?? null;
  return { status, qr: lastQr, phone: userId ? userId.split(":")[0]!.split("@")[0]! : null, error: lastError };
}

export class WhatsAppNotConnectedError extends Error {
  constructor() {
    super("WhatsApp is not linked or not connected. Link the bot number from the admin dashboard (QR).");
    this.name = "WhatsAppNotConnectedError";
  }
}

function connectedSocket(): { sock: WASocket; groupId: string } {
  if (!socket || status !== "connected") throw new WhatsAppNotConnectedError();
  if (!config.whatsappGroupId) throw new Error("WHATSAPP_GROUP_ID is not set.");
  return { sock: socket, groupId: config.whatsappGroupId };
}

/** Deletes a group message for everyone. Throws when the sender of the message is unknown. */
export async function deleteViaSocket(messageId: string): Promise<void> {
  const { sock, groupId } = connectedSocket();
  const participant = participantByMessageId.get(messageId) ?? await storedMessageParticipant(messageId);
  if (!participant) throw new Error(`The sender of message ${messageId} is unknown, so it cannot be deleted.`);
  await sock.sendMessage(groupId, { delete: { remoteJid: groupId, id: messageId, participant, fromMe: false } });
  await markGroupMessageDeleted(messageId);
}

export type SocketGroupParticipant = { ids: string[]; isAdmin: boolean };
const PARTICIPANTS_CACHE_MS = 60_000;
let participantsCache: { at: number; participants: SocketGroupParticipant[] } | null = null;

/** Group members read from WhatsApp, cached for a minute; `fresh` skips the cache. */
export async function getGroupParticipantsViaSocket(fresh = false): Promise<SocketGroupParticipant[]> {
  if (!fresh && participantsCache && Date.now() - participantsCache.at < PARTICIPANTS_CACHE_MS) return participantsCache.participants;
  const { sock, groupId } = connectedSocket();
  const metadata = await sock.groupMetadata(groupId);
  // The group creator counts as an admin even if WhatsApp no longer marks them as one.
  const ownerIds = new Set([metadata.owner, metadata.ownerJid].filter((id): id is string => Boolean(id)));
  const participants = metadata.participants.map((participant) => {
    const ids = [participant.jid, participant.id, participant.lid].filter((id): id is string => Boolean(id));
    return {
      ids,
      isAdmin: Boolean(participant.admin || participant.isAdmin || participant.isSuperAdmin || ids.some((id) => ownerIds.has(id)))
    };
  });
  participantsCache = { at: Date.now(), participants };
  return participants;
}

export type ParticipantUpdateResult = { done: string[]; failed: Array<{ phone: string; status: string }> };

/**
 * Adds or removes members, many per WhatsApp request. Returns the phones WhatsApp confirmed and, for the others,
 * the status it answered with (403: their privacy blocks being added, 409: already a member, 408: they left recently).
 */
export async function updateParticipantsViaSocket(phones: string[], action: "add" | "remove"): Promise<ParticipantUpdateResult> {
  const { sock, groupId } = connectedSocket();
  const done: string[] = [];
  const failed: Array<{ phone: string; status: string }> = [];
  for (let start = 0; start < phones.length; start += 50) {
    const chunk = phones.slice(start, start + 50);
    const results = await sock.groupParticipantsUpdate(groupId, chunk.map((phone) => `${phone}@s.whatsapp.net`), action);
    chunk.forEach((phone, index) => {
      // In a LID-addressed group WhatsApp may answer with the anonymous id; then the answers follow the request order.
      const result = results.find((item) => item.jid?.split("@")[0]?.split(":")[0] === phone) ??
        (results.length === chunk.length ? results[index] : undefined);
      if (result?.status === "200") done.push(phone);
      else failed.push({ phone, status: result?.status ?? "no answer" });
    });
  }
  participantsCache = null;
  return { done, failed };
}

export async function sendPrivateViaSocket(phone: string, message: string): Promise<void> {
  const { sock } = connectedSocket();
  await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: message });
}

export async function sendViaSocket(message: string): Promise<void> {
  const { sock, groupId } = connectedSocket();
  await sock.sendMessage(groupId, { text: message });
}

export async function hasStoredSession(): Promise<boolean> {
  const creds = await prisma.whatsAppAuthKey.findUnique({ where: { id: "creds" }, select: { value: true } });
  if (!creds) return false;
  try {
    return Boolean((JSON.parse(creds.value) as { registered?: boolean; me?: unknown }).me);
  } catch {
    return false;
  }
}

export async function startWhatsAppSocket(): Promise<void> {
  if (socket || status === "connecting") return;
  status = "connecting";
  lastError = null;
  try {
    baileys ??= await importEsm("@whiskeysockets/baileys");
    await connect(baileys);
  } catch (error) {
    status = "not_linked";
    lastError = error instanceof Error ? error.message : String(error);
    console.error("WhatsApp socket could not start:", error);
  }
}

export async function logoutWhatsAppSocket(): Promise<void> {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const current = socket;
  socket = null;
  try {
    await current?.logout();
  } catch (error) {
    console.warn("WhatsApp socket logout failed:", error);
  }
  await prisma.whatsAppAuthKey.deleteMany({});
  status = "logged_out";
  lastQr = null;
}

async function connect(lib: Baileys): Promise<void> {
  const { state, saveCreds } = await useDatabaseAuthState(lib);
  const { version } = await lib.fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const sock = lib.default({
    auth: { creds: state.creds, keys: lib.makeCacheableSignalKeyStore(state.keys, quietLogger) },
    ...(version ? { version } : {}),
    logger: quietLogger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  socket = sock;

  sock.ev.on("creds.update", () => {
    void saveCreds().catch((error: unknown) => console.error("Could not save WhatsApp credentials:", error));
  });

  sock.ev.on("connection.update", (update) => {
    if (update.qr) {
      lastQr = update.qr;
      status = "waiting_for_qr";
    }
    if (update.connection === "open") {
      status = "connected";
      lastQr = null;
      lastError = null;
      console.info(`WhatsApp socket connected as ${getSocketState().phone ?? "unknown"}.`);
    }
    if (update.connection === "close") {
      if (socket === sock) socket = null;
      const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      lastError = update.lastDisconnect?.error?.message ?? null;
      if (code === lib.DisconnectReason.loggedOut) {
        status = "logged_out";
        lastQr = null;
        void prisma.whatsAppAuthKey.deleteMany({}).catch(() => undefined);
        console.warn("WhatsApp socket was logged out from the phone; link it again from the dashboard.");
        return;
      }
      status = "connecting";
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        status = "not_linked";
        void startWhatsAppSocket();
      }, 3_000);
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const message of messages) {
      void handleUpsert(lib, message).catch((error: unknown) => {
        console.error(`WhatsApp socket message ${message.key.id ?? "unknown"} could not be processed:`, error);
      });
    }
  });

  sock.ev.on("group-participants.update", () => {
    participantsCache = null;
  });
}

/** Keeps the message in the store first, so recovery can find it, then hands it to the processing pipeline. */
async function handleUpsert(lib: Baileys, message: WAMessage): Promise<void> {
  const key = message.key;
  if (!config.whatsappGroupId || key.remoteJid !== config.whatsappGroupId || !key.id) return;
  const protocol = lib.normalizeMessageContent(message.message)?.protocolMessage;
  if (protocol) {
    if (protocol.type === lib.proto.Message.ProtocolMessage.Type.REVOKE && protocol.key?.id) {
      await markGroupMessageDeleted(protocol.key.id);
    }
    return;
  }
  const webhook = toIncomingWebhook(lib, message);
  if (!webhook) return;
  const data = webhook.messageData;
  const text = (data.textMessageData as { textMessage?: string } | undefined)?.textMessage;
  const timestamp = webhook.timestamp ?? Math.floor(Date.now() / 1000);
  await saveGroupMessage(webhook.idMessage, key.participant || webhook.senderData.sender, timestamp, {
    type: "incoming",
    idMessage: webhook.idMessage,
    timestamp,
    senderId: webhook.senderData.sender,
    typeMessage: data.typeMessage,
    ...(text ? { textMessage: text } : {}),
    ...(data.quotedMessage ? { quotedMessage: data.quotedMessage } : {}),
    ...(data.reactionMessageData ? { reactionMessageData: data.reactionMessageData } : {})
  });
  if (incomingHandler) await incomingHandler(webhook);
}

/** Converts a Baileys group message into the webhook shape the processing pipeline reads. */
function toIncomingWebhook(lib: Baileys, message: WAMessage): IncomingWebhook | null {
  const groupId = config.whatsappGroupId;
  const key = message.key;
  if (!groupId || key.remoteJid !== groupId || key.fromMe || !key.id) return null;
  const rawParticipant = key.participant ?? "";
  const sender = key.participantPn ?? rawParticipant;
  if (!sender) return null;
  // WhatsApp's own key is what a delete-for-everyone needs, also in a LID-addressed group.
  rememberMessageParticipant(key.id, rawParticipant || sender, true);

  const content = lib.normalizeMessageContent(message.message);
  if (!content || content.protocolMessage) return null;
  const timestamp = Number(message.messageTimestamp ?? 0) || undefined;
  const base = { typeWebhook: "incomingMessageReceived" as const, idMessage: key.id, timestamp, senderData: { chatId: groupId, sender } };

  if (content.reactionMessage) {
    return {
      ...base,
      messageData: {
        typeMessage: "reactionMessage",
        reactionMessageData: {
          text: content.reactionMessage.text ?? "",
          stanzaId: content.reactionMessage.key?.id ?? undefined
        }
      }
    };
  }

  const type = lib.getContentType(content);
  if (!type) return null;
  const inner = content[type] as { text?: string | null; caption?: string | null; contextInfo?: { stanzaId?: string | null } | null } | string | null | undefined;
  const text = typeof inner === "string"
    ? inner
    : inner?.text ?? inner?.caption ?? undefined;
  const stanzaId = typeof inner === "object" && inner ? inner.contextInfo?.stanzaId ?? undefined : undefined;
  return {
    ...base,
    messageData: {
      typeMessage: type === "conversation" ? "textMessage" : type,
      ...(text ? { textMessageData: { textMessage: text } } : {}),
      ...(stanzaId ? { extendedTextMessageData: { text: text ?? "", stanzaId }, quotedMessage: { stanzaId } } : {})
    }
  };
}

/** Keeps the Baileys session in the database so it survives deploys and restarts. */
async function useDatabaseAuthState(lib: Baileys) {
  const read = async (id: string): Promise<unknown> => {
    const row = await prisma.whatsAppAuthKey.findUnique({ where: { id } });
    return row ? JSON.parse(row.value, lib.BufferJSON.reviver) : null;
  };
  const write = async (id: string, value: unknown): Promise<void> => {
    const json = JSON.stringify(value, lib.BufferJSON.replacer);
    await prisma.whatsAppAuthKey.upsert({ where: { id }, create: { id, value: json }, update: { value: json } });
  };
  const creds = ((await read("creds")) as AuthenticationCreds | null) ?? lib.initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(ids.map(async (id) => {
            let value = await read(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = lib.proto.Message.AppStateSyncKeyData.fromObject(value as object);
            }
            if (value) data[id] = value as SignalDataTypeMap[T];
          }));
          return data;
        },
        set: async (data: Partial<{ [T in keyof SignalDataTypeMap]: { [id: string]: SignalDataTypeMap[T] | null } }>) => {
          const tasks: Array<Promise<unknown>> = [];
          for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            for (const [id, value] of Object.entries(data[category] ?? {})) {
              const key = `${category}-${id}`;
              tasks.push(value ? write(key, value) : prisma.whatsAppAuthKey.deleteMany({ where: { id: key } }));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => write("creds", creds)
  };
}
