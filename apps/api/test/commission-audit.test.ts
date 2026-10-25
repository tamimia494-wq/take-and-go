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
  assert.match(issues[0]!.reasons.join(" "), /لا تطابق الطلب/);
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
