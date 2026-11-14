import { config } from "./config";
import { prisma } from "./db";
import { addGroupMembers, getBotPhone, getGroupMembers, removeGroupMembers, sendPrivateMessage } from "./whatsapp-client";
import { removalReason, selectMembersToRemove, type RemovalCandidate, type RemovalReason } from "./group-removal-rules";
import { phoneFromChatId } from "./money";
import { isSocketConnected } from "./whatsapp-socket";

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
      select: { phone: true, fullName: true, status: true, balanceFils: true, groupRemovalExempt: true }
    }),
    protectedPhones()
  ]);
  return {
    ...selectMembersToRemove(members, captains, protectedSet),
    unresolved: members.filter((member) => !member.phone).length
  };
}

export type GroupRemovalRun = {
  at: string;
  removed: string[];
  failed: Array<{ phone: string; error: string }>;
  added: string[];
  addFailed: Array<{ phone: string; error: string }>;
  error: string | null;
};
let lastRun: GroupRemovalRun | null = null;

export function getLastGroupRemovalRun(): GroupRemovalRun | null {
  return lastRun;
}

let running: Promise<GroupRemovalRun | null> | null = null;

/**
 * Removes every ineligible member at once (while the admin has removal on) and adds back everyone the system removed
 * who is eligible again, for example right after a top-up. Runs one at a time.
 */
export function syncGroupMembership(): Promise<GroupRemovalRun | null> {
  running ??= runRemoval().finally(() => {
    running = null;
  });
  return running;
}

/**
 * Starts a sync in the background, e.g. after a top-up, so the captain is back in the group within seconds. A
 * captain whose balance was just credited is added even if the system has no record of removing them.
 */
export function startGroupSync(toppedUpCaptainId?: string): void {
  void (async () => {
    if (toppedUpCaptainId) await addToppedUpCaptain(toppedUpCaptainId);
    await syncGroupMembership();
  })().catch((error: unknown) => {
    console.error("Group membership sync failed:", error);
  });
}

async function addToppedUpCaptain(captainId: string): Promise<void> {
  if (!config.whatsappGroupId || !isSocketConnected()) return;
  const captain = await prisma.captain.findUnique({ where: { id: captainId }, select: { phone: true, status: true, balanceFils: true } });
  if (!captain || captain.status !== "ACTIVE" || captain.balanceFils <= 0) return;
  await running?.catch(() => null);
  const members = await getGroupMembers(true);
  if (members.some((member) => member.phone === captain.phone)) return;
  const result = await addGroupMembers([captain.phone]);
  const added = result.done.includes(captain.phone);
  if (added || result.failed.some((item) => item.status === "409")) {
    await prisma.captain.updateMany({ where: { id: captainId }, data: { removedFromGroupAt: null } });
  }
  if (added) {
    try {
      await sendPrivateMessage(captain.phone, "✅ رجعناك على جروب Take & Go بعد شحن رصيدك. بالتوفيق!");
    } catch (error) {
      console.warn(`Could not send the re-add notice to ${captain.phone}:`, error);
    }
  } else {
    const failure = result.failed[0];
    console.warn(`Could not add ${captain.phone} to the group after a top-up: ${failure ? addFailureText(failure.status) : "no answer"}`);
  }
}

