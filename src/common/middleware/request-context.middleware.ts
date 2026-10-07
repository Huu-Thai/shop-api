import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  type LoggerService,
  NestMiddleware,
} from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../../logger/request-context.js';
import { httpRequestDuration } from '../../metrics/metrics.js';
import { REQUEST_ID_HEADER } from '../constants/api.constants.js';

const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

/** The route template a request matched, or `unmatched` (404s, wildcard middleware routes). */
export function routeLabel(req: Request): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' && !path.includes('*') ? path : 'unmatched';
}

/**
 * Establishes the per-request logging context (x-request-id, propagated or generated)
 * and writes one access-log line per request once the response finishes.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: LoggerService,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId =
      incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const started = process.hrtime.bigint();

    requestContext.run({ requestId, ip: req.ip }, () => {
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        httpRequestDuration.observe(
          {
            method: req.method,
            // The matched route template. Unmatched paths only carry this middleware's own `*path`
            // route: they share one label, so scanners can't blow up the series count.
            route: routeLabel(req),
            status: String(res.statusCode),
          },
          durationMs / 1000,
        );
        const entry = {
          message: `${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode}`,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
          requestId,
          context: 'HTTP',
        };
        if (res.statusCode >= 500) this.logger.error?.(entry);
        else if (res.statusCode >= 400) this.logger.warn?.(entry);
        else this.logger.log(entry);
      });
      next();
    });
  }
}
