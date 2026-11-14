import { phoneFromChatId } from "./money";
import {
  deleteViaSocket,
  getGroupParticipantsViaSocket,
  getSocketState,
  updateParticipantsViaSocket,
  sendPrivateViaSocket,
  sendViaSocket
} from "./whatsapp-socket";

// Everything the app asks of WhatsApp, all through the direct Baileys link. History comes from the message store.
export { fetchGroupHistory, fetchGroupMessage } from "./message-store";

let lastDeletion: { at: string; error: string | null } | null = null;

export function getLastDeletionStatus(): typeof lastDeletion {
  return lastDeletion;
}

/** The bot's own phone number, while the link is connected. */
export function getBotPhone(): string | null {
  const phone = getSocketState().phone;
  return phone ? phoneFromChatId(phone) : null;
}

export async function sendGroupMessage(message: string): Promise<void> {
  await sendViaSocket(message);
}

/** Sends a private WhatsApp message to a phone number such as 962790000000. */
export async function sendPrivateMessage(phone: string, message: string): Promise<void> {
  await sendPrivateViaSocket(phone, message);
}

export async function deleteGroupMessage(messageId: string): Promise<void> {
  try {
    await deleteViaSocket(messageId);
    lastDeletion = { at: new Date().toISOString(), error: null };
  } catch (error) {
    lastDeletion = { at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    throw error;
  }
}

export type GroupMember = { phone: string | null; isAdmin: boolean; ids: string[] };

/** Every group member with their phone number when WhatsApp reports one, and whether they are a group admin. */
export async function getGroupMembers(fresh = false): Promise<GroupMember[]> {
  const participants = await getGroupParticipantsViaSocket(fresh);
  return participants.map((participant) => ({
    phone: participant.ids.map((id) => phoneFromChatId(id)).find((candidate): candidate is string => candidate !== null) ?? null,
    isAdmin: participant.isAdmin,
    ids: participant.ids
  }));
}

export async function removeGroupMembers(phones: string[]): Promise<{ removed: string[]; failed: Array<{ phone: string; error: string }> }> {
  const result = await updateParticipantsViaSocket(phones, "remove");
  return {
    removed: result.done,
    failed: result.failed.map(({ phone, status }) => ({ phone, error: `WhatsApp answered ${status}; is the bot a group admin?` }))
  };
}

export async function addGroupMembers(phones: string[]): ReturnType<typeof updateParticipantsViaSocket> {
  return updateParticipantsViaSocket(phones, "add");
}

/** Maps a sender id (a phone JID or an anonymous @lid id) to a phone number using the group's member list. */
export async function resolveGroupSenderPhone(senderId: string): Promise<string | null> {
  const direct = phoneFromChatId(senderId);
  if (direct) return direct;
  const wanted = senderId.trim();
  const bare = wanted.split("@")[0]!.split(":")[0];
  const members = await getGroupMembers();
  return members.find((member) => member.ids.some((id) => id === wanted || id.split("@")[0]!.split(":")[0] === bare))?.phone ?? null;
}

export async function isGroupAdmin(phone: string): Promise<boolean> {
  const members = await getGroupMembers();
  return members.some((member) => member.phone === phone && member.isAdmin);
}
