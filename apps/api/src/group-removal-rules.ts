import type { GroupMember } from "./green-api";

// Who leaves the WhatsApp group: members whose account is not active (not activated yet or suspended) or whose
// balance reached 0. Group admins, protected numbers and numbers without an account are never removed.

export type RemovalReason = "inactive" | "zero_balance";
export type RemovalCandidate = { phone: string; fullName: string | null; reason: RemovalReason; balanceFils: number };
type CaptainState = { phone: string; fullName: string | null; status: string; balanceFils: number };

export function removalReason(captain: { status: string; balanceFils: number }): RemovalReason | null {
  if (captain.status !== "ACTIVE") return "inactive";
  if (captain.balanceFils <= 0) return "zero_balance";
  return null;
}

export function selectMembersToRemove(
  members: GroupMember[],
  captains: CaptainState[],
  protectedPhones: Set<string>
): { candidates: RemovalCandidate[]; withoutAccount: number } {
  const byPhone = new Map(captains.map((captain) => [captain.phone, captain]));
  const candidates: RemovalCandidate[] = [];
  const seen = new Set<string>();
  let withoutAccount = 0;
  for (const member of members) {
    if (!member.phone || member.isAdmin || protectedPhones.has(member.phone) || seen.has(member.phone)) continue;
    seen.add(member.phone);
    const captain = byPhone.get(member.phone);
    if (!captain) {
      withoutAccount += 1;
      continue;
    }
    const reason = removalReason(captain);
    if (reason) candidates.push({ phone: captain.phone, fullName: captain.fullName, reason, balanceFils: captain.balanceFils });
  }
  return { candidates, withoutAccount };
}
