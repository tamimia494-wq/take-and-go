import { config } from "./config";
import { prisma } from "./db";
import { getBotPhone, getGroupMembers, removeGroupMembers, sendPrivateMessage } from "./whatsapp-client";
import { removalReason, selectMembersToRemove, type RemovalCandidate, type RemovalReason } from "./group-removal-rules";
import { phoneFromChatId } from "./money";

// Members whose account is not active (not activated yet or suspended) or whose balance reached 0 are removed
// from the WhatsApp group. Admin numbers, the bot, group admins and numbers without an account are never removed.

/**
 * A run that removes more members than this sends no private notices: hundreds of private messages at once could
 * get the bot number blocked. That is the first run after removal is turned on; later runs catch a few at a time.
 */
const MAX_NOTICES_PER_RUN = 20;

function protectedPhones(): Set<string> {
  const phones = new Set<string>();
  for (const raw of [config.adminContactPhone, ...config.excludedAdminPhones]) {
    const phone = raw ? phoneFromChatId(raw) : null;
    if (phone) phones.add(phone);
  }
  const botPhone = getBotPhone();
  if (botPhone) phones.add(botPhone);
  return phones;
}

/** Who would be removed right now, without removing anyone. */
export async function previewGroupRemovals(): Promise<{ candidates: RemovalCandidate[]; withoutAccount: number; unresolved: number }> {
  const members = await getGroupMembers(true);
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

let running: Promise<GroupRemovalRun | null> | null = null;

/** Removes every ineligible member at once when the admin turned removal on. Runs one at a time. */
export function removeIneligibleGroupMembers(): Promise<GroupRemovalRun | null> {
  running ??= runRemoval().finally(() => {
    running = null;
  });
  return running;
}

async function runRemoval(): Promise<GroupRemovalRun | null> {
  if (!config.whatsappGroupId) return null;
  const settings = await prisma.appSettings.findUnique({ where: { id: "default" }, select: { groupRemovalEnabled: true } });
  if (!settings?.groupRemovalEnabled) return null;
  const run: GroupRemovalRun = { at: new Date().toISOString(), removed: [], failed: [], error: null };
  try {
    const { candidates } = await previewGroupRemovals();
    // A top-up or activation may have landed while the group was being read.
    const current = await prisma.captain.findMany({
      where: { phone: { in: candidates.map((candidate) => candidate.phone) } },
      select: { phone: true, status: true, balanceFils: true }
    });
    const reasons = new Map<string, RemovalReason>();
    for (const captain of current) {
      const reason = removalReason(captain);
      if (reason) reasons.set(captain.phone, reason);
    }
    if (reasons.size) {
      const result = await removeGroupMembers([...reasons.keys()]);
      run.removed = result.removed;
      run.failed = result.failed;
      if (result.removed.length <= MAX_NOTICES_PER_RUN) {
        for (const phone of result.removed) await notifyRemoval(phone, reasons.get(phone)!);
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
