import { Global, Module } from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/auth.guard.js';
import { SupabaseService } from './supabase.service.js';

@Global()
@Module({
  providers: [SupabaseService, SupabaseAuthGuard],
  exports: [SupabaseService, SupabaseAuthGuard],
})
export class SupabaseModule {}
