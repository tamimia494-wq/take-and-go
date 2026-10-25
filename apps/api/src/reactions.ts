export function isCancellationReaction(value: string | undefined): boolean {
  const normalized = value?.replace(/\uFE0F/g, "").trim().toLocaleLowerCase();
  return normalized === "❌" || normalized === "✖" || normalized === "✕" ||
    normalized === "❎" || normalized === "x";
}
