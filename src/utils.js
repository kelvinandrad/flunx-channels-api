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
