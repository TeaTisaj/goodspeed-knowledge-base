import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Rate limits per authenticated user rather than per IP.
 *
 * The default tracker keys on IP, which is wrong for this app in both
 * directions: an office or mobile carrier behind one NAT would share a single
 * bucket, while one user on several devices would get several buckets.
 * Falls back to IP for unauthenticated routes.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Request): Promise<string> {
    return req.user?.id ?? req.ip ?? 'anonymous';
  }
}
