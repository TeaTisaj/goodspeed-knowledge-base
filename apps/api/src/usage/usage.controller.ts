import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SupabaseAuthGuard, type AuthenticatedUser } from '../common/auth.guard.js';
import { CurrentUser } from '../common/current-user.decorator.js';
import type { UsageSummary } from '@kb/contracts';
import { UsageService } from './usage.service.js';

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

@Controller('usage')
@UseGuards(SupabaseAuthGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: querySchema }) query: { days: number },
  ): Promise<UsageSummary> {
    const [rows, quality] = await Promise.all([
      this.usage.summary(user.accessToken, query.days),
      this.usage.quality(user.accessToken, query.days),
    ]);
    return {
      rows,
      quality,
      // The UI uses this to say "no published price" rather than showing $0.00,
      // which would read as "this was free".
      pricedModels: this.usage.pricedModels,
      days: query.days,
    };
  }
}
