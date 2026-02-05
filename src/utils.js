/**
 * Funções utilitárias (Especificação flunx-channels-api § estrutura).
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Gera ID aleatório curto (ex.: para instanceName). */
export function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

/** Valida se o valor é um UUID v4. */
export function isValidUUID(value) {
  return typeof value === "string" && UUID_REGEX.test(value);
}

/** Gera slug seguro a partir de texto (para nomes de instância). */
export function slugify(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "channel";
}

/**
 * Extrai conteúdo da mensagem Evolution para exibição (texto ou placeholder [Imagem], [Áudio], etc.).
 * Usado no sync (index.js) e será reutilizado em flunx-rabbitmq-api.
 */
export function extractMessageContent(msg) {
  const message = msg?.message ?? msg;
  if (!message) return null;
  if (typeof message === "string") return message;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return `[Imagem] ${message.imageMessage.caption}`;
  if (message.imageMessage) return "[Imagem]";
  if (message.videoMessage?.caption) return `[Vídeo] ${message.videoMessage.caption}`;
  if (message.videoMessage) return "[Vídeo]";
  if (message.audioMessage) return "[Áudio]";
  if (message.documentMessage)
    return `[Documento] ${message.documentMessage.fileName || ""}`;
  if (message.stickerMessage) return "[Sticker]";
  if (message.contactMessage)
    return `[Contato] ${message.contactMessage.displayName || ""}`;
  if (message.locationMessage) return "[Localização]";
  return null;
}
