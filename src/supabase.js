import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY || serviceKey;

if (!url || !serviceKey) {
  console.warn("[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing; channel persistence will fail.");
}

/**
 * Retorna cliente Supabase:
 * - Com JWT do usuário: usa anon key + Authorization (RLS aplica por organização).
 * - Sem JWT: usa service role (útil para server-to-server; validar org por outros meios).
 */
export function getSupabaseClient(userJwt) {
  if (!url) return null;
  if (userJwt) {
    return createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${userJwt}` } },
    });
  }
  return createClient(url, serviceKey);
}
