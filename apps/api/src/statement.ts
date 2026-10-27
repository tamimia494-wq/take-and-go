// Account statements: what a captain produced (commissions credited for their orders that were taken), what they
// consumed (commissions taken for orders they took), their top-ups, withdrawals and group floors over a period.

export type StatementEntry = {
  captainId: string;
  type: string;
  amountFils: number;
  balanceAfterFils: number;
  description: string;
  reference: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
};

type CommissionSide = {
  riderJobs: number;
  orderJobs: number;
  riderFils: number;
  orderFils: number;
  /** Commissions refunded (❌ or a removed like) for jobs charged before the period. */
  refundedFils: number;
  /** Commissions moved by an admin transfer, outside any job. */
  transferredFils: number;
  totalFils: number;
};

export type CaptainStatement = {
  openingBalanceFils: number;
  closingBalanceFils: number;
  produced: CommissionSide;
  consumed: CommissionSide;
  topUpsFils: number;
  bonusesFils: number;
  withdrawalsFils: number;
  groupFloorsFils: number;
  /** Everything the captain spent from their balance: consumed commissions and group floors. */
  spentFils: number;
};

function emptySide(): CommissionSide {
  return { riderJobs: 0, orderJobs: 0, riderFils: 0, orderFils: 0, refundedFils: 0, transferredFils: 0, totalFils: 0 };
}

function isWithdrawal(entry: StatementEntry): boolean {
  return entry.type === "ADJUSTMENT" && entry.reference === null && entry.description === "خصم رصيد";
}

function isBonus(entry: StatementEntry): boolean {
  return entry.type === "CREDIT" && (entry.idempotencyKey?.startsWith("activation-bonus:") ?? false);
}

/**
 * Builds one captain's statement from their ledger entries inside the period, in time order, and the balance they
 * had when the period started.
 */
export function buildStatement(entries: StatementEntry[], openingBalanceFils: number): CaptainStatement {
  const statement: CaptainStatement = {
    openingBalanceFils,
    closingBalanceFils: entries.length ? entries[entries.length - 1]!.balanceAfterFils : openingBalanceFils,
    produced: emptySide(),
    consumed: emptySide(),
    topUpsFils: 0,
    bonusesFils: 0,
    withdrawalsFils: 0,
    groupFloorsFils: 0,
    spentFils: 0
  };

  const byJob = new Map<string, StatementEntry[]>();
  for (const entry of entries) {
    if (isBonus(entry)) statement.bonusesFils += entry.amountFils;
    else if (entry.type === "CREDIT") statement.topUpsFils += entry.amountFils;
    // Older withdrawals were stored with a positive amount, so the size is what counts.
    else if (isWithdrawal(entry)) statement.withdrawalsFils += Math.abs(entry.amountFils);
    else if (entry.type === "GROUP_FLOOR") statement.groupFloorsFils += Math.abs(entry.amountFils);
    else if (entry.reference?.startsWith("commission-transfer:")) {
      if (entry.amountFils < 0) statement.consumed.transferredFils += -entry.amountFils;
      else statement.produced.transferredFils += entry.amountFils;
    } else if (entry.reference) {
      const jobEntries = byJob.get(entry.reference) ?? [];
      jobEntries.push(entry);
      byJob.set(entry.reference, jobEntries);
    }
  }

  for (const jobEntries of byJob.values()) {
    const sum = (match: (entry: StatementEntry) => boolean) =>
      jobEntries.filter(match).reduce((total, entry) => total + Math.abs(entry.amountFils), 0);
    // Taker side: debits by component, refunded as one total adjustment. Owner side: credits, reversed per component.
    addJob(
      statement.consumed,
      sum((entry) => entry.type === "RIDER_COMMISSION" && entry.amountFils < 0),
      sum((entry) => entry.type === "ORDER_COMMISSION" && entry.amountFils < 0),
      sum((entry) => entry.type === "ADJUSTMENT" && entry.amountFils > 0)
    );
    addJob(
      statement.produced,
      sum((entry) => entry.type === "RIDER_COMMISSION" && entry.amountFils > 0),
      sum((entry) => entry.type === "ORDER_COMMISSION" && entry.amountFils > 0),
      sum((entry) => entry.type === "ADJUSTMENT" && entry.amountFils < 0)
    );
  }

  for (const side of [statement.produced, statement.consumed]) {
    side.totalFils = side.riderFils + side.orderFils + side.transferredFils - side.refundedFils;
  }
  statement.spentFils = statement.consumed.totalFils + statement.groupFloorsFils;
  return statement;
}

/** Adds one job to a side, netting a refund in the same period against that job's charge. */
function addJob(side: CommissionSide, riderFils: number, orderFils: number, reversedFils: number): void {
  const chargedFils = riderFils + orderFils;
  if (!chargedFils) {
    side.refundedFils += reversedFils;
    return;
  }
  const keptShare = Math.max(0, chargedFils - reversedFils) / chargedFils;
  const keptRider = Math.round(riderFils * keptShare);
  const keptOrder = Math.round(orderFils * keptShare);
  side.riderFils += keptRider;
  side.orderFils += keptOrder;
  if (keptRider > 0) side.riderJobs += 1;
  if (keptOrder > 0) side.orderJobs += 1;
}

export type StatementTotals = {
  topUpsFils: number;
  bonusesFils: number;
  withdrawalsFils: number;
  groupFloorsFils: number;
  producedFils: number;
  consumedFils: number;
  balanceFils: number;
  /** Top-ups and group floors are income; withdrawals are paid out to producers. */
  netProfitFils: number;
};

export function sumStatements(statements: Array<{ statement: CaptainStatement; balanceFils: number }>): StatementTotals {
  const totals = statements.reduce((sum, { statement, balanceFils }) => ({
    topUpsFils: sum.topUpsFils + statement.topUpsFils,
    bonusesFils: sum.bonusesFils + statement.bonusesFils,
    withdrawalsFils: sum.withdrawalsFils + statement.withdrawalsFils,
    groupFloorsFils: sum.groupFloorsFils + statement.groupFloorsFils,
    producedFils: sum.producedFils + statement.produced.totalFils,
    consumedFils: sum.consumedFils + statement.consumed.totalFils,
    balanceFils: sum.balanceFils + balanceFils,
    netProfitFils: 0
  }), {
    topUpsFils: 0, bonusesFils: 0, withdrawalsFils: 0, groupFloorsFils: 0,
    producedFils: 0, consumedFils: 0, balanceFils: 0, netProfitFils: 0
  });
  totals.netProfitFils = totals.topUpsFils + totals.groupFloorsFils - totals.withdrawalsFils;
  return totals;
}

/** Turns YYYY-MM-DD dates into the Amman-time period [from 00:00, day after `to` 00:00). */
export function statementPeriod(from: string, to: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const start = new Date(`${from}T00:00:00+03:00`);
  const end = new Date(`${to}T00:00:00+03:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}
