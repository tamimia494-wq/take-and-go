// A group message that mentions or tags someone is never deleted by the system, for any reason.

/** True when WhatsApp lists mentioned people on the message, or the text tags someone as @ followed by a number. */
export function hasMention(text: string | null | undefined, mentionedJids: ReadonlyArray<string | null | undefined> | null | undefined): boolean {
  if (mentionedJids?.some((jid) => Boolean(jid))) return true;
  return /@[\d٠-٩۰-۹]{5,}/.test(text ?? "");
}
