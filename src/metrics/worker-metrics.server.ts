import { createServer, type Server } from 'node:http';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { register } from 'prom-client';
import type { AppConfig } from '../config/configuration.js';
import { metricsAuthorized } from './metrics-auth.js';

/**
 * The worker has no HTTP API: it serves `/metrics` (Bearer METRICS_TOKEN) and `/health` (liveness)
 * on WORKER_METRICS_PORT (0 = off).
 */
@Injectable()
export class WorkerMetricsServer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerMetricsServer.name);
  private server?: Server;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  onApplicationBootstrap(): Promise<void> {
    const { workerPort, token } = this.config.get('metrics', { infer: true });
    if (
      this.config.get('processRole', { infer: true }) !== 'worker' ||
      !workerPort
    )
      return Promise.resolve();
    this.server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      if (req.method !== 'GET' || path !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      if (!metricsAuthorized(token, req.headers.authorization)) {
        res.writeHead(401).end();
        return;
      }
      register
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': register.contentType });
          res.end(body);
        })
        .catch(() => res.writeHead(500).end());
    });
    return new Promise((resolve) =>
      this.server!.listen(workerPort, () => {
        this.logger.log(`Worker metrics on :${workerPort}/metrics`);
        resolve();
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
  }
}
