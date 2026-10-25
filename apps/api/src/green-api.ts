import { config } from "./config";
import { phoneFromChatId } from "./money";

export class GreenApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "GreenApiRequestError";
  }
}

const GROUP_SENDER_CACHE_TTL_MS = 5 * 60 * 1000;
const groupSenderCache = new Map<string, { expiresAt: number; phonesById: Map<string, string> }>();

function requireGreenApiConfig(): { instanceId: string; token: string; groupId: string } {
  const { greenApiInstanceId, greenApiToken, greenApiGroupId } = config;
  if (!greenApiInstanceId || !greenApiToken || !greenApiGroupId) {
    throw new Error("Green API is not configured. Set GREEN_API_INSTANCE_ID, GREEN_API_TOKEN and GREEN_API_GROUP_ID.");
  }
  return { instanceId: greenApiInstanceId, token: greenApiToken, groupId: greenApiGroupId };
}

export async function greenApiRequest<T>(
  method: string,
  body?: Record<string, unknown>
): Promise<T> {
  const { instanceId, token } = requireGreenApiConfig();
  const url = `${config.greenApiUrl}/waInstance${instanceId}/${method}/${token}`;
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Green API returned an invalid response (${response.status}).`);
  }
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : `Green API request failed (${response.status}).`;
    throw new GreenApiRequestError(message, response.status);
  }
  if (typeof data !== "object" || data === null) {
    throw new Error("Green API returned an unexpected response.");
  }
  return data as T;
}

export async function getInstancePhone(): Promise<string | null> {
  const data = await greenApiRequest<{ phone?: string; phoneNumber?: string }>("getWaSettings");
  const raw = data.phone ?? data.phoneNumber ?? "";
  return raw ? phoneFromChatId(raw) : null;
}

export async function sendGroupMessage(message: string): Promise<void> {
  const { groupId } = requireGreenApiConfig();
  await greenApiRequest("sendMessage", { chatId: groupId, message });
}

export async function deleteGroupMessage(messageId: string): Promise<void> {
  const { groupId } = requireGreenApiConfig();
  await greenApiRequest("deleteMessage", {
    chatId: groupId,
    idMessage: messageId
  });
}

export async function getGroupParticipants(): Promise<string[]> {
  const { groupId } = requireGreenApiConfig();
  const data = await greenApiRequest<{ participants?: Array<{ id?: string; participantId?: string; phoneNumber?: string }> }>(
    "getGroupData",
    { groupId }
  );
  return (data.participants ?? [])
    .map((participant) => participant.phoneNumber?.trim() || participant.id || participant.participantId || "")
    .filter(Boolean);
}

export async function resolveGroupSenderPhone(senderId: string): Promise<string | null> {
  const { groupId } = requireGreenApiConfig();
  let cached = groupSenderCache.get(groupId);
  if (!cached || cached.expiresAt <= Date.now()) {
    const data = await greenApiRequest<{
      participants?: Array<{ id?: string; lid?: string; participantId?: string; phoneNumber?: string }>;
    }>("getGroupData", { groupId });
    const phonesById = new Map<string, string>();
    for (const participant of data.participants ?? []) {
      const identifiers = [participant.phoneNumber, participant.id, participant.participantId];
      const phone = identifiers
        .map((id) => id ? phoneFromChatId(id) : null)
        .find((candidate): candidate is string => candidate !== null);
      if (!phone) continue;
      for (const id of [participant.id, participant.lid, participant.participantId, participant.phoneNumber]) {
        if (id) {
          const normalizedId = id.trim();
          phonesById.set(normalizedId, phone);
          phonesById.set(normalizedId.split("@")[0], phone);
        }
      }
    }
    cached = { expiresAt: Date.now() + GROUP_SENDER_CACHE_TTL_MS, phonesById };
    groupSenderCache.set(groupId, cached);
  }
  const normalizedSenderId = senderId.trim();
  return cached.phonesById.get(normalizedSenderId) ??
    cached.phonesById.get(normalizedSenderId.split("@")[0]) ??
    null;
}

export async function getGroupMessageSenderPhone(messageId: string): Promise<string | null> {
  const { groupId } = requireGreenApiConfig();
  const history = await greenApiRequest<Array<{ idMessage?: string; senderId?: string }>>(
    "getChatHistory",
    { chatId: groupId, count: 100 }
  );
  const message = history.find((entry) => entry.idMessage === messageId);
  if (!message?.senderId) return null;
  return phoneFromChatId(message.senderId) ?? resolveGroupSenderPhone(message.senderId);
}

export async function fetchGroupHistory(count: number): Promise<Array<Record<string, unknown>>> {
  const { groupId } = requireGreenApiConfig();
  return greenApiRequest<Array<Record<string, unknown>>>("getChatHistory", { chatId: groupId, count });
}

export async function fetchRecentIncomingMessages(minutes = 15): Promise<unknown[]> {
  const { groupId } = requireGreenApiConfig();
  const count = Math.min(100, Math.max(minutes, 20));
  const history = await greenApiRequest<Array<Record<string, unknown>>>(
    "getChatHistory",
    { chatId: groupId, count }
  );
  const cutoff = Date.now() - minutes * 60_000;
  return history.filter((entry) => {
    const timestamp = Number(entry.timestamp ?? 0) * 1000;
    return !timestamp || timestamp >= cutoff;
  });
}
