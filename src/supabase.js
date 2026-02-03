/**
 * Cliente Supabase (Especificação flunx-channels-api § 7).
 * - supabaseAdmin: Service Role (bypass RLS)
 * - createUserClient(accessToken): mesmo projeto com header Authorization (respeita RLS quando aplicável)
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY || serviceKey;

if (!url || !serviceKey) {
  console.warn(
    "[supabase] SUPABASE_URL or SUPABASE_SERVICE_KEY/SUPABASE_SERVICE_ROLE_KEY missing; channel persistence will fail."
  );
}

/** Cliente com Service Role (bypass RLS). */
export const supabaseAdmin =
  url && serviceKey ? createClient(url, serviceKey) : null;

/**
 * Cliente com token do usuário (respeita RLS).
 * Usa anon key + Authorization para que auth.uid() e RLS funcionem.
 * @param {string} accessToken - JWT do Supabase Auth
 */
export function createUserClient(accessToken) {
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

/**
 * Retorna cliente: com JWT do usuário se fornecido, senão admin.
 * Compatibilidade com código que usa getSupabaseClient(token).
 */
export function getSupabaseClient(userJwt) {
  if (!url) return null;
  if (userJwt) {
    return createUserClient(userJwt);
  }
  return supabaseAdmin;
}
