import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import {
  HealthCheck,
  HealthCheckService,
  type HealthIndicatorFunction,
} from '@nestjs/terminus';
import { Public } from '../common/decorators/auth.decorators.js';
import { HealthIndicators } from './health.indicators.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicators,
  ) {}

  @Get()
  @Public()
  @SkipThrottle()
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness: database, authenticated Redis, object storage',
  })
  check() {
    const checks: HealthIndicatorFunction[] = [
      () => this.indicators.database(),
      () => this.indicators.redisPing(),
      () => this.indicators.objectStorage(),
    ];
    return this.health.check(checks);
  }

  @Get('live')
  @Public()
  @SkipThrottle()
  @ApiOperation({
    summary: 'Liveness: the process is up (no dependency checks)',
  })
  live() {
    return { status: 'ok' };
  }
}
