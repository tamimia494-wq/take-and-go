import { config } from "./config";
import { phoneFromChatId } from "./money";

type GreenApiResponse = Record<string, unknown>;

function requireGreenApiConfig(): { instanceId: string; token: string; groupId: string } {
  const { greenApiInstanceId, greenApiToken, greenApiGroupId } = config;
  if (!greenApiInstanceId || !greenApiToken || !greenApiGroupId) {
    throw new Error("Green API is not configured. Set GREEN_API_INSTANCE_ID, GREEN_API_TOKEN and GREEN_API_GROUP_ID.");
  }
  return { instanceId: greenApiInstanceId, token: greenApiToken, groupId: greenApiGroupId };
}

export async function greenApiRequest<T extends GreenApiResponse>(
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
    throw new Error(message);
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
    idMessage: messageId,
    onlySender: false
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
