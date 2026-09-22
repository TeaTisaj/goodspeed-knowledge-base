import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service.js';

@Global()
@Module({
  providers: [{ provide: ConfigService, useFactory: () => new ConfigService(process.env) }],
  exports: [ConfigService],
})
export class ConfigModule {}
