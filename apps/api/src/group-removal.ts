import { config } from "./config";
import { prisma } from "./db";
import { getGroupMembers, getInstancePhone, removeGroupMember, sendPrivateMessage } from "./green-api";
import { removalReason, selectMembersToRemove, type RemovalCandidate, type RemovalReason } from "./group-removal-rules";
import { phoneFromChatId } from "./money";
import { getSocketState } from "./whatsapp-socket";

// Members whose account is not active (not activated yet or suspended) or whose balance reached 0 are removed
// from the WhatsApp group. Admin numbers, the bot, group admins and numbers without an account are never removed.

/** Removal runs at most this many members per run, so a big first run is spread out instead of hitting WhatsApp at once. */
const REMOVALS_PER_RUN = 10;

async function protectedPhones(): Promise<Set<string>> {
  const phones = new Set<string>();
  for (const raw of [config.adminContactPhone, ...config.excludedAdminPhones]) {
    const phone = raw ? phoneFromChatId(raw) : null;
    if (phone) phones.add(phone);
  }
  const instancePhone = await getInstancePhone().catch(() => null);
  if (instancePhone) phones.add(instancePhone);
  const socketPhone = getSocketState().phone;
  const normalizedSocketPhone = socketPhone ? phoneFromChatId(socketPhone) : null;
  if (normalizedSocketPhone) phones.add(normalizedSocketPhone);
  return phones;
}

/** Who would be removed right now, without removing anyone. */
export async function previewGroupRemovals(): Promise<{ candidates: RemovalCandidate[]; withoutAccount: number; unresolved: number }> {
  const members = await getGroupMembers();
  const phones = members.map((member) => member.phone).filter((phone): phone is string => phone !== null);
  const [captains, protectedSet] = await Promise.all([
    prisma.captain.findMany({
      where: { phone: { in: phones } },
      select: { phone: true, fullName: true, status: true, balanceFils: true }
    }),
    protectedPhones()
  ]);
  return {
    ...selectMembersToRemove(members, captains, protectedSet),
    unresolved: members.filter((member) => !member.phone).length
  };
}

export type GroupRemovalRun = { at: string; removed: string[]; failed: Array<{ phone: string; error: string }>; error: string | null };
let lastRun: GroupRemovalRun | null = null;

export function getLastGroupRemovalRun(): GroupRemovalRun | null {
  return lastRun;
}

/** Removes ineligible members when the admin turned removal on. Each one is re-checked just before removal. */
export async function removeIneligibleGroupMembers(): Promise<GroupRemovalRun | null> {
  if (!config.greenApiGroupId) return null;
  const settings = await prisma.appSettings.findUnique({ where: { id: "default" }, select: { groupRemovalEnabled: true } });
  if (!settings?.groupRemovalEnabled) return null;
  const run: GroupRemovalRun = { at: new Date().toISOString(), removed: [], failed: [], error: null };
  try {
    const { candidates } = await previewGroupRemovals();
    for (const candidate of candidates.slice(0, REMOVALS_PER_RUN)) {
      // A top-up or activation may have landed while the group was being read.
      const current = await prisma.captain.findUnique({ where: { phone: candidate.phone }, select: { status: true, balanceFils: true } });
      const reason = current ? removalReason(current) : null;
      if (!reason) continue;
      try {
        await removeGroupMember(candidate.phone);
        run.removed.push(candidate.phone);
        await notifyRemoval(candidate.phone, reason);
      } catch (error) {
        run.failed.push({ phone: candidate.phone, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  }
  lastRun = run;
  return run;
}

async function notifyRemoval(phone: string, reason: RemovalReason): Promise<void> {
  const message = reason === "inactive"
    ? "⚠️ تمت إزالتك من جروب Take & Go لأن حسابك غير مفعل. فعّل حسابك أو تواصل مع الإدارة لإرجاعك للجروب."
    : "⚠️ تمت إزالتك من جروب Take & Go لأن رصيدك صفر. اشحن رصيدك وتواصل مع الإدارة لإرجاعك للجروب.";
  try {
    await sendPrivateMessage(phone, message);
  } catch (error) {
    console.warn(`Could not send the removal notice to ${phone}:`, error);
  }
}