async function runRemoval(): Promise<GroupRemovalRun | null> {
  if (!config.whatsappGroupId || !isSocketConnected()) return null;
  const settings = await prisma.appSettings.findUnique({ where: { id: "default" }, select: { groupRemovalEnabled: true } });
  const run: GroupRemovalRun = { at: new Date().toISOString(), removed: [], failed: [], added: [], addFailed: [], error: null };
  try {
    await addBackEligibleMembers(run);
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  }
  if (!settings?.groupRemovalEnabled) {
    if (run.added.length || run.addFailed.length || run.error) lastRun = run;
    return run;
  }
  try {
    await exemptManualReAdds();
    const { candidates } = await previewGroupRemovals();
    // A top-up or activation may have landed while the group was being read.
    const current = await prisma.captain.findMany({
      where: { phone: { in: candidates.map((candidate) => candidate.phone) }, groupRemovalExempt: false },
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
      if (result.removed.length) {
        await prisma.captain.updateMany({ where: { phone: { in: result.removed } }, data: { removedFromGroupAt: new Date() } });
      }
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

/**
 * Someone the system removed who is back in the group while still not eligible was added back by hand, so the admin
 * wants them there: they are exempted for good instead of being removed again a minute later.
 */
async function exemptManualReAdds(): Promise<void> {
  const removed = await prisma.captain.findMany({
    where: { removedFromGroupAt: { not: null } },
    select: { phone: true, status: true, balanceFils: true }
  });
  if (!removed.length) return;
  const members = new Set((await getGroupMembers(true)).map((member) => member.phone).filter(Boolean));
  const readded = removed.filter((captain) => members.has(captain.phone) && removalReason(captain)).map((captain) => captain.phone);
  if (!readded.length) return;
  await prisma.captain.updateMany({
    where: { phone: { in: readded } },
    data: { removedFromGroupAt: null, groupRemovalExempt: true }
  });
  console.info(`Group removal: ${readded.length} members were added back by hand and are now exempt.`);
}

/** Exempts a captain from removal, or lifts the exemption. */
export async function setGroupRemovalExempt(phone: string, exempt: boolean): Promise<boolean> {
  const updated = await prisma.captain.updateMany({ where: { phone }, data: { groupRemovalExempt: exempt } });
  return updated.count === 1;
}

/** A member WhatsApp refused to add is tried again after this long, not every minute. */
const ADD_RETRY_MS = 30 * 60_000;
const addRefusedAt = new Map<string, number>();

export type AddToppedUpResult = { added: string[]; failed: Array<{ phone: string; error: string }>; alreadyIn: number };

function addFailureText(status: string): string {
  return status === "403"
    ? "إعدادات الخصوصية عنده بتمنع إضافته للجروب"
    : status === "408" ? "طلع من الجروب قريباً فواتساب مانع إضافته هلأ" : `واتساب رد ${status}`;
}

/**
 * The admin's "add everyone who topped up" button: adds every captain with an active account and a balance above
 * zero who is not in the group, including people removed before the system recorded removals.
 */
export async function addToppedUpCaptains(): Promise<AddToppedUpResult> {
  await running?.catch(() => null);
  const eligible = await prisma.captain.findMany({
    where: { status: "ACTIVE", balanceFils: { gt: 0 } },
    select: { phone: true }
  });
  const members = new Set((await getGroupMembers(true)).map((member) => member.phone).filter(Boolean));
  const toAdd = eligible.map((captain) => captain.phone).filter((phone) => !members.has(phone));
  const result = toAdd.length ? await addGroupMembers(toAdd) : { done: [], failed: [] };
  const back = [...result.done, ...result.failed.filter((item) => item.status === "409").map((item) => item.phone)];
  if (back.length) await prisma.captain.updateMany({ where: { phone: { in: back } }, data: { removedFromGroupAt: null } });
  if (result.done.length <= MAX_NOTICES_PER_RUN) {
    for (const phone of result.done) {
      try {
        await sendPrivateMessage(phone, "✅ رجعناك على جروب Take & Go بعد شحن رصيدك. بالتوفيق!");
      } catch (error) {
        console.warn(`Could not send the re-add notice to ${phone}:`, error);
      }
    }
  }
  return {
    added: result.done,
    failed: result.failed.filter((item) => item.status !== "409").map(({ phone, status }) => ({ phone, error: addFailureText(status) })),
    alreadyIn: eligible.length - toAdd.length
  };
}

async function addBackEligibleMembers(run: GroupRemovalRun): Promise<void> {
  const removed = await prisma.captain.findMany({
    where: { removedFromGroupAt: { not: null }, status: "ACTIVE", balanceFils: { gt: 0 } },
    select: { id: true, phone: true }
  });
  const due = removed.filter((captain) => Date.now() - (addRefusedAt.get(captain.phone) ?? 0) >= ADD_RETRY_MS);
  if (!due.length) return;
  const members = new Set((await getGroupMembers(true)).map((member) => member.phone).filter(Boolean));
  const alreadyIn = due.filter((captain) => members.has(captain.phone));
  const toAdd = due.filter((captain) => !members.has(captain.phone)).map((captain) => captain.phone);
  const result = toAdd.length ? await addGroupMembers(toAdd) : { done: [], failed: [] };
  // 409 means they are already in the group, e.g. an admin added them by hand.
  const back = [...alreadyIn.map((captain) => captain.phone), ...result.done,
    ...result.failed.filter((item) => item.status === "409").map((item) => item.phone)];
  if (back.length) {
    await prisma.captain.updateMany({ where: { phone: { in: back } }, data: { removedFromGroupAt: null } });
  }
  for (const phone of back) addRefusedAt.delete(phone);
  run.added = result.done;
  for (const { phone, status } of result.failed.filter((item) => item.status !== "409")) {
    addRefusedAt.set(phone, Date.now());
    run.addFailed.push({ phone, error: addFailureText(status) });
  }
  if (result.done.length <= MAX_NOTICES_PER_RUN) {
    for (const phone of result.done) {
      try {
        await sendPrivateMessage(phone, "✅ رجعناك على جروب Take & Go بعد شحن رصيدك. بالتوفيق!");
      } catch (error) {
        console.warn(`Could not send the re-add notice to ${phone}:`, error);
      }
    }
  }
}

async function notifyRemoval(phone: string, reason: RemovalReason): Promise<void> {
  const message = reason === "inactive"
    ? "⚠️ تمت إزالتك من جروب Take & Go لأن حسابك غير مفعل. أول ما يتفعّل حسابك وفيه رصيد بترجع للجروب تلقائياً."
    : "⚠️ تمت إزالتك من جروب Take & Go لأن رصيدك صفر. أول ما تشحن رصيدك بترجع للجروب تلقائياً.";
  try {
    await sendPrivateMessage(phone, message);
  } catch (error) {
    console.warn(`Could not send the removal notice to ${phone}:`, error);
  }
}
