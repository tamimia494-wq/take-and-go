import assert from "node:assert/strict";
import test from "node:test";
import { buildStatement, statementPeriod, sumStatements, type StatementEntry } from "../src/statement";

let clock = 0;
function entry(partial: Partial<StatementEntry>): StatementEntry {
  clock += 1;
  return {
    captainId: "c",
    type: "ADJUSTMENT",
    amountFils: 0,
    balanceAfterFils: 0,
    description: "",
    reference: null,
    idempotencyKey: null,
    createdAt: new Date(clock),
    ...partial
  };
}

test("splits consumed and produced commissions into rides and orders", () => {
  const statement = buildStatement([
    entry({ type: "RIDER_COMMISSION", amountFils: -750, reference: "job-1", balanceAfterFils: 4250 }),
    entry({ type: "ORDER_COMMISSION", amountFils: -1000, reference: "job-1", balanceAfterFils: 4250 }),
    entry({ type: "RIDER_COMMISSION", amountFils: 1500, reference: "job-2", balanceAfterFils: 5750 })
  ], 6000);
  assert.equal(statement.consumed.riderJobs, 1);
  assert.equal(statement.consumed.orderJobs, 1);
  assert.equal(statement.consumed.totalFils, 1750);
  assert.equal(statement.produced.riderJobs, 1);
  assert.equal(statement.produced.riderFils, 1500);
  assert.equal(statement.openingBalanceFils, 6000);
  assert.equal(statement.closingBalanceFils, 5750);
  assert.equal(statement.spentFils, 1750);
});

test("a job refunded in the same period is not counted as consumed", () => {
  const statement = buildStatement([
    entry({ type: "RIDER_COMMISSION", amountFils: -750, reference: "job-1" }),
    entry({ type: "ADJUSTMENT", amountFils: 750, reference: "job-1" })
  ], 0);
  assert.equal(statement.consumed.riderJobs, 0);
  assert.equal(statement.consumed.totalFils, 0);
});

test("a refund for a job charged earlier is shown as a refund", () => {
  const statement = buildStatement([entry({ type: "ADJUSTMENT", amountFils: 750, reference: "job-1" })], 0);
  assert.equal(statement.consumed.refundedFils, 750);
  assert.equal(statement.consumed.totalFils, -750);
});

test("separates top-ups, bonuses, withdrawals (old positive and new negative) and group floors", () => {
  const statement = buildStatement([
    entry({ type: "CREDIT", amountFils: 5000, description: "شحن رصيد" }),
    entry({ type: "CREDIT", amountFils: 1000, idempotencyKey: "activation-bonus:c" }),
    entry({ type: "ADJUSTMENT", amountFils: 2000, description: "خصم رصيد" }),
    entry({ type: "ADJUSTMENT", amountFils: -1000, description: "خصم رصيد" }),
    entry({ type: "GROUP_FLOOR", amountFils: -500 }),
    entry({ type: "ADJUSTMENT", amountFils: -300, reference: "commission-transfer:x" })
  ], 0);
  assert.equal(statement.topUpsFils, 5000);
  assert.equal(statement.bonusesFils, 1000);
  assert.equal(statement.withdrawalsFils, 3000);
  assert.equal(statement.groupFloorsFils, 500);
  assert.equal(statement.consumed.transferredFils, 300);
  assert.equal(statement.spentFils, 800);
});

test("net profit is top-ups plus group floors minus withdrawals", () => {
  const statement = buildStatement([
    entry({ type: "CREDIT", amountFils: 10000, description: "شحن رصيد" }),
    entry({ type: "GROUP_FLOOR", amountFils: -2000 }),
    entry({ type: "ADJUSTMENT", amountFils: -3000, description: "خصم رصيد" })
  ], 0);
  const totals = sumStatements([{ statement, balanceFils: 5000 }]);
  assert.equal(totals.netProfitFils, 9000);
});

test("reads a statement period in Amman time, including the whole last day", () => {
  const period = statementPeriod("2026-10-01", "2026-10-31")!;
  assert.equal(period.start.toISOString(), "2026-09-30T21:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-10-31T21:00:00.000Z");
  assert.equal(statementPeriod("2026-10-31", "2026-10-01"), null);
  assert.equal(statementPeriod("bad", "2026-10-01"), null);
});
