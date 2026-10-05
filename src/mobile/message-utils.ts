export function unwrapMessageContent(message: any): any {
  let current = message;
  let depth = 0;

  while (current && depth < 8) {
    const nested =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.editedMessage?.message ||
      current.documentWithCaptionMessage?.message;

    if (!nested) break;
    current = nested;
    depth++;
  }

  return current || message;
}

export function extractMessageText(message: any): string {
  const content = unwrapMessageContent(message);

  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    ''
  );
}
