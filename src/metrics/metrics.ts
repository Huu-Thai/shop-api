import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  register,
} from 'prom-client';

/**
 * Prometheus metrics (PLAN.md §11), on prom-client's default registry. Names follow Prometheus
 * conventions (`shop_` prefix, `_total` counters, `_seconds` durations); every series carries the
 * process role. Counters are per process — dashboards `sum()` them across replicas.
 */
let initialised = false;
export function initMetrics(role: 'api' | 'worker'): void {
  if (initialised) return;
  initialised = true;
  register.setDefaultLabels({ role });
  collectDefaultMetrics({ prefix: 'shop_' });
}

export const httpRequestDuration = new Histogram({
  name: 'shop_http_request_duration_seconds',
  help: 'HTTP request duration by route template, method and status',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const queueJobDuration = new Histogram({
  name: 'shop_queue_job_duration_seconds',
  help: 'Background job duration by queue, job name and outcome',
  labelNames: ['queue', 'name', 'outcome'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300, 1800],
});

export const ordersPlaced = new Counter({
  name: 'shop_orders_placed_total',
  help: 'Orders placed',
  labelNames: ['currency'] as const,
});

export const orderValue = new Counter({
  name: 'shop_orders_value_minor_total',
  help: 'Grand total of placed orders, in minor units of their currency',
  labelNames: ['currency'] as const,
});

export const orderOutcomes = new Counter({
  name: 'shop_order_events_total',
  help: 'Order lifecycle events (paid, canceled, shipped, refunded, completed)',
  labelNames: ['event'] as const,
});

export const payments = new Counter({
  name: 'shop_payments_total',
  help: 'Payment outcomes by provider (captured, failed, canceled, refunded, refund-failed)',
  labelNames: ['provider', 'outcome'] as const,
});

export const paymentWebhooks = new Counter({
  name: 'shop_payment_webhooks_total',
  help: 'Payment provider notifications by result (ok, duplicate, invalid-signature, …)',
  labelNames: ['result'] as const,
});

export const authFailures = new Counter({
  name: 'shop_auth_failures_total',
  help: 'Failed sign-ins (admin, customer)',
  labelNames: ['realm'] as const,
});

export const jobExecutions = new Counter({
  name: 'shop_job_executions_total',
  help: 'Finished job executions by type and status',
  labelNames: ['type', 'status'] as const,
});

export const webhookDeliveries = new Counter({
  name: 'shop_webhook_deliveries_total',
  help: 'Outgoing webhook delivery attempts by outcome (succeeded, retry, failed)',
  labelNames: ['outcome'] as const,
});

export const outboxFailures = new Counter({
  name: 'shop_outbox_delivery_failures_total',
  help: 'After-event deliveries that failed (redelivered later, or parked as dead letters)',
  labelNames: ['dead'] as const,
});

/** Times a background job body (all processors run through withJobContext). */
export async function timeJob<T>(
  queue: string,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const end = queueJobDuration.startTimer({ queue, name });
  try {
    const r = await fn();
    end({ outcome: 'completed' });
    return r;
  } catch (e) {
    end({ outcome: 'failed' });
    throw e;
  }
}
