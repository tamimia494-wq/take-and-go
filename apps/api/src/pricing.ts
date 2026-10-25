import { normalizeDigits } from "./money";

export function extractPriceAfterLabel(line: string): number | null {
  const normalized = normalizeDigits(line);
  const match = /(?:^|[\s:：])(?:السعر|سعر|(?:ال)?(?:أجرة|اجرة|اجاره|أجره|اجره)|(?:ال)?توصيل|حسابه)\s*[:：-]?\s*(\d+)/u.exec(normalized);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 2_147_483_647
    ? amount
    : null;
}

export function calculateCommissionFils(pricesDinars: number[], commissionPerFiveFils: number): number {
  if (!Number.isSafeInteger(commissionPerFiveFils) || commissionPerFiveFils < 0) {
    throw new Error("The per-five commission must be a non-negative integer.");
  }
  return pricesDinars.reduce((total, priceDinars) => {
    if (!Number.isSafeInteger(priceDinars) || priceDinars <= 0) {
      throw new Error("Prices must be positive whole dinars.");
    }
    return total + Math.round(priceDinars / 5) * commissionPerFiveFils;
  }, 0);
}
