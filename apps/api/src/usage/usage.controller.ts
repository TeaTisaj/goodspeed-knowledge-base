import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SupabaseAuthGuard, type AuthenticatedUser } from '../common/auth.guard.js';
import { CurrentUser } from '../common/current-user.decorator.js';
import { UsageService, type UsageSummaryRow } from './usage.service.js';

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
  ): Promise<{ rows: UsageSummaryRow[]; pricedModels: string[]; days: number }> {
    return {
      rows: await this.usage.summary(user.accessToken, query.days),
      // The UI uses this to say "no published price" rather than showing $0.00,
      // which would read as "this was free".
      pricedModels: this.usage.pricedModels,
      days: query.days,
    };
  }
}
