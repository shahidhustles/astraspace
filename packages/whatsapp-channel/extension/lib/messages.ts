import {
  getContentType,
  normalizeMessageContent,
  type WAMessageContent,
} from "@whiskeysockets/baileys";

export function readTextMessage(message: WAMessageContent | null | undefined): string | null {
  const content = normalizeMessageContent(message);
  const type = getContentType(content ?? undefined);

  if (type === "conversation") return content?.conversation?.trim() || null;
  if (type === "extendedTextMessage") {
    return content?.extendedTextMessage?.text?.trim() || null;
  }

  return null;
}
