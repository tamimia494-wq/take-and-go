import assert from "node:assert/strict";
import test from "node:test";
import { removalReason, selectMembersToRemove } from "../src/group-removal-rules";

test("removes members whose account is not active or whose balance is 0", () => {
  assert.equal(removalReason({ status: "PENDING_PROFILE", balanceFils: 5000 }), "inactive");
  assert.equal(removalReason({ status: "SUSPENDED", balanceFils: 5000 }), "inactive");
  assert.equal(removalReason({ status: "ACTIVE", balanceFils: 0 }), "zero_balance");
  // The 0.5 JOD reserve keeps a captain in the group; they can still post orders.
  assert.equal(removalReason({ status: "ACTIVE", balanceFils: 500 }), null);
  assert.equal(removalReason({ status: "ACTIVE", balanceFils: 1 }), null);
});

test("never removes admins, protected numbers, unknown numbers or members without an account", () => {
  const { candidates, withoutAccount } = selectMembersToRemove(
    [
      { phone: "962790000001", isAdmin: false },
      { phone: "962790000002", isAdmin: true },
      { phone: "962790000003", isAdmin: false },
      { phone: "962790000004", isAdmin: false },
      { phone: "962790000005", isAdmin: false },
      { phone: "962790000006", isAdmin: false },
      { phone: null, isAdmin: false }
    ],
    [
      { phone: "962790000001", fullName: "أ", status: "ACTIVE", balanceFils: 0 },
      { phone: "962790000002", fullName: "ب", status: "SUSPENDED", balanceFils: 0 },
      { phone: "962790000003", fullName: "ج", status: "PENDING_PROFILE", balanceFils: 0 },
      { phone: "962790000005", fullName: "د", status: "ACTIVE", balanceFils: 750 },
      { phone: "962790000006", fullName: "ه", status: "PENDING_PROFILE", balanceFils: 0, groupRemovalExempt: true }
    ],
    new Set(["962790000003"])
  );
  assert.deepEqual(candidates.map((candidate) => [candidate.phone, candidate.reason]), [["962790000001", "zero_balance"]]);
  assert.equal(withoutAccount, 1);
});
