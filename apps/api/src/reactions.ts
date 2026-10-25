/** 👍 in any skin tone. */
export function isLikeReaction(value: string | undefined): boolean {
  const normalized = value?.replace(/\uFE0F/g, "").trim() ?? "";
  return /^\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?$/u.test(normalized);
}

export function isCancellationReaction(value: string | undefined): boolean {
  const normalized = value?.replace(/\uFE0F/g, "").trim().toLocaleLowerCase();
  return normalized === "❌" || normalized === "✖" || normalized === "✕" ||
    normalized === "❎" || normalized === "x";
}
