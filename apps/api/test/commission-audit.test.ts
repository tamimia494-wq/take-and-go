import assert from "node:assert/strict";
import test from "node:test";
import { auditCommissionLedger } from "../src/commission-audit";

const owner = { id: "owner", phone: "962790000001" };
const job = {
  id: "job-1",
  status: "CHARGED",
  sourceSenderPhone: owner.phone,
  commissionFils: 1750,
  riderCommissionFils: 750,
  orderCommissionFils: 1000,
  replies: [{ captainId: "rider", status: "CHARGED" }]
};
const chargedEntries = [
  { reference: job.id, captainId: "rider", type: "RIDER_COMMISSION", amountFils: -750 },
  { reference: job.id, captainId: owner.id, type: "RIDER_COMMISSION", amountFils: 750 },
  { reference: job.id, captainId: "rider", type: "ORDER_COMMISSION", amountFils: -1000 },
  { reference: job.id, captainId: owner.id, type: "ORDER_COMMISSION", amountFils: 1000 }
];

test("accepts matching debit and credit entries for a charged job", () => {
  assert.deepEqual(auditCommissionLedger([job], [owner], chargedEntries), []);
});

test("reports a missing commission entry", () => {
  const issues = auditCommissionLedger([job], [owner], chargedEntries.slice(1));
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.reasons.join(" "), /ينقص 1/);
  assert.equal(issues[0]!.repairable, true);
  assert.deepEqual(issues[0]!.missingEntries, [{ captainId: "rider", type: "RIDER_COMMISSION", amountFils: -750 }]);
});

test("lists every deduction and addition for a charged job with no ledger entries", () => {
  const issues = auditCommissionLedger([job], [owner], []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.missingEntries.length, 4);
  assert.deepEqual(issues[0]!.unexpectedEntries, []);
});

test("does not repair entries that differ from the rule, only reports them", () => {
  const wrongAmount = [...chargedEntries.slice(1), { reference: job.id, captainId: "rider", type: "RIDER_COMMISSION", amountFils: -500 }];
  const issues = auditCommissionLedger([job], [owner], wrongAmount);
  assert.deepEqual(issues[0]!.unexpectedEntries, [{ captainId: "rider", type: "RIDER_COMMISSION", amountFils: -500 }]);
  assert.match(issues[0]!.reasons.join(" "), /مراجعة يدوية/);
});

test("does not rebuild entries when the owner account is missing", () => {
  const issues = auditCommissionLedger([job], [], []);
  assert.equal(issues[0]!.repairable, false);
  assert.deepEqual(issues[0]!.missingEntries, []);
});

test("checks the debit and owner reversal entries for a canceled job", () => {
  const canceledJob = {
    ...job,
    status: "CANCELED",
    replies: [{ captainId: "rider", status: "CANCELED" }]
  };
  const canceledEntries = [
    ...chargedEntries,
    { reference: job.id, captainId: "rider", type: "ADJUSTMENT", amountFils: 1750 },
    { reference: job.id, captainId: owner.id, type: "ADJUSTMENT", amountFils: -750 },
    { reference: job.id, captainId: owner.id, type: "ADJUSTMENT", amountFils: -1000 }
  ];
  assert.deepEqual(auditCommissionLedger([canceledJob], [owner], canceledEntries), []);
});

test("reports money movements attached to a job that was not approved", () => {
  const pendingJob = { ...job, status: "PENDING", replies: [] };
  const issues = auditCommissionLedger([pendingJob], [owner], chargedEntries);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.reasons.join(" "), /غير معتمد/);
});

test("reports ledger references to jobs missing from the job table", () => {
  const issues = auditCommissionLedger([], [owner], chargedEntries);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.status, "UNKNOWN");
});

const reversalEntries = (captainId: string) => [
  { reference: job.id, captainId, type: "ADJUSTMENT", amountFils: 1750 },
  { reference: job.id, captainId: owner.id, type: "ADJUSTMENT", amountFils: -750 },
  { reference: job.id, captainId: owner.id, type: "ADJUSTMENT", amountFils: -1000 }
];
const chargeEntries = (captainId: string) =>
  chargedEntries.map((entry) => (entry.captainId === "rider" ? { ...entry, captainId } : entry));

test("accepts a job that moved to the next liked captain after the first like was removed", () => {
  const movedJob = {
    ...job,
    replies: [{ captainId: "rider", status: "CANCELED" }, { captainId: "second", status: "CHARGED" }]
  };
  const entries = [...chargedEntries, ...reversalEntries("rider"), ...chargeEntries("second")];
  assert.deepEqual(auditCommissionLedger([movedJob], [owner], entries), []);
});

test("accepts a pending job whose only like was removed and refunded", () => {
  const releasedJob = { ...job, status: "PENDING", replies: [{ captainId: "rider", status: "CANCELED" }] };
  assert.deepEqual(auditCommissionLedger([releasedJob], [owner], [...chargedEntries, ...reversalEntries("rider")]), []);
});

test("reports the missing charge of the captain who took over the job", () => {
  const movedJob = {
    ...job,
    replies: [{ captainId: "rider", status: "CANCELED" }, { captainId: "second", status: "CHARGED" }]
  };
  const issues = auditCommissionLedger([movedJob], [owner], [...chargedEntries, ...reversalEntries("rider")]);
  assert.equal(issues[0]!.repairable, true);
  assert.equal(issues[0]!.missingEntries.length, 4);
});

test("accepts a captain charged again after the owner liked their reply a second time", () => {
  const relikedJob = { ...job, replies: [{ captainId: "rider", status: "CHARGED" }] };
  const entries = [...chargedEntries, ...reversalEntries("rider"), ...chargedEntries];
  assert.deepEqual(auditCommissionLedger([relikedJob], [owner], entries), []);
});
