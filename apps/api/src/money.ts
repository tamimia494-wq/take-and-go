export function toFils(value: string | number): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 2_147_483.647 ||
      Math.round(amount * 1000) !== amount * 1000) {
    throw new Error("المبلغ يجب أن يكون رقماً غير سالب وبحد أقصى ثلاث منازل عشرية وضمن حد النظام.");
  }
  return Math.round(amount * 1000);
}

export function fromFils(fils: number): number {
  return fils / 1000;
}

/**
 * 0.5 JOD every captain keeps and can never spend, so the weekly group floor can always be taken. A captain can
 * take an order only if their balance after its commission is still at least this much, and can withdraw only
 * what is above it. Posting orders (producing) still works with just this reserve.
 */
export const CAPTAIN_RESERVED_BALANCE_FILS = 500;

/** The balance a captain needs to take an order with this commission: the commission plus the reserve. */
export function requiredCaptainReplyBalanceFils(commissionFils: number): number {
  return CAPTAIN_RESERVED_BALANCE_FILS + Math.max(1, commissionFils);
}

export function hasSufficientCaptainReplyBalance(balanceFils: number, commissionFils: number): boolean {
  return balanceFils >= requiredCaptainReplyBalanceFils(commissionFils);
}

export function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndex = "٠١٢٣٤٥٦٧٨٩".indexOf(digit);
    const persianIndex = "۰۱۲۳۴۵۶۷۸۹".indexOf(digit);
    return String(arabicIndex >= 0 ? arabicIndex : persianIndex);
  });
}

export function normalizePhone(value: string): string {
  let digits = normalizeDigits(value).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `962${digits.slice(1)}`;
  if (digits.startsWith("7")) digits = `962${digits}`;
  if (!/^9627\d{8}$/.test(digits)) {
    throw new Error("رقم الهاتف الأردني غير صالح.");
  }
  return digits;
}

export function phoneFromChatId(value: string): string | null {
  const raw = value.split("@")[0]?.split(":")[0] ?? "";
  try {
    return normalizePhone(raw);
  } catch {
    return null;
  }
}
