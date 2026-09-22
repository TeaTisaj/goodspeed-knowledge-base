import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
})
export class AppModule {}
