import { Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '../config/config.service.js';

/** Roughly one per concurrently-active user; well under any real memory cost. */
const MAX_CACHED_USER_CLIENTS = 500;

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
  private readonly userClients = new Map<string, SupabaseClient>();

  constructor(private readonly config: ConfigService) {
    this.adminClient = createClient(
      this.config.env.SUPABASE_URL,
      this.config.env.SUPABASE_SECRET_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  /**
   * RLS-enforced client for the current request.
   *
   * Cached per access token. `createClient` is not free -- it builds postgrest,
   * auth, realtime and storage sub-clients -- and a single chat turn calls this
   * six times while answering one question. The cache is keyed by the token, so
   * two users can never share a client, and entries expire with the token.
   *
   * A bounded LRU rather than a plain map: tokens rotate, and an unbounded
   * cache keyed by them is a slow memory leak.
   */
  forUser(accessToken: string): SupabaseClient {
    const cached = this.userClients.get(accessToken);
    if (cached) {
      // Refresh recency: re-inserting moves the key to the end of the Map's
      // insertion order, which is what makes the eviction below LRU.
      this.userClients.delete(accessToken);
      this.userClients.set(accessToken, cached);
      return cached;
    }

    const client = createClient(
      this.config.env.SUPABASE_URL,
      this.config.env.SUPABASE_PUBLISHABLE_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      },
    );

    this.userClients.set(accessToken, client);
    if (this.userClients.size > MAX_CACHED_USER_CLIENTS) {
      const oldest = this.userClients.keys().next().value;
      if (oldest !== undefined) this.userClients.delete(oldest);
    }
    return client;
  }

  /** Bypasses RLS. Worker use only. */
  admin(): SupabaseClient {
    return this.adminClient;
  }
}
