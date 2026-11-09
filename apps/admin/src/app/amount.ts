/** Keeps only a typed amount: Arabic digits become Latin, the Arabic decimal mark becomes a dot. */
export function amountInput(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[٫,]/g, ".")
    .replace(/[^\d.]/g, "")
    .replace(/(\..*)\./g, "$1");
}

/** Shows an empty box instead of 0 so the admin types the value directly; text being typed is kept as is. */
export function blankZero(value: number | string): string {
  if (typeof value === "string") return value;
  return value === 0 ? "" : String(value);
}
