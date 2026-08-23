import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

// Service-role client — bypasses RLS. Runs on the VPS only, never in a browser.
// Same Supabase project as the Next app: they share one database, which is how
// the front and the worker talk to each other (no HTTP between them).
export function createAdminClient(): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
