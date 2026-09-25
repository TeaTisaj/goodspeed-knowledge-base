import { Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '../config/config.service.js';

/** Roughly one per concurrently-active user; well under any real memory cost. */
const MAX_CACHED_USER_CLIENTS = 500;

/**
 * Two access paths. `forUser(token)` runs as the caller, so Postgres RLS is the
 * permission boundary. `admin()` bypasses RLS and is for the ingestion worker only.
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

  /** RLS-enforced client, cached per token in a bounded LRU (a chat turn uses it several times). */
  forUser(accessToken: string): SupabaseClient {
    const cached = this.userClients.get(accessToken);
    if (cached) {
      // Re-inserting moves the key to the end of the Map, which makes eviction LRU.
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
