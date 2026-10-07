import {
  Controller,
  Get,
  Headers,
  Header,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { register } from 'prom-client';
import { Public } from '../common/decorators/auth.decorators.js';
import type { AppConfig } from '../config/configuration.js';
import { metricsAuthorized } from './metrics-auth.js';

/** Prometheus scrape endpoint of the API (`/api/v1/metrics`, Bearer METRICS_TOKEN). */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  @Get()
  @Public()
  @SkipThrottle()
  @Header('content-type', register.contentType)
  @Header('cache-control', 'no-store')
  async metrics(@Headers('authorization') authorization?: string) {
    if (
      !metricsAuthorized(
        this.config.get('metrics', { infer: true }).token,
        authorization,
      )
    )
      throw new UnauthorizedException('A valid metrics token is required');
    return register.metrics();
  }
}
