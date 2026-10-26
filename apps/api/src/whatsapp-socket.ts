import type { AuthenticationCreds, SignalDataTypeMap, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { config } from "./config";
import { prisma } from "./db";

// A direct WhatsApp Web connection (Baileys) for the bot number. While it is linked, sending and deleting group
// messages go through it instead of Green API, and group messages reach the same processing pipeline. It only
// starts once an admin links it from the dashboard, so nothing changes until then.

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
export function rememberMessageParticipant(messageId: string, senderId: string): void {
  if (!messageId || !senderId || participantByMessageId.has(messageId)) return;
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

/** Deletes a group message for everyone. Returns false when the sender of the message is unknown. */
export async function deleteViaSocket(messageId: string): Promise<boolean> {
  const participant = participantByMessageId.get(messageId);
  if (!socket || !participant || !config.greenApiGroupId) return false;
  await socket.sendMessage(config.greenApiGroupId, {
    delete: { remoteJid: config.greenApiGroupId, id: messageId, participant, fromMe: false }
  });
  return true;
}

export async function sendPrivateViaSocket(phone: string, message: string): Promise<void> {
  if (!socket) throw new Error("WhatsApp socket is not connected.");
  await socket.sendMessage(`${phone}@s.whatsapp.net`, { text: message });
}

export async function sendViaSocket(message: string): Promise<void> {
  if (!socket || !config.greenApiGroupId) throw new Error("WhatsApp socket is not connected.");
  await socket.sendMessage(config.greenApiGroupId, { text: message });
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
      const webhook = toIncomingWebhook(lib, message);
      if (!webhook || !incomingHandler) continue;
      void incomingHandler(webhook).catch((error: unknown) => {
        console.error(`WhatsApp socket message ${webhook.idMessage} could not be processed:`, error);
      });
    }
  });
}

/** Converts a Baileys group message into the Green API webhook shape the processing pipeline already reads. */
function toIncomingWebhook(lib: Baileys, message: WAMessage): IncomingWebhook | null {
  const groupId = config.greenApiGroupId;
  const key = message.key;
  if (!groupId || key.remoteJid !== groupId || key.fromMe || !key.id) return null;
  const rawParticipant = key.participant ?? "";
  const sender = key.participantPn ?? rawParticipant;
  if (!sender) return null;
  rememberMessageParticipant(key.id, rawParticipant || sender);

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
