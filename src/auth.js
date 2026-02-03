/**
 * Autenticação (Especificação flunx-channels-api § 5).
 * Middleware JWT (Bearer) e validação de acesso à organização.
 */

import { supabaseAdmin } from "./supabase.js";

/**
 * Middleware: valida JWT no header Authorization e anexa req.user e req.accessToken.
 * Retorna 401 se token ausente ou inválido.
 */
export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token não fornecido" });
  }

  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    return res.status(401).json({ error: "Token não fornecido" });
  }

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Token inválido" });
    }

    req.user = user;
    req.accessToken = token;
    next();
  } catch (err) {
    console.error("[Auth] Erro:", err);
    return res.status(401).json({ error: "Erro de autenticação" });
  }
}

/**
 * Verifica se o usuário pertence à organização (tabela organization_members).
 * @param {string} userId - UUID do usuário
 * @param {string} organizationId - UUID da organização
 * @returns {Promise<boolean>}
 */
export async function validateOrganizationAccess(userId, organizationId) {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin
    .from("organization_members")
    .select("id")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  return !error && !!data;
}
