import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

for (const candidate of ['.env', '../../.env']) {
  const path = resolve(process.cwd(), candidate);
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

export const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
export const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
export const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? '';

/** Service-role client. Bypasses RLS — used only to set up fixtures. */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A client authenticated as a real user, carrying that user's access token.
 * This is the shape the API uses in production, and the only way an RLS test
 * proves anything: an admin client would bypass the policies under test.
 */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

export async function createTestUser(label: string): Promise<TestUser> {
  const admin = adminClient();
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = 'test-password-12345';

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);

  const anon = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`signIn failed: ${signIn.error?.message}`);
  }

  return { id: data.user.id, email, accessToken: signIn.data.session.access_token };
}

export async function deleteTestUser(id: string): Promise<void> {
  await adminClient().auth.admin.deleteUser(id);
}

/** Deterministic unit vector, so fixtures need no embedding provider. */
export function fakeEmbedding(seed: number, dims = 1536): number[] {
  const v = new Array<number>(dims);
  let x = seed * 9301 + 49297;
  for (let i = 0; i < dims; i++) {
    x = (x * 9301 + 49297) % 233280;
    v[i] = x / 233280 - 0.5;
  }
  const norm = Math.sqrt(v.reduce((s, n) => s + n * n, 0));
  return v.map((n) => n / norm);
}
