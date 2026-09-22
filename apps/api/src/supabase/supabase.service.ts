import { Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '../config/config.service.js';

/**
 * Two database access paths, deliberately separated.
 *
 * `forUser(token)` carries the caller's JWT, so every query runs through
 * PostgREST as that user and Postgres applies RLS. This is the permission
 * boundary — not `where owner_id = ?` in application code, which is one
 * forgotten clause away from a cross-user leak.
 *
 * `admin()` uses the service-role key and bypasses RLS entirely. It exists for
 * the ingestion worker, which must write chunks on a user's behalf outside any
 * request. Every use of it is a place where isolation depends on code rather
 * than the database, so uses are few and deliberate.
 */
@Injectable()
export class SupabaseService {
  private readonly adminClient: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    this.adminClient = createClient(
      this.config.env.SUPABASE_URL,
      this.config.env.SUPABASE_SECRET_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  /** RLS-enforced client for the current request. */
  forUser(accessToken: string): SupabaseClient {
    return createClient(this.config.env.SUPABASE_URL, this.config.env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  /** Bypasses RLS. Worker use only. */
  admin(): SupabaseClient {
    return this.adminClient;
  }
}
